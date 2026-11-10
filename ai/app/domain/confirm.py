"""확인 요청과 확정 관문(conversation-state.md §5). 택배 담기(kind=parcel)를 다룬다.
결제·취소·상담원 확인은 같은 관문을 쓰며 해당 단계(S3·S5)에서 kind를 붙인다.

흐름: issue_parcel_confirmation(readback_ready일 때) → 고객 발화 끝 Decision confirm → check_gate(G1~G5) →
commit_delay 뒤 commit_parcel(G1·G2 재검사) / no·change → release.
G6(같은 발화에 위임이 있으면 그 완료까지 보류)은 발화·위임을 묶는 세션 계층(S5)이 이 함수들을 부르기 전에 처리한다.
"""

import re
from dataclasses import dataclass

from app.domain.assess import assess
from app.domain.state import ConversationState, PendingConfirmation, draft_snapshot, snapshot_hash
from app.domain.store import add_confirmed
from app.policy.model import Policy


@dataclass(frozen=True)
class Utterance:
    """서버가 전사 delta를 발화 끝(utterance_gap_ms) 규칙으로 묶은 것(delegation.md §3.1)."""
    utterance_id: int
    start_ms: int          # 세션 타임라인(전사 delta start_ms)
    end_ms: int
    t_start: float         # 첫 delta 서버 수신 시각(서버 시계) — issued_t와 비교
    text: str = ""         # AI 발화면 G3에서 확인 질문으로 끝났는지 본다(S5 실통화: 되읽기 도중 "네"로 담김)


QUESTION_END = re.compile(r"(\?|까요|나요|세요|시죠|죠|습니까|십니까|가요|래요|을까|맞아요|맞으세요|맞습니까)[\s.?!…~]*$")
PARCEL_READBACK_START = re.compile(r"(?:네[,，.]?)?접수내용(?:을)?확인(?:을)?부탁드")


def asks(text: str) -> bool:
    return bool(QUESTION_END.search(text.strip()))


@dataclass(frozen=True)
class ConfirmAnswer:
    choice: str                        # yes · no · change · proceed · not_answer
    probabilities: dict[str, float]


@dataclass(frozen=True)
class GateResult:
    ok: bool
    code: str | None = None            # error-recovery.md §2 확인·Decision 코드


def _parcel_snapshot(state: ConversationState) -> dict:
    return draft_snapshot(state.current)


def _versions(state: ConversationState, policy: Policy) -> dict[str, int]:
    return {n: state.field_of(n).version for s in policy.collect_stages() for n in s.required}


def issue_parcel_confirmation(state: ConversationState, policy: Policy, now_t: float) -> PendingConfirmation | None:
    """readback_ready이면 현재 값으로 확인 대기를 연다. 같은 내용의 대기가 이미 있으면 그대로 돌려준다."""
    if not assess(state, policy).readback_ready:
        return None
    snap = _parcel_snapshot(state)
    h = snapshot_hash(snap)
    if state.pending and not state.pending.done and state.pending.kind == "parcel" and state.pending.snapshot_hash == h:
        return state.pending
    v = state.bump()
    state.pending = PendingConfirmation(id=f"pc{v}", kind="parcel", snapshot=snap, snapshot_hash=h,
                                        field_versions=_versions(state, policy), asked_version=v, issued_t=now_t,
                                        parcel_id=state.editing)
    return state.pending


def issue_cancel_confirmation(state: ConversationState, now_t: float) -> PendingConfirmation | None:
    """취소 대상(state.selected_order)이 정해졌으면 취소 확인 대기를 연다(README "반드시 지킬 것" 2: C_CANCEL_CONFIRM)."""
    target = state.selected_order
    if not target:
        return None
    h = snapshot_hash(target)
    if state.pending and not state.pending.done and state.pending.kind == "cancel" and state.pending.snapshot_hash == h:
        return state.pending
    v = state.bump()
    state.pending = PendingConfirmation(id=f"pc{v}", kind="cancel", snapshot=dict(target), snapshot_hash=h,
                                        field_versions={}, asked_version=v, issued_t=now_t)
    return state.pending


