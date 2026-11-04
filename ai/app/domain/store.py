"""담은 택배 보관소(ParcelStore, P5): 접수(통화 결과 전송) 전까지 통화 안에서 수정할 수 있다.

수정 중(미확인)인 택배는 현재 내용이 마지막 확인 스냅샷과 다르다. 그 상태로 통화가 끝나면 마지막 확인 스냅샷을 보낸다
(P5 후속 B안, decisions.md).
"""

from app.domain.state import ConversationState, StoredParcel, copy_draft, draft_snapshot, snapshot_hash


def add_confirmed(state: ConversationState, snapshot: dict, parcel_id: str | None = None) -> str:
    """확정된 current를 보관소에 넣는다(수정 중이던 택배면 그 항목을 갱신). current를 비운다."""
    draft = copy_draft(state.current)
    h = snapshot_hash(snapshot)
    existing = next((p for p in state.parcels if p.parcel_id == parcel_id), None) if parcel_id else None
    if existing:
        existing.draft, existing.confirmed_snapshot, existing.confirmed_hash = draft, snapshot, h
        pid = existing.parcel_id
    else:
        pid = state.new_parcel_id()
        state.parcels.append(StoredParcel(pid, draft, snapshot, h))
    state.current, state.editing = None, None
    state.bump()
    return pid


def open_for_edit(state: ConversationState, parcel_id: str) -> None:
    """담은 택배를 current로 꺼낸다(confirmed_snapshot은 유지). 진행 중이던 다른 택배는 미확인 항목으로 보관한다."""
    target = next(p for p in state.parcels if p.parcel_id == parcel_id)
    if state.current is not None and not state.current.empty() and state.editing != parcel_id:
        if state.editing:  # 다른 담은 택배를 고치던 중 → 그 항목에 되돌려 둔다(수정 중 상태로)
            prev = next(p for p in state.parcels if p.parcel_id == state.editing)
            prev.draft = copy_draft(state.current)
        else:              # 새로 받던 택배 → 확인 전 항목으로 보관
            state.parcels.append(StoredParcel(state.new_parcel_id(), copy_draft(state.current), None, None))
    state.current, state.editing, state.pending = copy_draft(target.draft), parcel_id, None
    state.bump()


def is_pending_reconfirm(p: StoredParcel) -> bool:
    return p.confirmed_hash is None or snapshot_hash(draft_snapshot(p.draft)) != p.confirmed_hash


def pending_reconfirm(state: ConversationState) -> list[str]:
    """수정 후 아직 다시 확인받지 않은 택배(지금 current로 꺼내 고치는 것 포함)."""
    out = [p.parcel_id for p in state.parcels if is_pending_reconfirm(p) and p.parcel_id != state.editing]
    if state.editing:
        out.append(state.editing)
    return out


def snapshot_for_submit(state: ConversationState) -> list[dict]:
    """전송할 택배: 확인된 항목은 현재 내용, 수정 중 항목은 마지막 확인 스냅샷. 한 번도 확인받지 않은 항목은 뺀다."""
    out = []
    for p in state.parcels:
        if p.parcel_id == state.editing or is_pending_reconfirm(p):
            if p.confirmed_snapshot is not None:
                out.append(p.confirmed_snapshot)
        else:
            out.append(draft_snapshot(p.draft))
    return out
