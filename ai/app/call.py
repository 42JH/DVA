"""통화 하나 = 통화 객체 하나. 임시 주문·진행 상태·도구 기록·발신번호를 모두 여기에 둔다(spec/concurrency.md).
LANGGRAPH_REBUILD §3의 CallState는 이 객체와 진행 상태(engine.FlowState)에 나눠 있다(필드 이름은 기존 관례)."""

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
from app.order import COUNT_FIELDS, ORDER_FIELDS, PHONE_FIELDS, Order, Place, match_places, pin_labels, words

log = logging.getLogger(__name__)

MAX_CALLER_DIGITS = 15
MAX_AGENT_DELTAS = 200  # 질문을 들었는지 볼 때 쓰는 상담원 받아쓰기 조각(최근 것만)


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
COUNT_NAMES = {"document_count": "서류", "small_box_count": "소형 박스", "medium_box_count": "중형 박스",
               "big_box_count": "대형 박스"}
# 정정 항목(판별의 slot): 상세주소는 주소에, 규격별 수량·기타 물품은 물품에 묶는다
SLOT_OF = {"sender_address_detail": "sender_address", "receiver_address_detail": "receiver_address",
           "other_item": "item", **{c: "item" for c in COUNT_FIELDS}}
SHOWN = ORDER_FIELDS + ("pickup_at",)  # 기록 값으로 보여 줄 항목(수거 시각은 통화에 하나)


