"""Business State(conversation-state.md §2). 순수 객체 — SDK·HTTP·BE 필드 이름에 의존하지 않는다.

변경은 CallSession.lock 안에서 이 모듈의 메서드로만 한다. 변경마다 state_version을 1 올리고 바뀐 필드의 version에
그 값을 기록한다(외부 작업 결과·확인의 신선도 판단용, concurrency.md §3).
"""

import hashlib
import json
from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Any, Literal

from app.domain.parcel_items import ItemIssue

PARCEL_FIELDS = ("sender_name", "sender_phone", "sender_address", "sender_address_detail",
                 "receiver_name", "receiver_phone", "receiver_address", "receiver_address_detail",
                 "items", "item_price")
BOX_SIZE_NAMES = {"small": "소형", "medium": "중형", "big": "대형"}
DOCUMENT_ITEM_PRICE = 1


class FieldStatus(StrEnum):
    EMPTY = "empty"                    # 아직 못 들음
    VALID = "valid"                    # 서버 검증 통과
    PENDING_CHOICE = "pending_choice"  # 후보 중 선택 필요
    INVALID = "invalid"                # 검증 실패 — 값 없음, 재질문 대상
    # 담기 확인 완료는 필드 상태가 아니라 ParcelStore의 confirmed_snapshot으로 판단한다


class Source(StrEnum):
    CUSTOMER = "customer"; CALLER_ID = "caller_id"; PROFILE = "profile"
    HISTORY = "history"; PIN = "pin"; COMPANY = "company"; RESOLVER = "resolver"
    SERVER = "server"  # 서버가 정한 값(기본 수거 시각)


@dataclass(frozen=True)
class Items:
    """물품: 규격별 수량 또는 기타 물품 설명(BE documentCount·smallBoxCount·mediumBoxCount·bigBoxCount·otherItemDescription)."""
    document_count: int = 0
    small_box_count: int = 0
    medium_box_count: int = 0
    big_box_count: int = 0
    other_item: str | None = None

    def any(self) -> bool:
        return bool(self.document_count or self.small_box_count or self.medium_box_count or self.big_box_count
                    or self.other_item)

    def documents_only(self) -> bool:
        return bool(self.document_count and not (self.small_box_count or self.medium_box_count or self.big_box_count
                                                 or self.other_item))


@dataclass(frozen=True)
class BoxProposal:
    size: Literal["small", "medium", "big"]
    count: int
    issued_t: float

    @property
    def label(self) -> str:
        return f"{BOX_SIZE_NAMES[self.size]} 박스 {self.count}개"


@dataclass(frozen=True)
class Geo:
    """주소DB 보정 결과(지번·동명·우편번호). 좌표는 BE 계약에서 제거됨."""
    jibun_address: str
    dong_name: str
    postal_code: str


@dataclass(frozen=True)
class Place:
    """받는 곳 후보(주소록 핀·이전 도착지·기업 사원). 주소록 값은 먼저 읽지 않고 고객이 물으면 get_state로 준다."""
    name: str
    phone: str
    address: str
    address_detail: str
    geo: Geo | None = None
    source: "Source" = None  # PIN · HISTORY · COMPANY


@dataclass(frozen=True)
class CandidateSet:
    """서버가 보관하는 후보(delegation.md §2: 모델·Decision에는 이름표만). Decision pick으로 고른다."""
    kind: Literal["destination", "order", "parcel"]   # parcel: 고칠 담은 택배(P5)
    labels: tuple[str, ...]
    items: tuple[Any, ...]         # destination: Place, order: 조회 결과 dict
    total: int | None = None
    destination_clarification: Literal["recipient", "address", "candidate"] | None = None
    destination_buffer: dict[str, str] = field(default_factory=dict, compare=False)


