"""업무 판정 assess(state, policy) — 순수 함수. 질문 순서를 정하지 않고 사실만 판정한다(conversation-state.md §6).

무엇이 끝났고 무엇이 빠졌는지, gate(되읽기) 개방 여부, 재질문 한도 초과만 돌려준다. 무엇을 어떻게 물을지는 Live가
정책에 따라 정한다.
"""

from dataclasses import dataclass

from app.domain.address_book import origin_confirmation, sender_change_next
from app.domain.state import ConversationState, FieldStatus, Geo
from app.domain.store import pending_reconfirm
from app.policy.model import Policy



@dataclass(frozen=True)
class StageStatus:
    stage: str
    complete: bool
    missing: tuple[str, ...]       # 필수인데 VALID 아님(받는 순서대로)
    blocked: tuple[str, ...]       # INVALID·PENDING_CHOICE


@dataclass(frozen=True)
class Assessment:
    stage: str                       # 지금 단계(정책 단계 id, 또는 조회·취소 등 업무 이름)
    stages: dict[str, StageStatus]   # 수집 단계별
    missing: tuple[str, ...]         # 현재 택배·통화의 빠진 항목 전체(받는 순서)
    readback_ready: bool             # 현재 택배 필수 전부 VALID + 수거 일시 VALID
    payment_auto: str | None         # 묻지 않고 정한 결제 방식(auto_payment). 없으면 미정
    attempts_exceeded: tuple[str, ...]
    parcels_pending_reconfirm: tuple[str, ...]


def _field(state: ConversationState, name: str):
    if name == "pickup_at":
        return state.pickup_at
    if name == "payment":
        return state.payment
    return state.current[name] if state.current else None


def auto_payment(methods: tuple[str, ...]) -> str | None:
    """결제 방식은 묻지 않는다(사용자 결정 2026-11-05): 그룹결제 > 월결제 > 하나뿐인 방식. 없으면 미정(기본 billing 금지)."""
    for m in ("groupBilling", "credit"):
        if m in methods:
            return m
    return methods[0] if len(methods) == 1 else None


def assess(state: ConversationState, policy: Policy) -> Assessment:
    stages: dict[str, StageStatus] = {}
    missing: list[str] = []
    collecting = state.current is not None and not state.current.empty() or state.editing is not None
    items_blocked = state.unassigned_item_issues or state.current and (
        state.current.item_issues or state.current.box_size_pending)
    documents_only = state.current is not None and state.current.documents_only()
    for s in policy.collect_stages():
        m, b = [], []
        for name in s.required:
            if name == "item_price" and documents_only:
                continue
            f = _field(state, name)
            blocked = (name == "items" and items_blocked
                       or name == "receiver_phone" and state.current and state.current.receiver_phone_pending)
            if blocked or f is None or not f.valid:
                m.append(name)
            if blocked or f is not None and f.status in (FieldStatus.INVALID, FieldStatus.PENDING_CHOICE):
                b.append(name)
        stages[s.id] = StageStatus(s.id, not m, tuple(m), tuple(b))
        missing += m

    readback_ready = state.current is not None and not missing
    if state.intent is None:
        stage = "intent"
    elif state.intent != "order":
        stage = state.intent
    elif origin_confirmation(state) or sender_change_next(state) in ("sender_address", "sender_address_detail"):
        stage = "address"
    elif collecting and missing:
        stage = next(s.id for s in policy.collect_stages() if not stages[s.id].complete)
    elif collecting:
        stage = "readback"
    elif not state.parcels:
        stage = "sender"
    elif not state.no_more_parcels:
        stage = "more_parcels"
    else:
        stage = "closing"

    fields = [(n, _field(state, n)) for n in policy.fields]
    exceeded = tuple(n for n, f in fields if f is not None and f.attempts >= policy.reask.max_attempts
                     and (not f.valid or n == "receiver_phone" and state.current.receiver_phone_pending)
                     and not (n == "item_price" and documents_only))
    # 빠진 항목은 받는 중이거나, 접수 업무인데 아직 담은 택배가 없을 때만(담은 뒤 마무리 단계에서 전부 빠진 것처럼 보이지 않게)
    show_missing = collecting or (state.intent == "order" and not state.parcels)
    return Assessment(stage, stages, tuple(missing) if show_missing else (), readback_ready,
                      auto_payment(state.customer.payment_methods), exceeded, tuple(pending_reconfirm(state)))


def area_label(address: str | None, geo: Geo | None) -> str | None:
    """확인 때 주소 대신 말하는 동 이름. 보정 실패로 geo가 없으면 건물번호를 뺀 주소(도로명까지)."""
    if geo is not None and geo.dong_name:
        return geo.dong_name
    return address.rsplit(" ", 1)[0] if address else None


def readback_facts(snapshot: dict) -> dict[str, str]:
    """Live에 줄 확인 내용(S15P31D109-164, 사용자 결정 2026-11-09): 보내는 분·받는 분 성함과 동 이름만. 주소·연락처·상세주소·
    물품·가액은 다시 읽지 않는다(두 주소는 confirm_route로 이미 확인했다는 전제)."""
    out = {"sender_name": snapshot.get("sender_name"),
           "from": area_label(snapshot.get("sender_address"), snapshot.get("sender_geo")),
           "receiver_name": snapshot.get("receiver_name"),
           "to": area_label(snapshot.get("receiver_address"), snapshot.get("receiver_geo"))}
    return {k: v for k, v in out.items() if v}
