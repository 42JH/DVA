"""후보 보관과 선택 반영(Decision pick → 서버 상태). 모델에는 이름표만 준다(delegation.md §2)."""

from typing import Literal

from app.domain.state import CandidateSet, ConversationState, Place, Source
from app.domain.store import open_for_edit

ROLE_FIELDS = ("name", "phone", "address", "address_detail")
DestinationChange = Literal["address", "recipient"]
DESTINATION_CHANGE_FIELDS = {
    "address": ("receiver_address", "receiver_address_detail"),
    "recipient": ("receiver_name", "receiver_phone"),
}
DESTINATION_CLARIFICATIONS = {
    "clarify_recipient": "recipient", "clarify_address": "address", "clarify_candidate": "candidate",
}


def destination_changes(candidates: CandidateSet | None) -> dict[str, tuple[int, DestinationChange]]:
    if candidates is None or candidates.kind != "destination":
        return {}
    return {f"new_{change}_{i + 1}": (i, change) for i, place in enumerate(candidates.items)
            if isinstance(place, Place) and place.source in (Source.PIN, Source.HISTORY)
            for change in ("address", "recipient")}


def buffer_destination_fields(state: ConversationState, given: dict) -> bool:
    """확인 중 들은 받는 곳 값은 현재 후보에 묶어 두고, 답을 받은 뒤 검증한다."""
    candidates = state.candidates
    if state.intent != "order" or not candidates or not candidates.destination_clarification:
        return False
    for part in ROLE_FIELDS:
        field = f"receiver_{part}"
        if field in given:
            candidates.destination_buffer[field] = given.pop(field)
    return True


def offer(state: ConversationState, kind: str, labels: tuple[str, ...], items: tuple, *, total: int | None = None) -> None:
    state.candidates = CandidateSet(kind, labels, items, total)
    state.bump()


def apply_pick(state: ConversationState, label: str) -> bool:
    """고른 후보를 반영한다. destination이면 받는 곳 4필드·geo를, order면 취소 대상을. 모르는 이름표면 False."""
    c = state.candidates
    if c is None or label not in c.labels:
        return False
    item = c.items[c.labels.index(label)]
    if c.kind == "parcel":
        state.candidates = None
        open_for_edit(state, item)
        return True
    if c.kind == "destination":
        place: Place = item
        for part in ROLE_FIELDS:
            state.record(f"receiver_{part}", getattr(place, part), place.source or Source.PIN)
        state.current.receiver_geo = place.geo
    else:
        state.selected_order = item
    state.candidates = None
    state.bump()
    return True


def reject_candidates(state: ConversationState) -> None:
    """pick=none: 후보를 모두 버린다(새로 말하게)."""
    if state.candidates is not None:
        state.candidates = None
        state.bump()


def clear_order_lookup(state: ConversationState) -> None:
    """기존 주문 선택과 진행 중인 조회를 폐기한다."""
    state.order_lookup_id += 1
    state.selected_order = None
    if state.candidates and state.candidates.kind == "order":
        state.candidates = None
    if state.pending and state.pending.kind == "cancel":
        state.pending = None
    state.bump()


def apply_destination_change(state: ConversationState, index: int, change: DestinationChange) -> None:
    """현재 받는 곳 후보에서 고객이 그대로 쓰기로 한 항목만 가져온다."""
    place = state.candidates.items[index]
    kept = ("name", "phone") if change == "address" else ("address", "address_detail")
    for part in ROLE_FIELDS:
        field = f"receiver_{part}"
        value = getattr(place, part)
        if part in kept and (value or part == "address_detail" and value == ""):
            state.record(field, value, place.source)
        else:
            state.clear(field)
    draft = state.current
    draft.receiver_geo = place.geo if change == "recipient" else None
    draft.destination_partial_change = change
    draft.deferred_destination = None
    draft.destination_search_id += 1
    if state.pending and state.pending.kind == "parcel":
        state.pending = None
        state.address_offer = None
    reject_candidates(state)