@dataclass
class FieldState:
    value: Any = None
    status: FieldStatus = FieldStatus.EMPTY
    source: Source | None = None
    version: int = 0                      # 마지막 변경 시점의 state_version
    candidates: tuple[str, ...] = ()      # PENDING_CHOICE일 때 이름표
    attempts: int = 0                     # 검증 실패·재질문 횟수
    code: str | None = None               # 마지막 실패 사유(INVALID 또는 정정 실패)
    previous: Any = None                  # 직전 값(정정 안내·로그용)

    @property
    def valid(self) -> bool:
        return self.status == FieldStatus.VALID


@dataclass
class ParcelDraft:
    """받는 중인 택배 1개."""
    fields: dict[str, FieldState] = field(default_factory=lambda: {f: FieldState() for f in PARCEL_FIELDS})
    sender_geo: Geo | None = None
    receiver_geo: Geo | None = None
    client_comment: str | None = None     # 묻지 않고, 말하면 기록
    item_issues: dict[str, ItemIssue] = field(default_factory=dict)
    box_proposal: BoxProposal | None = None  # 고객이 확인하기 전에는 물품 수량으로 보내지 않는다
    box_size_pending: bool = False
    item_addition_turns: dict[str, int] = field(default_factory=dict)
    client_parcel_id: str | None = None   # 같은 통화의 배송 초안과 연결하는 UUID
    sender_name_for_parcel: bool = False  # 등록 이름과 별도로 이번 택배에만 쓰는 보내는 분 성함
    ask_customer_name_save: bool = False # 고객의 등록 이름도 바꿀지 아직 정하지 않음
    save_sender_name: bool = False       # 고객이 이번 택배의 새 이름을 등록 이름에도 쓰겠다고 답함
    sender_name_scope_pending: str | None = None  # 범위를 먼저 말했고 새 성함을 기다리는 중
    sender_address_change: bool = False  # 접수 시작에서 새 발송 주소를 먼저 받는 중
    deferred_destination: CandidateSet | None = None  # 보내는 분 정보를 받은 뒤 제시할 받는 곳
    destination_search_id: int = 0
    destination_partial_change: Literal["address", "recipient"] | None = None
    places: dict[str, tuple[str, str]] = field(default_factory=dict)  # 역할 -> (건물명·상호명으로 찾은 기본주소, 그 이름)

    def __getitem__(self, name: str) -> FieldState:
        return self.fields[name]

    def place_detail(self, role: str, detail: str | None) -> str | None:
        """기본주소를 건물명·상호명으로 찾았으면 상세주소 앞에 검색이 찾은 이름을 붙인다("국회의사당 3층", 없다고 하면 이름만).
        그 뒤 기본주소가 바뀌었거나 이미 이름으로 시작하면 그대로 둔다."""
        address, name = self.places.get(role, ("", ""))
        field_ = self.fields[f"{role}_address"]
        if detail is None or not name or not field_.valid or field_.value != address                 or detail.replace(" ", "").startswith(name.replace(" ", "")):
            return detail
        return f"{name} {detail}".strip()

    def documents_only(self) -> bool:
        items = self["items"]
        return not self.box_size_pending and items.valid and items.value.documents_only()

    def declared_item_price(self) -> int | None:
        """서류용 1원은 접수 값에서만 계산해 다른 물품에 넘어가지 않게 한다."""
        if self.documents_only():
            return DOCUMENT_ITEM_PRICE
        price = self["item_price"]
        return price.value if price.valid else None

    def empty(self) -> bool:
        return not self.item_issues and not self.box_size_pending and self.box_proposal is None and all(
            f.status == FieldStatus.EMPTY or f.source == Source.CALLER_ID for f in self.fields.values())


@dataclass
class StoredParcel:
    parcel_id: str
    draft: ParcelDraft
    confirmed_snapshot: dict | None       # 마지막으로 고객이 확인한 내용(P5 후속 B안)
    confirmed_hash: str | None


