"""통화 하나 = 통화 객체 하나. 임시 주문·진행 상태·도구 기록·발신번호를 모두 여기에 둔다(spec/concurrency.md)."""

import asyncio
import logging
import re
import time
from typing import Any

from app.config import ServerConfig, Texts
from app.events import bus
from app.flow import engine
from app.order import ORDER_FIELDS, Order, Place

log = logging.getLogger(__name__)

MAX_CALLER_DIGITS = 15


def caller_from_headers(headers: list[Any]) -> str | None:
    """SIP From 헤더에서 발신번호를 뽑는다. 미신뢰 값: 숫자만, +82 → 0, 길이 제한. 인증 근거로 쓰지 않는다."""
    for h in headers:
        if h.name.lower() in ("from", "f"):
            m = re.search(r"sips?:([^@;>]+)", h.value)
            if not m:
                return None
            user = m.group(1).strip()
            if user.startswith("+82"):
                user = "0" + user[3:]
            digits = re.sub(r"\D", "", user)[:MAX_CALLER_DIGITS]
            return digits or None
    return None


def mask_phone(phone: str | None) -> str:
    if not phone:
        return "알 수 없음"
    return phone[:3] + "*" * max(len(phone) - 7, 0) + phone[-4:] if len(phone) > 7 else "*" * len(phone)


class Call:
    def __init__(self, session_id: str, caller: str | None, cfg: ServerConfig, texts: Texts, db: Any):
        self.session_id = session_id
        self.caller = caller
        self.cfg = cfg
        self.texts = texts
        self.db = db
        self.order = Order()
        self.flow = engine.FlowState(stage="")
        self.customer_type = "new"
        self.recent_receiver: Place | None = None
        self.recent_asked = False
        self.places: list[Place] | None = None  # 저장된 배송지 캐시
        self.save_candidates: list[Place] = []
        self.submitted: list[str] = []
        self.last_order_no: str | None = None
        self.lock = asyncio.Lock()  # 한 통화 안의 도구 호출은 순서대로
        self.hangup_requested = asyncio.Event()
        self.refer_requested = asyncio.Event()
        self.last_output_at = 0.0  # 음성 출력 이벤트를 마지막으로 본 시각(monotonic)
        self.task: asyncio.Task | None = None
        self.last_progress = ""
        # 관제용 기록
        self.status = "accepting"  # accepting · active · ended · failed
        self.started_at = time.time()
        self.ended_at: float | None = None
        self.end_reason: str | None = None
        self.transcript: list[dict] = []
        self.tool_calls: dict[str, dict] = {}
        self.errors: list[dict] = []
        self.usage: dict | None = None

    # --- 시작 ---

    async def prepare(self) -> None:
        """발신번호로 고객 유형·최근 배송을 찾고 시작 단계를 정한다. DB 실패면 신규 고객으로 진행."""
        if self.caller:
            try:
                self.recent_receiver = await self.db.latest_receiver(self.caller)
                if self.recent_receiver or await self.db.list_places(self.caller):
                    self.customer_type = "registered"
            except Exception:
                log.exception("고객 조회 실패 %s", self.session_id)
                self.add_error("고객 조회 실패")
        self.flow.stage = engine.start_stage(self)
        self.notify()

    # --- 상태 엔진이 쓰는 것 ---

    def field_done(self, name: str) -> bool:
        if name == "recent":
            return self.recent_asked or self.recent_receiver is None or self.order.place("receiver") is not None
        return getattr(self.order, name) is not None

    def recorded(self) -> list[tuple[str, str]]:
        labels = self.texts.labels
        return [(labels[f], v) for f in ORDER_FIELDS if (v := getattr(self.order, f)) is not None]

    def text_vars(self) -> dict:
        biz = self.cfg.business
        r = self.recent_receiver
        return {
            "company": biz.company_name,
            "fare": biz.fare,
            "order_no": self.last_order_no or "",
            "goodbye_message": biz.goodbye_message,
            "recent_receiver": f"{r.name}, {r.address}" if r else "",
            "save_candidates": " / ".join(f"{p.name} {p.address}" for p in self.save_candidates),
            "caller": self.caller or "알 수 없음",
            "customer_type": self.texts.customer_types[self.customer_type],
        }

    # --- 도구가 요청하는 통화 조작(실행은 sideband 쪽) ---

    def request_hangup(self) -> None:
        self.hangup_requested.set()

    def request_refer(self) -> None:
        self.refer_requested.set()

    # --- 관제 기록 ---

    def add_transcript(self, speaker: str, delta: str, start_ms: int | None = None, end_ms: int | None = None) -> None:
        """문장 경계·item ID가 없으므로 말하는 쪽의 마지막 말풍선에 이어 붙인다. 겹쳐 말해도 쪼개지지 않게,
        그 말풍선이 맨 끝이거나 직전 조각과의 간격이 짧으면 이어 붙이고, 아니면 새 말풍선(말 차례가 바뀜)."""
        last = next((b for b in reversed(self.transcript) if b["speaker"] == speaker), None)
        gap_ok = start_ms is not None and last is not None and last["end_ms"] is not None             and start_ms - last["end_ms"] <= self.cfg.monitor.bubble_gap_ms
        if last is not None and (last is self.transcript[-1] or gap_ok):
            last["text"] += delta
            last["end_ms"] = end_ms if end_ms is not None else last["end_ms"]
        else:
            self.transcript.append({"speaker": speaker, "text": delta, "at": time.time(), "end_ms": end_ms})
        if speaker == "agent":
            self.last_output_at = time.monotonic()
        self.notify()

    def add_error(self, message: str) -> None:
        self.errors.append({"at": time.time(), "message": message})
        self.notify()

    def end(self, reason: str, status: str = "ended") -> None:
        if self.status in ("ended", "failed"):
            return
        self.status, self.end_reason, self.ended_at = status, reason, time.time()
        self.notify()

    def snapshot(self) -> dict:
        return {
            "session_id": self.session_id,
            "caller": mask_phone(self.caller),
            "customer_type": self.customer_type,
            "status": self.status,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "end_reason": self.end_reason,
            "stage": self.flow.stage,
            "history": self.flow.history,
            "order": self.order.model_dump(),
            "fare": self.cfg.business.fare,
            "next": engine.next_text(self) if self.flow.stage else "",
            "submitted": self.submitted,
            "transcript": self.transcript,
            "tool_calls": list(self.tool_calls.values()),
            "errors": self.errors,
            "usage": self.usage,
        }

    def notify(self) -> None:
        bus.publish({"type": "call", "call": self.snapshot()})


