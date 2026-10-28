"""통화 하나 = 통화 객체 하나. 임시 주문·진행 상태·도구 기록·발신번호를 모두 여기에 둔다(spec/concurrency.md)."""

import asyncio
import logging
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from app.backend_api import BackendError, result_body
from app.config import ServerConfig, Texts
from app.events import bus
from app.flow import engine
from app.order import COUNT_FIELDS, ORDER_FIELDS, PHONE_FIELDS, Order, Place

log = logging.getLogger(__name__)

MAX_CALLER_DIGITS = 15


def caller_from_headers(headers: list[Any]) -> str | None:
    """SIP From 헤더에서 발신번호를 뽑는다. 미신뢰 값: 숫자만, +82 → 0, 길이 제한. 인증 근거로 쓰지 않는다."""
    for h in headers:
        if h.name.lower() in ("from", "f"):
            m = re.search(r"sips?:([^@;>]+)", h.value)
            if not m:
                return None
            return normalize_phone(m.group(1))
    return None


def normalize_phone(value: str) -> str | None:
    """미신뢰 전화번호: 숫자만, +82 → 0, 길이 제한."""
    value = value.strip()
    if value.startswith("+82"):
        value = "0" + value[3:]
    return re.sub(r"\D", "", value)[:MAX_CALLER_DIGITS] or None


def mask_phone(phone: str | None) -> str:
    if not phone:
        return "알 수 없음"
    return phone[:3] + "*" * max(len(phone) - 7, 0) + phone[-4:] if len(phone) > 7 else "*" * len(phone)



KST = timezone(timedelta(hours=9))
# 결제 방식(백엔드 paymentMethodType) → 고객에게 말하는 이름
PAYMENT_NAMES = {"credit": "정산", "groupBilling": "그룹카드(기업)", "billing": "개인카드"}
COUNT_NAMES = {"document_count": "서류", "small_box_count": "소형 박스", "medium_box_count": "중형 박스",
               "big_box_count": "대형 박스"}
# 택배가 아니라 통화(주문)에 하나인 질문 항목. 첫 택배를 확인하기 전에 받는다(끊겨도 확인된 택배를 접수할 수 있게)
CALL_FIELDS = ("customer_name", "pickup_at", "payment_method")