@dataclass(frozen=True)
class PendingConfirmation:
    id: str
    kind: Literal["parcel", "payment", "cancel", "agent"]
    snapshot: dict                        # 되읽은 값 그대로(담기·실행의 입력)
    snapshot_hash: str
    field_versions: dict[str, int]
    asked_version: int
    issued_t: float                       # 발급 시각(서버 시계). 되읽기 발화가 이 뒤에 시작돼야 한다(G3)
    parcel_id: str | None = None          # 담은 택배를 수정 중이면 그 택배
    done: bool = False


@dataclass
class Customer:
    status: str | None = None              # REGISTERED · UNREGISTERED · WITHDRAWN(최근 고객 확인)
    initial_status: str | None = None      # 통화 시작 때(분석 isNewCustomer)
    customer_seq: int | None = None
    name: str | None = None
    caller_phone: str | None = None
    payment_methods: tuple[str, ...] = ()  # BE availablePaymentMethods
    call_session_seq: int | None = None    # 2단계 고객 확인으로 받은 통화 번호(조회·취소·주소 이력의 고객 범위)
    places: tuple[Place, ...] = ()         # 받는 곳 후보 원천(최근 도착지 → 주소록 순)
    default_address: str | None = None     # 고객 기본 주소 도로명(인사·주소 저장 비교용)
    default_address_detail: str | None = None  # 기본 주소 상세(없으면 ""). 상세만 바뀌어도 저장을 제안한다
    origin_place: "Place | None" = None    # 출발지 후보: 고객 기본 주소(PROFILE), 없으면 이전 접수 출발지(HISTORY)


