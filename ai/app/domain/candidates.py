"""후보 보관과 선택 반영(Decision pick → 서버 상태). 모델에는 이름표만 준다(delegation.md §2)."""

from app.domain.rules import normalize_phone
from app.domain.state import CandidateSet, ConversationState, Place, Source
from app.domain.store import open_for_edit

ROLE_FIELDS = ("name", "phone", "address", "address_detail")


def offer(state: ConversationState, kind: str, labels: tuple[str, ...], items: tuple) -> None:
    state.candidates = CandidateSet(kind, labels, items)
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
            value = getattr(place, part)
            if part == "phone":
                # 주소록·이전 주문에는 11자리 계약 전 번호가 남아 있다(핀 0112344155 → 초안 PATCH 400). 맞지 않으면 다시 묻게 둔다
                value = normalize_phone(value or "")
                if value is None:
                    continue
            state.record(f"receiver_{part}", value, place.source or Source.PIN)
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