def _same_snapshot(state: ConversationState, policy: Policy, p: PendingConfirmation) -> bool:
    if p.kind == "cancel":
        return state.selected_order is not None and snapshot_hash(state.selected_order) == p.snapshot_hash
    return (state.current is not None and _versions(state, policy) == p.field_versions
            and snapshot_hash(_parcel_snapshot(state)) == p.snapshot_hash)


def check_gate(state: ConversationState, policy: Policy, pending_id: str, answer: ConfirmAnswer,
               customer: Utterance, prev_ai: Utterance | None, *, latest_applied_utterance: int | None,
               closed: bool) -> GateResult:
    """confirm=yes 결과가 확정으로 이어져도 되는가(G1~G5). pending_id = Decision을 부를 때의 pending id."""
    p = state.pending
    if closed:
        return GateResult(False, "CALL_ENDING")                                       # G5
    if p is None or p.id != pending_id or p.done or (
            latest_applied_utterance is not None and customer.utterance_id < latest_applied_utterance):
        return GateResult(False, "DECISION_STALE")                                    # G1
    confidence = answer.probabilities.get(answer.choice, 0.0)
    change = answer.probabilities.get("change", 0.0)
    if answer.choice not in ("yes", "proceed") or confidence < policy.confirm.yes_min or change >= policy.confirm.change_max:
        return GateResult(False, "CONFIRM_UNCLEAR")                                   # G4
    if prev_ai is None or prev_ai.t_start < p.issued_t:
        return GateResult(False, "CONFIRM_BEFORE_READBACK_END")                       # G3
    if answer.choice == "proceed":
        # 명시적인 접수 지시는 이번 택배의 되읽기가 시작된 뒤에만 중간 확정에 쓴다.
        if p.kind != "parcel" or not PARCEL_READBACK_START.match("".join(prev_ai.text.split())):
            return GateResult(False, "CONFIRM_BEFORE_READBACK_END")
    elif customer.start_ms < prev_ai.end_ms - policy.confirm.answer_after_readback_tolerance_ms \
            or (prev_ai.text and not asks(prev_ai.text)):
        return GateResult(False, "CONFIRM_BEFORE_READBACK_END")
    if not _same_snapshot(state, policy, p):
        return GateResult(False, "CONFIRM_SNAPSHOT_CHANGED")                          # G2
    return GateResult(True)


def commit_parcel(state: ConversationState, policy: Policy, pending_id: str) -> str | None:
    """확정 지연 뒤 실행. 잠금 안에서 G1·G2를 다시 보고 보관소에 넣는다. 담은 택배 id, 조건이 깨졌으면 None."""
    p = state.pending
    if (p is None or p.id != pending_id or p.done or p.kind != "parcel"
            or state.unassigned_item_issues or state.current and state.current.item_issues
            or not _same_snapshot(state, policy, p)):
        return None
    pid = add_confirmed(state, dict(p.snapshot), parcel_id=p.parcel_id)
    state.pending = None
    return pid


def take_cancel(state: ConversationState, policy: Policy, pending_id: str) -> dict | None:
    """확정 지연 뒤 취소 실행 직전: G1·G2 재검사 후 대기를 닫고 취소할 대상을 돌려준다(실행은 서버 전용 cancel_parcel)."""
    p = state.pending
    if p is None or p.id != pending_id or p.done or p.kind != "cancel" or not _same_snapshot(state, policy, p):
        return None
    state.pending, state.selected_order = None, None
    state.bump()
    return p.snapshot


def release(state: ConversationState, pending_id: str) -> bool:
    """no·change: 확인 대기를 즉시 해제(확정 지연 없이, delegation.md §4.1 R3)."""
    if state.pending is None or state.pending.id != pending_id:
        return False
    state.pending = None
    state.awaiting_fix = True  # 고친 값이 기록될 때까지 되읽기를 다시 열지 않는다(record_fields가 푼다)
    state.bump()
    return True