@dataclass
class ConversationState:
    customer: Customer = field(default_factory=Customer)
    intent: str | None = None             # order | lookup | cancel | inquiry | agent | end
    current: ParcelDraft | None = None
    editing: str | None = None            # current가 담은 택배를 꺼낸 것이면 그 parcel_id(P5)
    unassigned_item_issues: dict[str, ItemIssue] = field(default_factory=dict)
    latest_item_utterance_id: int = 0
    parcels: list[StoredParcel] = field(default_factory=list)
    discarded_parcel_ids: set[str] = field(default_factory=set)  # 백엔드 취소가 필요한 제외 항목
    pickup_at: FieldState = field(default_factory=FieldState)
    payment: FieldState = field(default_factory=FieldState)
    pending: PendingConfirmation | None = None
    awaiting_fix: bool = False             # no·change로 확인 대기를 푼 뒤 고친 값을 기다림(그동안 되읽기를 다시 열지 않는다)
    candidates: CandidateSet | None = None
    selected_order: dict | None = None     # 취소 대상(조회 후보에서 고른 것)
    state_version: int = 0
    no_more_parcels: bool = False          # 고객이 더 보낼 택배가 없다고 함(more_parcels 단계 완료)
    order_submitted: bool = False          # 결과 전송 시작 — 이후 택배 수정·추가 없음(접수 후 수정 불가)
    order_cancelled: bool = False          # 고객이 이번 접수 자체를 취소(CANCELLED)
    agent_transferred: bool = False       # 상담원 연결 요구(분석 hasHandoffRequest — 연결 성공 여부 아님)
    callback_offered: bool = False        # 상담원 근무 시간 밖이라 콜백을 제안함(답을 기다림)
    callback_requested: bool = False      # 고객이 콜백에 동의(분석 hasCallbackRequest)
    address_offer: dict | None = None     # 저장 대상 {name, sender, receiver, parcel(담은 택배 id)}. 담을 때 묻지 않고 저장
    origin_offered: bool = False          # 출발지 후보에서 보내는지 물음(인사 또는 접수 시작 때)
    origin_mentioned_in_greeting: bool = False  # 인사에서 발송 주소를 언급함(등록 주소와의 대조 결과와 별개)
    origin_answer: bool | None = None     # 그 출발지에서 보냄 = True, 다른 곳 = False
    origin_applied: bool = False          # 보내는 분 미리 채우기를 마침
    result_accepted: bool = False          # 통화 결과가 ACCEPTED로 확정됨
    cancel_done: bool = False              # 이번 통화에서 택배 취소가 완료됨
    _next_parcel: int = 1

    # --- 변경(잠금 안에서만) ---
    def bump(self) -> int:
        self.state_version += 1
        return self.state_version

    def field_of(self, name: str) -> FieldState:
        if name == "pickup_at":
            return self.pickup_at
        if name == "payment":
            return self.payment
        if self.current is None:
            self.current = ParcelDraft()
            if self.customer.caller_phone:  # 보내는 분 연락처 = 발신번호(묻지도 읽지도 않는다)
                f = self.current["sender_phone"]
                f.value, f.status, f.source, f.version = (self.customer.caller_phone, FieldStatus.VALID,
                                                          Source.CALLER_ID, self.bump())
            # 등록 고객 성함 = 발신번호로 확인한 고객 이름(연락처처럼 서버가 채움, 빈 택배 판정에서 빠짐). 고객이 다른 이름을 말하면 덮인다
            if self.customer.customer_seq and self.customer.name:
                f = self.current["sender_name"]
                f.value, f.status, f.source, f.version = (self.customer.name, FieldStatus.VALID,
                                                          Source.CALLER_ID, self.bump())
        return self.current[name]

    def record(self, name: str, value: Any, source: Source = Source.CUSTOMER) -> bool:
        """검증을 통과한 값 기록. 바뀌었으면 True(같은 값이면 버전을 올리지 않는다)."""
        f = self.field_of(name)
        if f.valid and f.value == value and f.source == source:
            return False
        v = self.bump()
        f.previous = f.value if f.valid else f.previous
        f.value, f.status, f.source, f.version, f.code, f.candidates = value, FieldStatus.VALID, source, v, None, ()
        return True

    def record_invalid(self, name: str, code: str) -> None:
        """검증 실패. 이미 VALID면 **기존 값을 유지**하고 실패만 센다(잘못 들은 정정으로 맞는 값을 잃지 않게)."""
        f = self.field_of(name)
        v = self.bump()
        f.attempts += 1
        f.code = code
        if not f.valid:
            f.value, f.status, f.version = None, FieldStatus.INVALID, v

    def record_choice(self, name: str, candidates: tuple[str, ...]) -> None:
        f = self.field_of(name)
        f.status, f.candidates, f.version = FieldStatus.PENDING_CHOICE, candidates, self.bump()

    def clear(self, name: str) -> None:
        """주소가 바뀌면 같은 쪽 상세주소를 비우는 등(facts.cleared)."""
        f = self.field_of(name)
        if f.status != FieldStatus.EMPTY:
            f.previous = f.value if f.valid else f.previous
            f.value, f.status, f.source, f.version = None, FieldStatus.EMPTY, None, self.bump()

    def new_parcel_id(self) -> str:
        pid = f"p{self._next_parcel}"
        self._next_parcel += 1
        return pid


def snapshot_hash(snapshot: dict) -> str:
    return hashlib.sha256(json.dumps(snapshot, ensure_ascii=False, sort_keys=True, default=_plain).encode()).hexdigest()


def _plain(o):
    if isinstance(o, (Items, Geo)):
        return o.__dict__
    raise TypeError(type(o).__name__)


def draft_snapshot(draft: ParcelDraft) -> dict:
    """택배의 현재 VALID 값(되읽기·확인·전송의 단위). geo·요청사항 포함, 상태·버전은 뺀다."""
    out = {name: f.value for name, f in draft.fields.items() if f.valid}
    if (price := draft.declared_item_price()) is not None:
        out["item_price"] = price
    out |= {"sender_geo": draft.sender_geo, "receiver_geo": draft.receiver_geo, "client_comment": draft.client_comment}
    return out


def copy_draft(draft: ParcelDraft) -> ParcelDraft:
    return replace(draft, fields={k: replace(v) for k, v in draft.fields.items()},
                   item_issues=draft.item_issues.copy(), box_proposal=None, deferred_destination=None,
                   item_addition_turns=draft.item_addition_turns.copy(), places=draft.places.copy())