class Registry:
    """session_id → 통화. 이벤트 루프 하나에서만 쓰므로 await 없는 메서드는 경쟁 없이 한 번에 실행된다."""

    def __init__(self, cfg: ServerConfig):
        self.cfg = cfg
        self.calls: dict[str, Call] = {}

    def active_count(self) -> int:
        return sum(c.status in ("accepting", "active") for c in self.calls.values())

    def try_register(self, call: Call) -> str:
        """상한 확인과 등록을 한 번에. 'ok' · 'duplicate' · 'full'."""
        self.purge()
        if call.session_id in self.calls:
            return "duplicate"
        if self.active_count() >= self.cfg.call.max_concurrent:
            return "full"
        self.calls[call.session_id] = call
        return "ok"

    def purge(self) -> None:
        """끝난 통화를 보관 시간·개수를 넘으면 지운다(메모리가 계속 늘지 않게)."""
        mon = self.cfg.monitor
        now = time.time()
        ended = sorted((c for c in self.calls.values() if c.ended_at), key=lambda c: c.ended_at)
        excess = len(ended) - mon.call_history_keep
        for i, c in enumerate(ended):
            if i < excess or now - c.ended_at > mon.retain_ended_sec:
                del self.calls[c.session_id]

    def get(self, session_id: str) -> Call | None:
        return self.calls.get(session_id)

    def list(self) -> list[Call]:
        self.purge()
        return sorted(self.calls.values(), key=lambda c: c.started_at, reverse=True)