def iso_utc(ts: int | float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def _unique(places: list[Place | None]) -> list[Place]:
    out: list[Place] = []
    for p in places:
        if p is not None and p not in out:
            out.append(p)
    return out


WEEKDAYS = "월화수목금토일"


def spoken_phone(digits: str) -> str:
    """번호를 끊어 읽기 좋게: 010-1234-5678, 02-123-4567, 031-123-4567. 자릿수가 맞는 숫자만 온다(record_order)."""
    if not digits:
        return ""
    if digits.startswith("02"):
        head = 2
    elif len(digits) == 8:  # 15xx·16xx·18xx
        return f"{digits[:4]}-{digits[4:]}"
    else:
        head = 3
    mid = len(digits) - head - 4
    return f"{digits[:head]}-{digits[head:head + mid]}-{digits[-4:]}"


def spoken_time(at: datetime, base: datetime) -> str:
    """수거 일시를 말로: 전화 받은 날 기준 오늘·내일·모레, 그 밖에는 "11월 26일", 시각은 오전/오후(분은 있을 때만)."""
    at = at.astimezone(KST)
    days = (at.date() - base.date()).days
    day = {0: "오늘", 1: "내일", 2: "모레"}.get(days) or (f"{at.day}일" if at.month == base.month and at.year == base.year
                                                       else f"{at.month}월 {at.day}일")
    hour = at.hour % 12 or 12
    minute = f" {at.minute}분" if at.minute else ""
    return f"{day} {'오전' if at.hour < 12 else '오후'} {hour}시{minute}"


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
        self.order = Order()  # 받는 중인 택배 하나(slots)
        self.flow = engine.FlowState(stage="")
        self.customer_type = "new"  # new · registered · withdrawn
        self.customer_seq: int | None = None  # 등록 고객 번호(백엔드)
        self.call_session_seq: int | None = None  # 백엔드 통화 번호(고객 확인에서 받음). 조회·취소의 call_session_seq 헤더
        self.payment_methods: list[str] = []  # 백엔드가 준 지금 쓸 수 있는 결제 방식(billing · credit · groupBilling)
        self.recent_pins: list[Place] = []  # 이전 접수의 도착지(최근 것부터). 도착지 핀 후보 맨 앞
        self.registered_name: str | None = None
        self.usage_types: list[str] = []
        self.pins: list[Place] = []  # 발신번호 주인의 주소록(개인·기업 PIN). 출발지·도착지 구분이 없다
        # 백엔드가 준 가장 최근 접수 1건의 출발지·도착지({기존 출발지}, "이번에도 {도착지 주소}로")
        self.recent: dict[str, Place | None] = {"origin": None, "destination": None}
        self.places: dict[str, list[Place]] = {"destination": []}  # 이번 택배의 도착지 핀 후보(최근 것부터)
        self.reset_order_flags()
        # 통화(주문)에 하나인 값. 백엔드 주문 하나에 이번 통화의 택배들이 parcels로 묶인다
        self.customer_name: str | None = None  # 미등록 고객의 성함(MVP: 보내는 분 성함)
        self.register_tried = False  # 신규 고객 등록을 시도했음(통화에 한 번)
        self.pickup_at: str | None = None
        self.payment_method: str | None = None
        self.payment_pick: str | None = None  # 결제 방식 질문에 고객이 고른 것(확정 지연 뒤 payment_method가 된다)
        self.parcels: list[Order] = []  # 접수 완료(A_DONE)한 택배(통화 끝에 한 번에 접수)
        self.result_key = str(uuid.uuid4())  # 통화 결과의 Idempotency-Key. 재시도에도 같은 키
        self.result_body: dict | None = None  # 처음 보낸 본문(같은 키로 다시 확인할 때 그대로)
        self.result: dict | None = None  # 백엔드 응답 data(status·parcelNo)
        self.result_lock = asyncio.Lock()
        # §2.4 도와드리지 못한 횟수, 직전 안내에 상담원 제안이 있었는지(D9 조건)
        self.fail_count = 0
        self.agent_offered = False
        # 조회·취소(C): 찾은 택배 목록·지금 확인 중인 것, 확인한 택배, 취소 실행 상태
        self.lookup: dict = {}
        self.target_order: dict | None = None
        self.cancel_state: str | None = None  # running · failed
        self.cancel_attempts = 0
        self.running_ops: dict[str, dict] = {}  # operation_id → {tool, args, status}: 쓰기 도구 기록(중복 취소 방지)
        self.server_tool: tuple[str, dict, str] | None = None  # 서버가 실행할 도구(이름, 인수, 결과 없이 실패했을 때 사건)
        self.write_tasks: set[asyncio.Task] = set()  # 실행 중인 서버 쓰기 도구(통화가 끝나도 결과를 기록한 뒤 끝낸다)
        self.rag_deadline = 0.0  # 질문 뒤 검색 결과를 기다리는 끝(monotonic)
        self.search_entry_at = 0.0  # 검색 결과가 먼저 와서 QnA로 들어간 시각(monotonic). 같은 질문을 두 번 처리하지 않게
        self.lock = asyncio.Lock()  # 한 통화 안의 도구 호출·판별 반영은 순서대로
        self.hangup_requested = asyncio.Event()
        self.refer_requested = asyncio.Event()
        self.last_output_at = 0.0  # 음성 출력 이벤트를 마지막으로 본 시각(monotonic)
        self.trace_text_started = False  # 위임 구간 기록: 이번 백엔드 응답의 첫 글자 조각을 남겼음
        self.agent_text_at = 0.0  # 상담원 출력 받아쓰기 조각을 마지막으로 받은 시각(monotonic). 말하는 중인지 판단
        self.task: asyncio.Task | None = None
        self.last_progress = ""
        self.progress_sent_at = 0.0  # 진행 상태(다음 할 말)를 음성 모델에 전한 시각(monotonic). 마무리 인사 대기의 기준
        self.end_requested_at = 0.0  # 종료·상담원 연결을 요청한 시각(monotonic)
        self.refer_failed = False
        # 고객 말 판별(app/listener.py, §2.5)
        self.heard_rev = 0  # 고객 말 조각이 올 때마다 1 증가(판별 리비전): 늦게 온 옛 판별은 버린다
        self.heard_stage = ""  # heard_text를 모은 단계
        self.heard_text = ""  # 이번 단계에서 아직 판별에 쓰지 않은 고객 말
        self.heard_asked = ""  # 그 말을 시작할 때 서버가 물은 질문(판별 기준. 음성 모델이 그사이 한 말이 아니라)
        self.heard_start: int | None = None  # 그 말의 첫 조각 시작(세션 타임라인 ms). 질문을 다 들었는지 판단
        self.heard_started_at = 0.0  # 그 말의 첫 조각을 받은 시각(monotonic)
        self.heard_at = 0.0  # 고객 말 조각을 마지막으로 받은 시각(monotonic). 판별 지연 측정용
        self.delegated_at = 0.0  # 음성 모델이 마지막으로 위임한 시각(monotonic). 서버 기록 요청과 겹치지 않게
        self.customer_said_at = 0.0  # 내용 있는 고객 받아쓰기 조각을 마지막으로 받은 시각(monotonic). 말하는 중인지 판단
        self.phone_check = ""  # 방금 기록한 번호(한 번 읽어 확인, PHONE_CHECK)
        self.progress_speak = False  # 미뤄 둔 진행 상태를 보낼 때 말하게도 해야 함(서버가 옮긴 단계)
        self.progress_due = False  # 고객이 말하는 중이라 미뤄 둔 진행 상태가 있음(말이 멈추면 보낸다)
        self.progress_stale = False  # 단계가 허용하지 않는 도구를 거절함: 바뀐 것이 없어도 진행 상태를 다시 보낸다
        self.last_input_at = 0.0  # 고객 받아쓰기를 마지막으로 받은 시각(monotonic). 무응답 종료용
        # 지난 단계의 말(전환 전에 한 말의 늦은 조각, 듣지 않는 단계에서 쌓인 말): 전역 의도로만 판별한다
        self.side: dict = {"stage": "", "text": "", "off": False, "since": 0.0, "flushing": False}
        self.reask = False  # 질문을 다 듣기 전 답이라 받지 않았음: 같은 질문을 다시 하게 한다
        self.listen_timer: asyncio.Task | None = None
        self.side_timer: asyncio.Task | None = None
        self.listen_tasks: set[asyncio.Task] = set()
        self.clock_offset: float | None = None  # 서버 시계(ms) - 세션 타임라인(ms)의 가장 작은 값
        self.agent_deltas: list[tuple[str, int | None, int | None]] = []  # 상담원 받아쓰기 조각(글, 시작, 끝)
        self.drift_fixed = ""  # 그래프와 다른 마무리 인사를 바로잡은 단계(단계마다 한 번)
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
        self.backend_instructions = ""  # 통화 시작 때 보낸 백엔드 지시문(여기에 "지금 상태"를 붙여 갱신)
        self.backend_state = ""  # 마지막으로 백엔드에 보낸 "지금 상태"
        self.backend_settings: dict = {}
        self.latest_delegation: str | None = None
        self.delegations: dict[str, dict] = {}
        self.event_types: set[str] = set()  # 받은 sideband 이벤트 종류(처음 한 번만 로그)
        self.persona_version: int | None = None  # 이 통화가 쓴 백엔드 페르소나 버전(None이면 로컬 기본값)
        self.pending_context: dict[str, asyncio.Future] = {}
        self.input_ready = asyncio.Event()

    # --- 시작 ---

    async def prepare(self) -> None:
        """발신번호로 고객(등록·미등록·탈퇴)과 주소록을 백엔드에서 받고 시작 단계(CALLER_ID)로 들어간다.
        백엔드 실패면 신규 고객으로 진행. 탈퇴 고객은 신규로 다루지 않고 상담원에게 넘긴다(IS_REGISTERED)."""
        if self.caller:
            try:
                # 통화 식별(같은 통화는 같은 값으로 재요청): 백엔드가 통화를 만들고 통화 번호를 준다
                call = {"providerCallId": self.session_id, "incomingAt": self.incoming_at} if self.incoming_at else None
                context = await self.backend.caller_context(self.caller, call, self.cfg.flow.pin_recent_count)
                self.call_session_seq, self.payment_methods = context.call_session_seq, context.payment_methods
                if context.status == "REGISTERED":
                    self.customer_type, self.customer_seq = "registered", context.customer_seq
                    self.registered_name, self.usage_types = context.name, context.usage_types
                    self.pins, self.recent_pins = list(context.places), list(context.recent_destinations)
                    # 접수 완료된 주문이 없으면(개인 카드 결제 대기뿐·등록만 한 고객) 본인 주소록의 주소가 기존 출발지(§9)
                    own = next((p for p in self.pins if p.phone == self.caller), None)
                    self.recent = {"origin": context.recent_origin or own,
                                   "destination": context.recent_destinations[0] if context.recent_destinations else None}
                elif context.status == "WITHDRAWN":
                    self.customer_type = "withdrawn"
            except Exception:
                log.exception("고객 조회 실패 %s", self.session_id)
                self.add_error("고객 조회 실패")
        await engine.start(self)
        self.notify()

    def reset_order_flags(self) -> None:
        """택배 하나를 받는 동안만 쓰는 상태. 새 택배를 시작할 때 비운다."""
        self.from_saved: set[str] = set()  # 주소록·앞 택배로 채운 항목(번호·상세주소는 읽지 않게 가린다)
        # 주소 확정: 새로 기록돼 아직 주소DB로 확정하지 않은 주소 항목, 못 찾아 한 번 다시 물은 주소 항목, 결과(관제용)
        self.address_pending: set[str] = set()
        self.address_retry: set[str] = set()
        self.address_results: dict[str, dict] = {}
        # 도착지 핀 매칭: 지금 찾는 쪽(destination), 후보, 아니라고 한 핀, 고객이 말한 받는 분(이름·장소·층/호수)
        self.pin_role: str | None = None
        self.pin_candidates: list[Place] = []  # 차이 나는 값으로 다시 물을 후보(DIFF)
        self.pin_offer: Place | None = None  # 맞는지 확인하는 핀(VERIFY)
        self.pin_rejected: dict[str, list[Place]] = {"destination": []}
        self.dest_said: dict[str, str] = {}  # 핀이 없으면 받는 분 정보로 가져간다(B12, 이미 받은 항목은 다시 묻지 않게)
        self.pin_ask: str | None = None  # 주소록에서 못 찾았는데 한쪽만 들음: 빠진 쪽(name·place)을 묻는다
        self.corrected: tuple[str, str] | None = None  # 마지막으로 고친 항목과 값(정정 확인 문구)
        # 제안(ORDER): 저장된 값을 쓸지 묻는 중인 기존 출발지·최근 도착지. 답하거나 그 항목이 기록되면 사라진다
        self.origin_offer: Place | None = None
        self.dest_offer: Place | None = None
        self.parcel_started = False  # 이 택배의 보내는 분·제안을 준비했음(ORDER에 처음 들어올 때 한 번)

    def new_parcel(self) -> None:
        self.order = Order()
        self.reset_order_flags()

    def start_parcel(self) -> None:
        """ORDER에 들어올 때 새 택배면 한 번: 보내는 분(고객·발신번호), 출발지(두 번째 택배부터는 앞 택배의 출발지를
        묻지 않고 쓰고, 등록 고객의 첫 택배는 기존 출발지를 제안), 최근 도착지 제안, 도착지 핀 후보를 준비한다.
        받던 택배(질문 뒤 복귀·되읽기에서 고치기)는 건드리지 않는다."""
        if self.parcel_started:
            return
        self.parcel_started = True
        self.fill_sender()
        origin = self.recent_place("origin")
        if origin and not self.order.has("sender_address"):
            if self.parcels:
                self.use_place("sender", origin)
            elif self.customer_type == "registered":
                self.origin_offer = origin
        destination = self.recent_place("destination")
        if destination and not any(self.order.has(f) for f in ("receiver_name", "receiver_address")):
            self.dest_offer = destination
        self.load_pins()
        self.set_pin_role("destination")

    async def sync_asking(self) -> None:
        """값이 기록된 뒤(어느 경로로든: 값 기록·주소록 찾기·제안 답) 질문을 정하는 보조 상태를 값에 맞춘다. 질문은 늘
        빠진 항목만 묻는다: 제안·주소록 찾기 중 표시는 그 항목이 채워지면 사라지고, 주소록 찾기에서 들어 둔 이름·장소는
        받는 분 정보로 옮긴다(2026-11-01 통화: 이름은 주소록 찾기로, 주소는 값 기록으로 들어와 이름이 옮겨지지 않고
        "받으시는 분 주소를 말씀해 주세요"만 되풀이)."""
        o = self.order
        if o.has("sender_address"):
            self.origin_offer = None
        if o.has("receiver_name") or o.has("receiver_address"):
            self.dest_offer = None
            if self.pin_ask or self.dest_said:  # 주소록 찾기 도중에 받는 분 값이 직접 기록됨: 들어 둔 나머지를 옮기고 끝낸다
                await self.carry_dest_said()
                self.pin_offer, self.pin_candidates = None, []

    def use_place(self, role: str, place: Place) -> None:
        """저장된 배송지(또는 앞 택배)를 이번 주문의 보내는 곳·받는 곳으로 쓴다."""
        self.order.set_place(role, place)
        self.from_saved |= {f"{role}_phone", f"{role}_address_detail"}

    # --- B: 최근 접수·핀 ---

    def recent_place(self, role: str) -> Place | None:
        """가장 최근 접수 1건의 출발지(origin)·도착지(destination). 이번 통화에서 담은 택배가 가장 최근이다."""
        if self.parcels:
            return self.parcels[-1].place("sender" if role == "origin" else "receiver")
        return self.recent[role]

    def load_pins(self) -> None:
        """도착지 핀 후보, 최근 것부터: 이번 통화에서 접수한 받는 곳, 이전 접수의 도착지(백엔드 주소 이력), 주소록.
        주소록은 방향·날짜가 없어 발신번호와 다른 번호의 핀을 앞에 둔다(자기 집보다 남에게 보내는 곳이 먼저).
        매칭은 앞쪽 flow.pin_recent_count개에서 먼저 찾는다(최근 N개 우선)."""
        other = sorted(self.pins, key=lambda p: p.phone == self.caller)
        recent = [p.place("receiver") for p in reversed(self.parcels)]
        self.places = {"destination": _unique(recent + self.recent_pins + other)}

    def pin_scope(self, role: str) -> list[Place]:
        """아직 아니라고 하지 않은 핀."""
        return [p for p in self.places[role] if p not in self.pin_rejected[role]]

    def set_pin_role(self, role: str | None) -> None:
        if role != self.pin_role:
            self.pin_role, self.pin_candidates, self.pin_offer = role, [], None

    def pins_found(self, found: list[Place], narrowing: bool = False) -> list[str]:
        """핀 매칭 결과 → 분기 사건. 여러 개면 앞쪽(최근) 핀부터 몇 개만 후보로 묻는다. 후보 안에서 하나를 고른 것이면
        나머지 후보는 남겨 둔다(확인에서 아니라고 하면 남은 후보로 다시 묻는다)."""
        self.pin_ask = None
        if len(found) == 1:
            self.pin_offer = found[0]
            if not narrowing:
                self.pin_candidates = list(found)
            return ["pins.one"]
        self.pin_offer, self.pin_candidates = None, found[:self.cfg.flow.max_pin_options]
        return ["pins.many" if found else "pins.none"]

    def match_pins(self, name: str | None, place: str | None, detail: str | None) -> list[str]:
        """앞서 말한 받는 분(이름·장소)과 합쳐 찾는다. 후보를 좁히는 중이면 후보 안에서, 아니면 아직 아니라고 하지 않은
        핀에서 최근 N개를 먼저, 거기 없으면 전체에서. 못 찾았는데 이름·장소 중 한쪽만 말했으면 다른 쪽을 묻는다(B6 이후 규칙)."""
        said = self.dest_said
        self.dest_offer = None  # 최근 도착지 확인에 답하지 않고 다른 곳을 말함
        said.update({k: v for k, v in (("name", name), ("place", place), ("detail", detail)) if v})
        name, place, detail = said.get("name"), said.get("place"), said.get("detail")
        found = match_places(self.pin_candidates, name, place, detail) if len(self.pin_candidates) > 1 else []
        if found:
            return self.pins_found(found, narrowing=True)
        scope = self.pin_scope(self.pin_role)
        found = match_places(scope[:self.cfg.flow.pin_recent_count], name, place, detail) \
            or match_places(scope, name, place, detail)
        if not found and not (name and place):
            self.pin_offer, self.pin_candidates = None, []
            self.pin_ask = "place" if name else "name"
            return ["pins.ask_place" if name else "pins.ask_name"]
        return self.pins_found(found)

    async def reject_pin(self) -> None:
        """확인한 핀이 아니라고 함: 그 핀은 버린다. 후보를 좁히던 중이면 남은 후보로 다시 묻고, 없으면 "저장된 다른 배송지가
        없으니 새로 접수하겠습니다"(B11_NEW) 뒤 고객이 말한 받는 분 이름·장소를 가져가 빠진 것만 묻는다(2026-10-31 결정)."""
        rejected, self.pin_offer = self.pin_offer, None
        self.pin_rejected["destination"].append(rejected)
        left = [p for p in self.pin_candidates if p != rejected]
        if len(left) > 1:
            self.pin_candidates = left
            return
        if len(left) == 1:
            self.pin_offer, self.pin_candidates = left[0], left
            return
        self.pin_candidates = []
        if "B11_NEW" not in self.flow.notice:
            self.flow.notice.append("B11_NEW")
        await self.carry_dest_said()

    def pin_labels(self) -> list[str]:
        return pin_labels(self.pin_candidates) if len(self.pin_candidates) > 1 else []

    def fill_sender(self) -> None:
        """보내는 분 = 고객, 연락처 = 발신번호(묻지 않는다). MVP 전제(다이어그램 메모).
        TODO(flow): 보내는 분이 고객과 다를 수 있다. 발신번호가 없는 통화는 고려하지 않는다(연락처가 비어 미완료 접수)."""
        o = self.order
        o.sender_name = o.sender_name or self.registered_name or self.customer_name
        if o.sender_phone is None and self.caller:
            o.sender_phone = self.caller

    async def register_customer(self) -> None:
        """신규 고객이 보내는 분 정보(성함·주소)를 다 말하면 백엔드에 고객으로 등록하고 보내는 곳을 개인 주소록에 저장한다.
        이때부터 기존 고객으로 다룬다(통화 결과는 고객 번호로, 다음 통화는 이 주소가 기존 출발지, 2026-10-31 결정).
        실패해도 통화는 신규 고객으로 이어 간다(결과는 이름·발신번호로 보낸다).
        TODO(flow): 등록 뒤 보내는 곳을 고쳐도 주소록은 고치지 않는다."""
        o = self.order
        if self.customer_type != "new" or self.register_tried or not (self.caller and self.call_session_seq
                                                                       and o.sender_name):
            return
        self.register_tried = True  # 보내는 분 정보가 찬 뒤 기록할 때마다 부르므로 한 번만(실패해도 다시 하지 않음)
        try:
            await self.backend.create_customer(o.sender_name, self.caller)  # 이미 있으면 아래 고객 확인으로 번호를 받는다
            call = {"providerCallId": self.session_id, "incomingAt": self.incoming_at}
            context = await self.backend.caller_context(self.caller, call, 0)
            if context.status != "REGISTERED":
                return
            self.customer_type, self.customer_seq, self.registered_name = "registered", context.customer_seq, context.name
            self.payment_methods = context.payment_methods
            if o.sender_geo:  # 주소록은 주소 9개 항목이 다 있어야 받는다
                await self.backend.create_pin(self.call_session_seq, self.customer_seq, o, "sender", "보내는 곳")
            # 이름·번호·주소는 개인정보라 남기지 않는다
            log.info("고객 등록 %s 고객번호=%s 주소록=%s", self.session_id, self.customer_seq, bool(o.sender_geo))
            self.notify()
        except Exception:
            log.exception("고객 등록 실패 %s", self.session_id)
            self.add_error("고객 등록 실패")

    async def carry_dest_said(self) -> None:
        """도착지 핀이 없을 때(B12·B11) 고객이 말한 받는 분 이름·장소를 받는 분 정보로 가져간다. 주소는 record_order처럼
        주소DB로 정한다(못 찾으면 받는 곳 주소를 다시 묻는다). 아니라고 한 핀의 값은 가져가지 않는다. 한 번만.
        장소는 번지·건물번호(숫자)가 있을 때만 주소로 본다: "해운대"·"엄마 집" 같은 말을 주소DB가 엉뚱한 주소로 고르지 않게."""
        from app.tools.record_order import resolve

        said, o = self.dest_said, self.order
        self.dest_said, self.pin_ask = {}, None
        if said.get("name") and o.receiver_name is None:
            o.receiver_name = said["name"]
        if said.get("place") and re.search(r"\d", said["place"]) and o.receiver_address is None:
            o.receiver_address, o.receiver_address_detail = said["place"], said.get("detail")
            self.address_pending.add("receiver_address")
            await resolve(self)

    # --- C: 조회·취소 ---

    async def find_orders(self, name: str | None, forgot: bool = False) -> list[str]:
        """이 통화 고객의 택배(주문 상세)를 받는 분 성함으로 찾는다(최근 주문 lookup_limit건 안에서, 최근 것부터).
        결과가 분기 사건이다(§2.1). 통화 번호가 없으면(고객 확인 실패) 조회할 수 없다."""
        self.lookup.update(name=name, forgot=forgot, searched=True, index=0, orders=[], failed=False)
        try:
            if not self.call_session_seq:
                raise BackendError("통화 번호 없음")
            orders = await self.backend.find_parcels(self.call_session_seq, self.cfg.backend.lookup_limit)
        except Exception:
            log.exception("택배 조회 실패 %s", self.session_id)
            self.lookup.update(failed=True, fails=self.lookup.get("fails", 0) + 1)
            return ["lookup.failed"]
        if name:
            said = "".join(words(name))
            orders = [o for o in orders if said and said in "".join(words(o.get("receiver_name")))]
        self.lookup["orders"] = orders
        return ["lookup.found" if orders else "lookup.none"]

    def start_cancel(self) -> None:
        """확인한 택배의 취소를 서버가 실행하게 한다(app/progress.py after_change). 쓰기마다 작업 번호(§2.5(5))."""
        self.cancel_attempts += 1
        self.cancel_state = "running"
        op = f"{self.session_id}:cancel:{self.cancel_attempts}"
        args = {"order_seq": self.target_order["order_seq"], "order_parcel_seq": self.target_order["order_parcel_seq"],
                "customer_confirmed": True, "operation_id": op}
        self.server_tool = ("cancel_order", args, "cancel.failed")

    # --- §2.5(4) 정정 ---

    def start_correction(self, slot: str) -> list[str] | None:
        """고객이 이미 말한 항목을 고친다고 함(값은 백엔드가 record_order로 기록). 고친 값이 아직 없으면 그 항목을 다시 묻는다.
        저장된 곳(기존 출발지·최근 도착지·주소록)에서 가져온 출발지·도착지를 바꾸면 그 묶음을 비워 다시 받는다(출발지는
        주소만, 도착지는 받는 분까지. 이전 주소록 찾기 결과는 버린다). 이 단계에서 정정을 받을 수 없으면 None."""
        if self.flow.task != "order" or "record_order" not in engine.allowed_tools(self):
            return None  # 접수 업무 밖(조회·취소, 취소 실행 뒤 포함)·QnA 중에는 받지 않는다
        if slot in engine.missing(self)[:1]:
            return []  # 지금 묻는 항목을 다시 말한 것은 정정이 아니라 답이다(다시 묻지 않는다, 2026-10-31 통화)
        side = {"sender_address": "sender", "receiver_address": "receiver"}.get(slot)
        if side and f"{side}_phone" in self.from_saved:
            parts = ("address", "address_detail", "geo") if side == "sender" else \
                ("name", "phone", "address", "address_detail", "geo")
            for part in parts:
                setattr(self.order, f"{side}_{part}", None)
            self.from_saved -= {f"{side}_phone", f"{side}_address_detail"}
            if side == "receiver":
                self.pin_rejected["destination"], self.pin_candidates, self.pin_offer = [], [], None
                self.dest_said, self.pin_ask, self.dest_offer = {}, None, None
            else:
                self.origin_offer = None
            return ["order.updated"]
        self.flow.correcting = slot
        return []

    def snapshot_slots(self) -> dict:
        return {**{f: getattr(self.order, f) for f in Order.model_fields}, "pickup_at": self.pickup_at}

    def note_changes(self, before: dict) -> None:
        """이미 채운 항목이 바뀌었으면(정정) 고친 값을 다음 진행 상태에서 한 번 확인한다(§2.5(4))."""
        after = self.snapshot_slots()
        for name, old in before.items():
            # 못 찾아 지운 주소는 정정 확인 대신 그 항목을 구간 예외 문구로 다시 묻는다
            # 비워 둔 상세주소("")를 나중에 채운 것은 고친 것이 아니다
            if old in (None, "") or after[name] in (None, old) or name.endswith("_geo"):
                continue
            slot = SLOT_OF.get(name, name)
            self.corrected = (slot, self._shown(slot) or "")
            if "CORRECTED" not in self.flow.notice:
                self.flow.notice.append("CORRECTED")
        if self.flow.correcting and self.corrected and self.corrected[0] == self.flow.correcting:
            self.flow.correcting = None

    # --- 상태 엔진이 쓰는 것 ---

    def field_done(self, name: str) -> bool:
        return self.pickup_at is not None if name == "pickup_at" else self.order.has(name)

    def now_ms(self) -> int:
        """지금의 세션 타임라인 시각(ms). 받아쓰기 시각에서 추정한다. 아직 받은 것이 없으면 통화 시작(0):
        그 전에 옮기는 것은 첫 인사까지뿐이라 첫 질문도 다 듣기 전 답을 가린다(§2.5(1))."""
        return 0 if self.clock_offset is None else int(time.monotonic() * 1000 - self.clock_offset)

    def observe_clock(self, end_ms: int | None) -> None:
        """고객 받아쓰기는 말보다 늦게 오므로 (받은 시각 - 끝 시각)의 가장 작은 값이 실제 차이에 가장 가깝다.
        상담원 받아쓰기는 음성보다 먼저 와서(끝 시각이 미래) 넣으면 시계가 앞서 나간다. 고객 것만 쓴다."""
        if end_ms is not None:
            offset = time.monotonic() * 1000 - end_ms
            self.clock_offset = offset if self.clock_offset is None else min(self.clock_offset, offset)

    def recorded(self) -> list[tuple[str, str]]:
        """음성 모델·백엔드에 보여 줄 기록 값. 저장된 곳에서 온 번호·상세주소와 발신번호는 값 대신 표시만 한다
        (고객이 직접 불러 주지 않은 값을 소리 내 읽지 않게. 실제 값은 임시 주문에 그대로 있다)."""
        labels, out = self.texts.labels, []
        for f in SHOWN:
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
            return None if self.pickup_at is None else spoken_time(datetime.fromisoformat(self.pickup_at),
                                                                    self.received_at())
        return getattr(o, f)

    def received_at(self) -> datetime:
        """전화 받은 시각(한국 시간). 수신 시각을 모르면 지금."""
        try:
            return datetime.fromisoformat(self.incoming_at.replace("Z", "+00:00")).astimezone(KST)
        except (AttributeError, ValueError):
            return datetime.now(KST)

    def text_vars(self) -> dict:
        now = datetime.now(KST)
        received = self.received_at()
        lookup = self.lookup
        orders, index = lookup.get("orders") or [], lookup.get("index", 0)
        found = orders[index] if index < len(orders) else {}
        target = self.target_order or {}
        slot, value = (self.flow.correcting, "") if self.flow.correcting else (self.corrected or (None, ""))
        origin, destination = self.recent_place("origin"), self.recent_place("destination")
        rejected = self.pin_rejected["destination"]
        verifying = self.pin_offer or (rejected[-1] if rejected else None)
        return {
            "company": self.cfg.business.company_name,
            "parcel_no": (self.result or {}).get("parcelNo") or "",
            "parcel_count": len(self.parcels),
            "now": now.strftime("%Y-%m-%d %H:%M"),
            "received": f"{received:%Y-%m-%d %H:%M} ({WEEKDAYS[received.weekday()]}요일)",
            "번호": spoken_phone(self.phone_check),
            "customer_name": self.display_name() or "없음",
            "caller": self.caller or "알 수 없음",
            "customer_type": self.texts.customer_types[self.customer_type],
            # 다이어그램 문구의 {…}
            "성함": self.display_name() or "",
            "기존 출발지": origin.address if origin else "",
            "도착지 주소": destination.address if destination else "",
            "수신인": verifying.name if verifying else "",  # 확인 중인 핀, 아니라고 한 뒤(B11)에는 그 핀의 받는 분
            "후보": "·".join(self.pin_labels()),
            # 운임 안내는 접수 목록에 담은 뒤(확정 뒤)에 나가므로, 받는 중인 택배가 비었으면 방금 담은 택배의 운임
            "운임": f"{fare:,}" if (fare := self.parcel_fare(
                self.parcels[-1] if self.parcels and not self.order.model_dump(exclude_none=True) else self.order)) else "",
            "월": now.month,
            "일": now.day,
            "받는 분": found.get("receiver_name") or lookup.get("name") or "",
            "주소": found.get("receiver_address") or "",
            "배송 상태": self.texts.status_names.get(target.get("status"), target.get("status") or ""),
            "업무": self.texts.task_names.get(self.flow.task or "", ""),
            "항목": self.texts.correction_labels.get(slot or "", ""),
            "새 값": value,
            # 접수 전 되읽기(A_CONFIRM)
            "출발지": self._place("sender"),
            "받는 분 성함": self.order.receiver_name or "",
            "도착지": self._place("receiver"),
            "물품": self._shown("item") or "",
            "물품 가액": self._shown("item_price") or "",
            "수거 시각": self._shown("pickup_at") or "",
        }

    def _place(self, side: str) -> str:
        """되읽을 주소: 고객이 말한 상세주소는 붙이고, 주소록·최근 접수에서 온 상세주소는 읽지 않는다."""
        address, detail = getattr(self.order, f"{side}_address") or "", getattr(self.order, f"{side}_address_detail")
        return f"{address} {detail}" if detail and f"{side}_address_detail" not in self.from_saved else address

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
                                               self.payment_method, self.pickup_at, parcels,
                                               [self.parcel_fare(p) for p in parcels])
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
        """접수를 시도했으면 마무리 안내: ACCEPTED만 접수 완료, 개인 카드 결제 대기(notPaid)는 결제 뒤 접수,
        그 밖(결제 완료 후 접수 중·접수 실패·미완료·응답 없음)은 확인 후 연락."""
        if self.result_body is None:
            return None
        return {"ACCEPTED": "accepted", "notPaid": "not_paid"}.get((self.result or {}).get("status"), "pending")

    def end_outcome(self) -> str:
        """통화가 끝날 때 보낼 결과. 상담원에게 넘긴 통화는 접수한 택배가 있어도 접수하지 않고 미완료로 넘긴다."""
        if self.refer_requested.is_set():
            return "INCOMPLETE"
        return "COMPLETE" if self.parcels and self.complete_ready() else "INCOMPLETE"

    def complete_ready(self) -> bool:
        """접수(COMPLETE)에 필요한 값이 다 있음. 주소의 지번·좌표 등이나 배송비(요금표)를 모르면 임의 값 없이 미완료로 둔다."""
        return bool(self.payment_method and self.pickup_at and (self.customer_seq or self.customer_name)
                    and all(p.sender_geo and p.receiver_geo and self.parcel_fare(p) for p in self.parcels))

    # --- 배송비·결제 방식 ---

    def parcel_fare(self, order: Order) -> int | None:
        """택배 하나의 배송비(notifiedPrice) = 규격별 개수 × 요금표([fare]). 요금이 없는 규격·기타 물품이 있거나
        물품이 없으면 모른다(None): 금액을 지어 말하거나 보내지 않는다.
        shortcut: 규격·개수만 본다(거리·무게 할증 없음). 백엔드나 운영이 요금 규칙을 주면 그것으로 바꾼다."""
        fare = self.cfg.fare
        total = 0
        for name, field_ in (("document", "document_count"), ("small_box", "small_box_count"),
                             ("medium_box", "medium_box_count"), ("big_box", "big_box_count")):
            count = getattr(order, field_) or 0
            if count:
                if getattr(fare, name) is None:
                    return None
                total += count * getattr(fare, name)
        return total if total and not order.other_item else None

    def payment_choice(self) -> str | None:
        """결제 방식: 후불(월결제 credit·부서 그룹결제 groupBilling) 자격이 하나면 그것, 둘 다면 None(고객에게 묻는다),
        후불 자격이 없으면 개인 카드(billing). 백엔드가 접수 때 자격을 다시 검사한다.
        TODO(flow): 다이어그램은 결제 분기 보류(MVP 현장 결제)인데 백엔드에 현장 결제가 없어 정한 규칙(2026-10-31 결정)."""
        postpaid = [m for m in ("credit", "groupBilling") if m in self.payment_methods]
        if len(postpaid) == 1:
            return postpaid[0]
        return None if postpaid else "billing"

    async def finish(self) -> None:
        """통화가 끝나면 결과를 한 번 보낸다. 이미 보낸 통화는 같은 키로 확인만(접수 결과가 확정되지 않았을 때).
        확정 지연 중인 전이는 실행하지 않고 버린다(§2.5(8))."""
        self.flow.pending = None
        await self.send_result(self.result_body["outcome"] if self.result_body else self.end_outcome())

    # --- 도구가 요청하는 통화 조작(실행은 sideband 쪽) ---

    def request_hangup(self) -> None:
        self.end_requested_at = time.monotonic()
        self.hangup_requested.set()

    def request_refer(self) -> None:
        self.end_requested_at = time.monotonic()
        self.refer_requested.set()

    # --- 관제 기록 ---

    def add_transcript(self, speaker: str, delta: str, start_ms: int | None = None, end_ms: int | None = None) -> None:
        """문장 경계·item ID가 없으므로 말하는 쪽의 마지막 말풍선에 이어 붙인다. 겹쳐 말해도 쪼개지지 않게,
        그 말풍선이 맨 끝이거나 직전 조각과의 간격이 짧으면 이어 붙이고, 아니면 새 말풍선(말 차례가 바뀜)."""
        if speaker == "customer":
            self.observe_clock(end_ms)
        last = next((b for b in reversed(self.transcript) if b["speaker"] == speaker), None)
        gap_ok = start_ms is not None and last is not None and last["end_ms"] is not None \
            and start_ms - last["end_ms"] <= self.cfg.monitor.bubble_gap_ms
        if last is not None and (last is self.transcript[-1] or gap_ok):
            last["text"] += delta
            last["end_ms"] = end_ms if end_ms is not None else last["end_ms"]
        else:
            self.transcript.append({"speaker": speaker, "text": delta, "at": time.time(), "end_ms": end_ms})
        if speaker == "agent":
            self.last_output_at = self.agent_text_at = time.monotonic()
            self.agent_deltas = [*self.agent_deltas[-MAX_AGENT_DELTAS + 1:], (delta, start_ms, end_ms)]
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
            "customer_seq": self.customer_seq,
            "status": self.status,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "end_reason": self.end_reason,
            "pbx_ended": self.pbx_ended,
            "stage": self.flow.stage,
            "task": self.flow.task,
            "fail_count": self.fail_count,
            "history": self.flow.history,
            "order": self.order.model_dump(),
            "address": self.address_results,
            "fare": self.parcel_fare(self.order),  # 서버 요금표로 계산한 받는 중인 택배의 배송비(모르면 None)
            # 접수 완료(A_DONE)해 담은 택배: 받는 중인 택배(order)는 담은 뒤 비우므로 확정 내용은 여기서 본다
            "parcels": [{**p.model_dump(), "fare": self.parcel_fare(p)} for p in self.parcels],
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
