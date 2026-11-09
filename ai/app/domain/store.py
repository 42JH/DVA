"""담은 택배 보관소(ParcelStore, P5): 접수(통화 결과 전송) 전까지 통화 안에서 수정할 수 있다.

수정 중(미확인)인 택배는 현재 내용이 마지막 확인 스냅샷과 다르다. 그 상태로 통화가 끝나면 마지막 확인 스냅샷을 보낸다
(P5 후속 B안, decisions.md).
"""

from dataclasses import replace

from app.domain.parcel_items import ItemIssue, unclassified_mentions
from app.domain.state import ConversationState, StoredParcel, copy_draft, draft_snapshot, snapshot_hash
from app.policy.model import ParcelItems


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
    if state.editing == parcel_id:
        return
    target = next(p for p in state.parcels if p.parcel_id == parcel_id)
    if state.current is not None and not state.current.empty() and state.editing != parcel_id:
        if state.editing:  # 다른 담은 택배를 고치던 중 → 그 항목에 되돌려 둔다(수정 중 상태로)
            prev = next(p for p in state.parcels if p.parcel_id == state.editing)
            prev.draft = copy_draft(state.current)
        else:              # 새로 받던 택배 → 확인 전 항목으로 보관
            state.parcels.append(StoredParcel(state.new_parcel_id(), copy_draft(state.current), None, None))
    state.current, state.editing, state.pending = copy_draft(target.draft), parcel_id, None
    if state.unassigned_item_issues:
        hold_items(state, state.unassigned_item_issues)
        state.unassigned_item_issues = {}
    state.bump()


def hold_items(state: ConversationState, issues: dict[str, ItemIssue]) -> None:
    """문제가 생긴 택배의 이전 확인으로 제출하는 경로도 닫는다."""
    state.field_of("items")  # 현재 택배가 없으면 생성
    state.current.box_proposal = None
    for key, issue in issues.items():
        if issue.code != "ITEM_MENTION_UNCLEAR" or key not in state.current.item_issues:
            state.current.item_issues[key] = issue
    if state.pending and state.pending.kind == "parcel":
        state.pending = None
        state.address_offer = None
    if state.editing:
        parcel = next(p for p in state.parcels if p.parcel_id == state.editing)
        parcel.confirmed_snapshot = parcel.confirmed_hash = None
    state.bump()


def hold_unclassified_items(state: ConversationState, policy: ParcelItems, utterance_id: int, text: str) -> dict:
    """도구 호출이 늦거나 생략돼도 발화에 나타난 제한 후보를 먼저 보류한다."""
    if state.intent != "order" or state.latest_item_utterance_id >= utterance_id:
        return {}
    issues = {key: replace(issue, utterance_id=utterance_id)
              for key, issue in unclassified_mentions(policy, text).items()}
    if not issues:
        return {}
    state.latest_item_utterance_id = utterance_id
    if (state.current is None or state.current.empty()) and state.parcels:
        if len(state.parcels) > 1:
            for key, issue in issues.items():
                state.unassigned_item_issues.setdefault(key, issue)
            return {"code": "ITEM_PARCEL_UNCLEAR"}
        open_for_edit(state, state.parcels[0].parcel_id)
    hold_items(state, issues)
    return {"code": next(iter(issues.values())).code, "guidance": [issue.guidance for issue in issues.values()]}


def item_issues_pending(state: ConversationState) -> bool:
    return (bool(state.unassigned_item_issues)
            or bool(state.current and state.current.item_issues)
            or any(p.draft.item_issues for p in state.parcels if p.parcel_id != state.editing))


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
    if state.unassigned_item_issues:
        return []  # 어느 택배가 제한 대상인지 모르면 마지막 확인본도 제출할 수 없다
    out = []
    for p in state.parcels:
        if p.draft.item_issues:
            continue
        if p.parcel_id == state.editing or is_pending_reconfirm(p):
            if p.confirmed_snapshot is not None:
                out.append(p.confirmed_snapshot)
        else:
            out.append(draft_snapshot(p.draft))
    return out