def iso_utc(ts: int | float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def _region(address: str | None) -> str:
    """주소 앞 두 낱말(시·구 정도). 최근 배송을 말로 짧게 가리킬 때."""
    return " ".join((address or "").split()[:2])


class Call:
    def __init__(self, session_id: str, caller: str | None, cfg: ServerConfig, texts: Texts, backend: Any,
                 incoming_at: str | None = None):
        self.session_id = session_id
        self.caller = caller
        self.incoming_at = incoming_at  # OpenAI 수신 이벤트 created_at(ISO 8601). 백엔드가 녹취와 통화를 잇는 기준
        self.pbx_ended: dict | None = None  # PBX가 알린 통화 종료(spec/pbx-sip.md)
        self.cfg = cfg
        self.texts = texts
        self.backend = backend  # 백엔드 API(app/backend_api.py)
        self.order = Order()  # 받는 중인 택배 하나
        self.flow = engine.FlowState(stage="")
        self.customer_type = "new"  # new · registered · withdrawn
        self.customer_seq: int | None = None  # 등록 고객 번호(백엔드)
        self.registered_name: str | None = None
        self.usage_types: list[str] = []
        self.recent: Order | None = None  # 이번 통화에서 앞서 확인한 택배(다음 택배의 "최근 배송")
        # 발신번호 주인의 주소록. 출발지·도착지 구분이 없어 두 쪽 모두 같은 목록을 본다
        pins: list[Place] = []
        self.places: dict[str, list[Place]] = {"origin": pins, "destination": pins}
        self.reset_order_flags()
        # 통화(주문)에 하나인 값. 백엔드 주문 하나에 이번 통화의 택배들이 parcels로 묶인다
        self.customer_name: str | None = None  # 미등록 고객의 성함(보내는 분 번호가 발신번호면 보내는 분 성함)
        self.pickup_at: str | None = None
        self.payment_method: str | None = None
        self.parcels: list[Order] = []  # 고객이 확인한 택배(통화 끝에 한 번에 접수)
        self.cancelled = False  # 고객이 접수를 그만둠
        self.result_key = str(uuid.uuid4())  # 통화 결과의 Idempotency-Key. 재시도에도 같은 키
        self.result_body: dict | None = None  # 처음 보낸 본문(같은 키로 다시 확인할 때 그대로)
        self.result: dict | None = None  # 백엔드 응답 data(status·parcelNo)
        self.result_lock = asyncio.Lock()
        self.lock = asyncio.Lock()  # 한 통화 안의 도구 호출은 순서대로
        self.hangup_requested = asyncio.Event()
        self.refer_requested = asyncio.Event()
        self.last_output_at = 0.0  # 음성 출력 이벤트를 마지막으로 본 시각(monotonic)
        self.last_input_at = 0.0
        self.task: asyncio.Task | None = None
        self.last_progress = ""
        # 고객 답 판별(app/listener.py)
        self.heard_stage = ""  # heard_text를 모은 단계
        self.heard_text = ""  # 이번 단계에서 아직 판별에 쓰지 않은 고객 말
        self.heard_at = 0.0  # 고객 말 조각을 마지막으로 받은 시각(monotonic). 판별 지연 측정용
        self.last_input_at = 0.0  # 고객 받아쓰기를 마지막으로 받은 시각(monotonic). 무응답 종료용
        self.answer_failures = 0  # 연달아 실패한 답 처리(접수·저장 등) 수
        # 상담원 연결: offer = 처리할 수 없는 요청·반복 실패로 서버가 먼저 제안, refer_failed = 전환 실패
        self.handoff_variant: str | None = None
        self.refer_failed = False
        self.listen_timer: asyncio.Task | None = None
        self.listen_seq = 0  # 마지막으로 시작한 판별 번호(늦게 온 옛 판별은 버린다)
        self.listen_tasks: set[asyncio.Task] = set()
        # 관제용 기록
        self.status = "accepting"  # accepting · active · ended · failed
        self.started_at = time.time()
        self.ended_at: float | None = None
        self.end_reason: str | None = None
        self.transcript: list[dict] = []
        self.tool_calls: dict[str, dict] = {}
        self.errors: list[dict] = []
        self.usage: dict | None = None
        self.rag = None
        # 직접 만든 테스트 Call은 기존 responses 경로를 유지한다. 실제 accept에서 설정한다.
        self.delegation_mode = 'responses'
        self.backend_settings: dict = {}
        self.latest_delegation: str | None = None
        self.delegations: dict[str, dict] = {}
        self.event_types: set[str] = set()
        self.persona_version: int | None = None  # 이 통화가 쓴 백엔드 페르소나 버전(None이면 로컬 기본값)  # 받은 sideband 이벤트 종류(처음 한 번만 로그)
        self.pending_context: dict[str, asyncio.Future] = {}
        self.input_ready = asyncio.Event()

    # --- 시작 ---

    async def prepare(self) -> None:
        """발신번호로 고객(등록·미등록·탈퇴)과 주소록을 백엔드에서 받고 시작 단계로 들어간다.
        백엔드 실패면 신규 고객으로 진행. 탈퇴 고객은 신규로 다루지 않고 상담원에게 넘긴다."""
        if self.caller:
            try:
                context = await self.backend.caller_context(self.caller)
                if context.status == "REGISTERED":
                    self.customer_type, self.customer_seq = "registered", context.customer_seq
                    self.registered_name, self.usage_types = context.name, context.usage_types
                    self.places["origin"].extend(context.places)
                elif context.status == "WITHDRAWN":
                    self.customer_type = "withdrawn"
                    self.request_refer()
            except Exception:
                log.exception("고객 조회 실패 %s", self.session_id)
                self.add_error("고객 조회 실패")
        await engine.start(self)
        self.notify()

    def reset_order_flags(self) -> None:
        """주문 하나를 받는 동안만 쓰는 검색·확인 상태. 새 주문을 시작할 때 비운다."""
        self.dest_misses = 0  # 저장된 받는 곳을 못 찾은 횟수
        self.dest_variant: str | None = None  # find_destination 안내(need_region · need_detail · need_more)
        self.origin_variant: str | None = None  # find_origin 안내(which)
        self.origin_checked = False  # 이번 주문에서 "보내는 곳이 지난번과 같은지"를 이미 물었음
        self.from_saved: set[str] = set()  # 저장된 배송지·최근 배송으로 채운 항목(번호·상세주소는 읽지 않게 가린다)
        # 주소 확정(address 단계): 새로 기록돼 아직 주소DB로 확정하지 않은 주소 항목, 항목별 확정 결과(관제용)
        self.address_pending: set[str] = set()
        self.address_results: dict[str, dict] = {}

    def use_place(self, role: str, place: Place) -> None:
        """저장된 배송지(또는 최근 배송)를 이번 주문의 보내는 곳·받는 곳으로 쓴다."""
        self.order.set_place(role, place)
        self.from_saved |= {f"{role}_phone", f"{role}_address_detail"}

    # --- 상태 엔진이 쓰는 것 ---

    def field_done(self, name: str) -> bool:
        if name in CALL_FIELDS:
            return name not in self.call_fields_due()
        return self.order.has(name)

    def call_fields_due(self) -> list[str]:
        """아직 받지 않은 통화 항목. 성함은 미등록 고객이고 보내는 분 번호가 발신번호와 다를 때만 묻는다."""
        due = []
        if self.customer_type != "registered" and not self.customer_name:
            if self.caller and self.order.sender_phone == self.caller and self.order.sender_name:
                self.customer_name = self.order.sender_name
            else:
                due.append("customer_name")
        if self.pickup_at is None:
            due.append("pickup_at")
        if self.payment_method is None:
            due.append("payment_method")
        return due

    def payment_options(self) -> dict[str, str]:
        """이 고객이 쓸 수 있는 결제 방식. 정산은 공통, 그룹카드는 기업 소속, 개인카드는 개인 고객(백엔드가 다시 검사)."""
        out = {"credit": PAYMENT_NAMES["credit"]}
        if "COMPANY" in self.usage_types:
            out["groupBilling"] = PAYMENT_NAMES["groupBilling"]
        if self.customer_type != "registered" or "PERSONAL" in self.usage_types:
            out["billing"] = PAYMENT_NAMES["billing"]
        return out

    def stage_variant(self, stage: str) -> str | None:
        ending = ("refer_failed" if self.refer_failed else "handoff" if self.refer_requested.is_set()
                  else "cancelled" if self.cancelled else self.submit_variant())
        return {"find_destination": self.dest_variant, "find_origin": self.origin_variant,
                "handoff": self.handoff_variant, "ending": ending}.get(stage)

    def recorded(self) -> list[tuple[str, str]]:
        """음성 모델·백엔드에 보여 줄 기록 값. 저장된 곳에서 온 번호·상세주소와 발신번호는 값 대신 표시만 한다
        (고객이 직접 불러 주지 않은 값을 소리 내 읽지 않게. 실제 값은 임시 주문에 그대로 있다)."""
        labels, out = self.texts.labels, []
        for f in ORDER_FIELDS + CALL_FIELDS:
            v = self._shown(f)
            if v is None:
                continue
            if not v:
                v = self.texts.empty_value
            elif f in self.from_saved:
                v = self.texts.saved_value
            elif f in PHONE_FIELDS and self.caller and v == self.caller:
                v = self.texts.caller_value
            out.append((labels[f], v))
        if self.parcels:
            out.append((labels["parcels"], f"{len(self.parcels)}건"))
        return out

    def _shown(self, f: str) -> str | None:
        o = self.order
        if f == "item":
            parts = [f"{COUNT_NAMES[c]} {getattr(o, c)}개" for c in COUNT_FIELDS if getattr(o, c)]
            parts += [o.other_item] if o.other_item else []
            return ", ".join(parts) or None
        if f == "item_price":
            return None if o.item_price is None else f"{o.item_price:,}원"
        if f == "pickup_at":
            if self.pickup_at is None:
                return None
            d = datetime.fromisoformat(self.pickup_at)
            return f"{d.month}월 {d.day}일 {d.hour}시 {d.minute:02d}분"
        if f == "payment_method":
            return self.payment_method and PAYMENT_NAMES[self.payment_method]
        if f == "customer_name":
            return self.customer_name
        return getattr(o, f)

    def text_vars(self) -> dict:
        biz = self.cfg.business
        r = self.recent
        return {
            "company": biz.company_name,
            "parcel_no": (self.result or {}).get("parcelNo") or "",
            "parcel_count": len(self.parcels),
            "now": datetime.now(KST).strftime("%Y-%m-%d %H:%M"),
            "payment_options": " / ".join(self.payment_options().values()),
            "goodbye_message": biz.goodbye_message,
            "recent_origin": f"{r.sender_name} 님, {_region(r.sender_address)}" if r else "",
            "customer_name": self.display_name() or "없음",
            "saved_origins": " / ".join(p.address for p in self.places["origin"][:3]),
            "caller": self.caller or "알 수 없음",
            "customer_type": self.texts.customer_types[self.customer_type],
        }

    def display_name(self) -> str | None:
        """등록 고객 성함(백엔드 고객 정보)."""
        return self.registered_name if self.customer_type == "registered" else None

    # --- 통화 결과(백엔드 POST /api/orders, 통화당 한 번) ---

    async def send_result(self, outcome: str) -> dict | None:
        """통화 결과를 한 번 보낸다. 이미 보냈으면 같은 키·같은 본문으로 상태만 다시 확인한다.
        발신번호·수신 시각을 모르면 백엔드가 받지 않으므로 보내지 않는다. 실패는 None(통화는 계속)."""
        async with self.result_lock:
            if self.result and self.result.get("status") != "SUBMITTING":
                return self.result
            if self.result_body is None:
                if not self.caller or not self.incoming_at:
                    log.error("발신번호·수신 시각을 몰라 결과를 보내지 않음 %s", self.session_id)
                    self.add_error("결과 전송 불가(발신번호·수신 시각 없음)")
                    return None
                parcels = list(self.parcels)
                if outcome == "INCOMPLETE" and not self.order.empty():
                    parcels.append(self.order)  # 받는 중이던 택배도 상담원이 이어 받게
                call = {"providerCallId": self.session_id, "callerPhoneNumber": self.caller,
                        "incomingAt": self.incoming_at}
                self.result_body = result_body(outcome, call, self.customer_seq, self.customer_name, self.caller,
                                               self.payment_method, self.pickup_at, parcels)
            try:
                self.result = await self.backend.submit_result(self.result_body, self.result_key)
            except BackendError as e:
                log.error("결과 전송 실패 %s %s: %s", self.session_id, self.result_body["outcome"], e)
                self.add_error(f"결과 전송 실패: {e}")
                return None
            log.info("결과 %s %s → %s", self.session_id, self.result_body["outcome"], self.result.get("status"))
            self.notify()
            return self.result

    def submit_variant(self) -> str | None:
        """접수를 시도했으면 마무리 안내: ACCEPTED만 접수 완료, 그 밖(처리 중·확인 필요·실패·미완료)은 확인 후 연락."""
        if self.result_body is None:
            return None
        return "accepted" if (self.result or {}).get("status") == "ACCEPTED" else "pending"

    def end_outcome(self) -> str:
        """통화가 끝날 때 보낼 결과. 상담원에게 넘긴 통화는 확인된 택배가 있어도 접수하지 않고 미완료로 넘긴다."""
        if self.refer_requested.is_set():
            return "INCOMPLETE"
        if self.cancelled:
            return "CANCELLED"
        return "COMPLETE" if self.parcels and self.complete_ready() else "INCOMPLETE"

    def complete_ready(self) -> bool:
        """접수(COMPLETE)에 필요한 값이 다 있음. 주소의 지번·좌표 등을 못 찾았으면 임의 값 없이 미완료로 둔다."""
        return bool(self.payment_method and self.pickup_at and (self.customer_seq or self.customer_name)
                    and all(p.sender_geo and p.receiver_geo for p in self.parcels))

    async def finish(self) -> None:
        """통화가 끝나면 결과를 한 번 보낸다. 이미 보낸 통화는 같은 키로 확인만(접수 결과가 확정되지 않았을 때)."""
        await self.send_result(self.result_body["outcome"] if self.result_body else self.end_outcome())

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
        gap_ok = start_ms is not None and last is not None and last["end_ms"] is not None \
            and start_ms - last["end_ms"] <= self.cfg.monitor.bubble_gap_ms
        if last is not None and (last is self.transcript[-1] or gap_ok):
            last["text"] += delta
            last["end_ms"] = end_ms if end_ms is not None else last["end_ms"]
        else:
            self.transcript.append({"speaker": speaker, "text": delta, "at": time.time(), "end_ms": end_ms})
        if speaker == "agent":
            self.last_output_at = time.monotonic()
        elif speaker == 'customer':
            self.last_input_at = time.monotonic()
        self.notify()

    def add_error(self, message: str) -> None:
        self.errors.append({"at": time.time(), "message": message})
        self.notify()

    def end(self, reason: str, status: str = "ended") -> None:
        if self.status in ("ended", "failed"):
            return
        self.status, self.end_reason, self.ended_at = status, reason, time.time()
        log.info("통화 종료 %s 이유=%s %.0f초", self.session_id, reason, self.ended_at - self.started_at)
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
            "pbx_ended": self.pbx_ended,
            "stage": self.flow.stage,
            "history": self.flow.history,
            "order": self.order.model_dump(),
            "address": self.address_results,
            "fare": None,  # 백엔드가 확인한 금액이 없으면 숫자를 만들지 않는다.
            "parcels": [p.model_dump() for p in self.parcels],
            "payment_method": self.payment_method,
            "pickup_at": self.pickup_at,
            "result": self.result,
            "next": engine.next_text(self) if self.flow.stage else "",
            "transcript": self.transcript,
            "tool_calls": list(self.tool_calls.values()),
            "errors": self.errors,
            "usage": self.usage,
            "delegations": [{key: value for key, value in row.items() if key != 'task'}
                            for row in self.delegations.values()],
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

    def find_active_by_caller(self, caller: str | None, started_before: float) -> list[Call]:
        """진행 중인 통화 중 발신번호가 같고 started_before 전에 시작한 것. shortcut: 순회(통화 수가 동시 상한 이하라 충분)."""
        if not caller:
            return []
        return [c for c in self.calls.values()
                if c.caller == caller and c.started_at < started_before and c.status in ("accepting", "active")]

    def list(self) -> list[Call]:
        self.purge()
        return sorted(self.calls.values(), key=lambda c: c.started_at, reverse=True)
