"""CallSession: 통화 1건의 경량 상태 객체(concurrency.md §2). Actor·처리 큐 없음.
상태 변경은 lock 안의 짧은 동기 구간에서만, 외부 I/O는 잠금 밖에서(concurrency.md §3)."""

import asyncio
import logging
import time
from collections import Counter
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from app.domain.assess import assess
from app.domain.state import ConversationState, FieldStatus
from app.tools.context import ToolContext
from pbx_webhook import mask_phone

log = logging.getLogger(__name__)


class Phase(StrEnum):
    RECEIVED = "received"
    ACCEPTING = "accepting"
    ATTACHING = "attaching"
    ACTIVE = "active"
    CLOSING = "closing"
    CLOSED = "closed"
    FAILED = "failed"
    FINALIZING = "finalizing"
    DONE = "done"


ENDED = (Phase.CLOSING, Phase.CLOSED, Phase.FAILED, Phase.FINALIZING, Phase.DONE)


@dataclass
class CallSession:
    call_id: str                      # = OpenAI session_id (BE providerCallId)
    trace_id: str
    caller: str | None                # SIP From 정규화(미신뢰)
    incoming_at: str                  # 수신 이벤트 created_at ISO(재계산 금지)
    tools: ToolContext                # state·lock·ops·게이트웨이 등(도구와 공유)
    phase: Phase = Phase.RECEIVED
    hangup_after_accept: bool = False # accept 중 PBX 종료가 오면 accept 직후 끊는다
    closed: bool = False              # True 이후 상태 반영·외부 부작용 금지(결과 전송 제외)
    close_reason: str | None = None
    expires_at: float | None = None
    persona_version_seq: int | None = None   # None = 서버 기본 프롬프트로 대체(P2, 분석 aiPersonaVersionSeq)
    sideband: Any = None
    tasks: set[asyncio.Task] = field(default_factory=set)
    timers: dict[str, asyncio.TimerHandle] = field(default_factory=dict)
    started_t: float = field(default_factory=time.time)
    last_input_t: float = 0.0
    last_output_t: float = 0.0
    events: list[dict] = field(default_factory=list)   # 관제용 사건(개인정보 값 없음)
    send_seq: int = 0
    rt: Any = None                    # S5 통화 중 흐름 상태(app/calls/live.py Runtime)
    transcript: list[dict] = field(default_factory=list)  # 관제·통화 기록(개인정보: 관제는 인증, 기록은 logs/)
    closing_requested_t: float = 0.0
    tool_calls: list[dict] = field(default_factory=list)   # 관제: 도구 이름·인수·결과·시간
    result: dict | None = None                             # 통화 결과 응답 data(S6)
    decision_ms: list[int] = field(default_factory=list)   # 발화 끝 Decision 응답 시간(예산 안에 온 것, P50·P95용)
    timings: dict[str, list[int]] = field(default_factory=dict)  # 관제 지연(ms): 구간 이름 → 측정값
    active_t: float = 0.0                                  # 세션 활성(session.started) 시각 — 첫 AI 발화까지 재기용
    backend_calls: list[dict] = field(default_factory=list)      # 관제 BE 통신: op·결과·HTTP·오류·ms·시각
    stats: Counter = field(default_factory=Counter)       # 관제: Decision·위임·도구·전달 횟수
    on_change: "Callable[[CallSession], None] | None" = None
    _dirty: bool = False

    @property
    def state(self) -> ConversationState:
        return self.tools.state

    @property
    def lock(self) -> asyncio.Lock:
        return self.tools.lock

    def spawn(self, coro: Coroutine, name: str = "") -> asyncio.Task | None:
        """통화에 딸린 짧은 작업. 정리 때 일괄 취소한다. 닫힌 통화에는 새 작업을 만들지 않는다."""
        if self.closed:
            coro.close()
            return None
        task = asyncio.create_task(coro, name=f"{self.call_id[-8:]}:{name}")
        self.tasks.add(task)
        task.add_done_callback(self._done)
        return task

    def _done(self, task: asyncio.Task) -> None:
        self.tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("통화 작업 실패 %s %s", task.get_name(), type(task.exception()).__name__,
                      exc_info=task.exception())

    def set_timer(self, name: str, delay: float, fn) -> None:
        self.cancel_timer(name)
        if not self.closed:
            self.timers[name] = asyncio.get_running_loop().call_later(max(0.0, delay), fn)

    def cancel_timer(self, name: str) -> None:
        if (t := self.timers.pop(name, None)) is not None:
            t.cancel()

    def note(self, kind: str, text: str = "") -> None:
        self.events.append({"at": time.time(), "kind": kind, "text": text})
        del self.events[:-200]
        self.changed()

    def changed(self) -> None:
        """관제 알림을 모아서 보낸다(전사 delta마다 전체 스냅샷을 보내지 않게 0.15초 단위)."""
        if self.on_change is None or self._dirty:
            return
        self._dirty = True
        try:
            asyncio.get_running_loop().call_later(0.15, self._flush)
        except RuntimeError:
            self._dirty = False

    def _flush(self) -> None:
        self._dirty = False
        self.publish()

    def publish(self) -> None:
        """관제 알림. 관제 쪽 오류가 통화 처리를 멈추지 않게 여기서 막는다(로그는 통화당 1번)."""
        if self.on_change is None:
            return
        try:
            self.on_change(self)
        except Exception:
            if not self.stats.get("관제 오류"):
                log.exception("관제 스냅샷 실패 %s", self.call_id)
            self.stats["관제 오류"] += 1

    def next_event_id(self) -> str:
        self.send_seq += 1
        return f"{self.trace_id}:{self.send_seq}"   # error.client_event_id 상관(call-lifecycle.md §3)

    def timing(self, name: str, ms: float) -> None:
        xs = self.timings.setdefault(name, [])
        xs.append(round(ms))
        del xs[:-200]

    def record_backend(self, op: str, ms: int, outcome: str, http: int | None, error: str | None) -> None:
        self.backend_calls.append({"at": time.time(), "op": op, "outcome": outcome, "http": http, "error": error, "ms": ms})
        del self.backend_calls[:-200]
        self.timing(f"BE {op}", ms)
        self.changed()

    def snapshot(self) -> dict:
        """관제 화면(monitor) 모양. 관제는 인증 뒤에서만 보이므로(docs/ops/monitor.md) 업무 값·전사를 그대로 보여 준다."""
        s, policy = self.state, self.tools.policy
        a = assess(s, policy)
        label = lambda n: policy.fields[n].label if n in policy.fields else n  # noqa: E731
        current = {}
        if s.current is not None:  # 값은 문자열로(숫자·물품 객체 + 문자열은 TypeError — S5 실통화 관제 중단 버그)
            current = {label(n): (str(_show(f.value)) if f.valid else f.status.value) + (f" · {f.code}" if f.code else "")
                       for n, f in s.current.fields.items() if f.status != FieldStatus.EMPTY}
        parcels = [{"id": p.parcel_id, "받는 분": p.draft["receiver_name"].value, "물품": _show(p.draft["items"].value),
                    "가액": p.draft["item_price"].value, "확인": "확인됨" if p.confirmed_hash else "확인 전"}
                   for p in s.parcels]
        detail = {"단계": a.stage, "업무": s.intent, "빠진 항목": [label(n) for n in a.missing],
                  "받는 중인 택배": current, "담은 택배": parcels, "수거 일시": s.pickup_at.value,
                  "결제": s.payment.value or a.payment_auto, "더 보낼 택배 없음": s.no_more_parcels,
                  "확인 대기": s.pending.kind if s.pending else None, "후보": list(s.candidates.labels) if s.candidates else None,
                  "고객": {"구분": "등록" if s.customer.customer_seq else "미등록", "성함": s.customer.name,
                         "통화 번호": s.customer.call_session_seq,
                         "등록": (self.tools.ops.get("register") or {}).get("status")},
                  "통화 결과": {k: (self.result or {}).get(k) for k in ("status", "orderSeq", "parcelNo")}
                  if self.result else None,
                  "통계": dict(self.stats) | _latency("Decision", self.decision_ms), "페르소나": self.persona_version_seq or "서버 기본 프롬프트",
                  "trace_id": self.trace_id}
        return {"session_id": self.call_id, "caller": mask_phone(self.caller), "started_at": self.started_t,
                "status": self.phase.value, "stage": a.stage, "end_reason": self.close_reason,
                "transcript": [{"speaker": r["speaker"], "text": r["text"]} for r in self.transcript],
                "tool_calls": self.tool_calls[-50:], "events": self.events[-200:],
                "backend_calls": self.backend_calls[-100:], "latency": _latency_table(self.timings),
                "errors": [{"at": e["at"], "message": e["text"]} for e in self.events if e["kind"] == "오류"],
                "detail": detail}


def _show(v):
    """관제 표시용(물품 등 객체 → 읽을 수 있는 dict)."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if hasattr(v, "__dict__"):
        return {k: x for k, x in v.__dict__.items() if x}
    return str(v)


def _latency(name: str, ms: list[int]) -> dict:
    """P50·P95(최근 통화 하나 기준, nearest-rank)."""
    if not ms:
        return {}
    xs = sorted(ms)
    pick = lambda q: xs[min(len(xs) - 1, max(0, -(-len(xs) * q // 100) - 1))]
    return {f"{name} ms P50": pick(50), f"{name} ms P95": pick(95)}


def _latency_table(timings: dict[str, list[int]]) -> list[dict]:
    """관제 지연 표: 구간별 횟수·최근·P50·P95·최대(ms)."""
    rows = []
    for name, xs in timings.items():
        if not xs:
            continue
        p = _latency(name, xs)
        rows.append({"구간": name, "횟수": len(xs), "최근": xs[-1], "P50": p[f"{name} ms P50"],
                     "P95": p[f"{name} ms P95"], "최대": max(xs)})
    return rows
