"""도구 결과 형식 ToolOutcome(error-recovery.md §1). Live·Backend는 status·fields·missing·needs만으로 다음 행동을 고른다.
code는 사유 표시·관측·테스트용. 문장 지시는 넣지 않는다(delegation.md §6.1)."""

from dataclasses import dataclass, field
from typing import Literal

from app.domain.address_book import (missing_sender_address, origin_confirmation, receiver_questions_deferred,
                                     sender_change_next)
from app.domain.assess import assess
from app.domain.state import ConversationState, FieldStatus, Items, Place, Source
from app.policy.model import Policy

Status = Literal["ok", "needs_input", "needs_choice", "needs_confirmation", "rejected", "unavailable", "unknown"]
DESTINATION_CHANGE_QUESTIONS = {
    "recipient": "받는 분은 주소록에 있는 그분이 맞으세요?",
    "address": "받는 곳은 주소록에 있는 주소가 맞으세요?",
    "candidate": "어느 후보의 어떤 정보를 그대로 쓰실까요?",
}


@dataclass
class ToolOutcome:
    status: Status
    code: str | None = None
    facts: dict = field(default_factory=dict)
    needs: list[dict] = field(default_factory=list)       # [{field, reason}]
    summary: dict | None = None                            # fields·missing·stage·can_proceed(값 기록 결과에만)

    def to_output(self) -> dict:
        out = {"status": self.status}
        if self.code:
            out["code"] = self.code
        if self.facts:
            out["facts"] = self.facts
        if self.needs:
            out["needs"] = self.needs
        if self.summary:
            out |= self.summary
        return out


def state_summary(state: ConversationState, policy: Policy) -> dict:
    """값 기록·조회 결과에 붙이는 상태 요약. 발송 주소를 고르는 중이면 서버 확인 질문도 준다."""
    a = assess(state, policy)
    fields = {}
    if state.current is not None:
        fields = {n: f.status.value for n, f in state.current.fields.items() if policy.fields[n].kind != "auto"}
    summary = {"stage": a.stage, "fields": fields, "missing": list(a.missing), "can_proceed": a.readback_ready,
               "parcels": len(state.parcels)}
    destination = state.candidates if state.candidates and state.candidates.kind == "destination" else None
    if next_sender := sender_change_next(state):
        summary["sender_change_next"] = next_sender
        summary["can_proceed"] = False
        summary["missing"] = [next_sender] if next_sender in a.missing else []
        if next_sender == "ask_address_change":
            summary["sender_change_question"] = "발송 주소도 바꾸시겠어요?"
    elif origin := origin_confirmation(state):
        summary.update(origin_confirm=origin, missing=[], can_proceed=False)
    elif missing := missing_sender_address(state):
        if "sender_name" not in a.missing and (destination or state.current.deferred_destination):
            summary.update(stage="address", missing=list(missing), can_proceed=False)
    elif state.intent == "order" and destination:
        if destination.destination_clarification:
            summary["destination_change_question"] = DESTINATION_CHANGE_QUESTIONS[destination.destination_clarification]
            summary["missing"] = []
        else:
            summary["destination_choices"] = list(destination.labels)
        summary["can_proceed"] = False
    if state.intent == "order" and state.current and state.current.destination_partial_change:
        summary["destination_partial_change"] = state.current.destination_partial_change
    if summary["missing"][:1] in (["sender_address_detail"], ["receiver_address_detail"]):
        summary["address_detail_question"] = "상세주소를 알려주시겠어요?"
    if state.current and state.current.box_size_pending:
        fields["items"] = FieldStatus.PENDING_CHOICE.value
        summary["box_size_pending"] = True
    elif state.current and state.current.documents_only():
        fields["item_price"] = FieldStatus.VALID.value
    return summary


# 기업 사원 배송지는 발신 고객의 주소록이 아니다 — 연락처·상세주소는 요청해도 주지 않는다(주소록 주인 = 발신번호 전제 밖)
_PRIVATE_PARTS = ("phone", "address_detail")


def _shown(source: Source | None, part: str) -> bool:
    return not (source == Source.COMPANY and part.endswith(_PRIVATE_PARTS))


def order_values(state: ConversationState, policy: Policy) -> dict:
    """고객이 물은 진행 중 택배의 기록된 값과 제시 중인 받는 곳 후보(get_state include_values).
    서버 상태에서만 만든다 — Live가 대화 기억으로 답하지 않게. 발신번호(kind auto)·검증 안 된 값은 넣지 않는다."""
    out: dict = {}
    if state.current is not None:
        current = {}
        for name, f in state.current.fields.items():
            if not f.valid or f.value is None or policy.fields[name].kind == "auto" or not _shown(f.source, name):
                continue
            value = {k: v for k, v in f.value.__dict__.items() if v} if isinstance(f.value, Items) else f.value
            current[name] = {"value": value} | ({"from": f.source.value} if f.source not in (Source.CUSTOMER, None) else {})
        out["current"] = current
    c = state.candidates
    if state.intent == "order" and c is not None and c.kind == "destination" and not receiver_questions_deferred(state):
        out["candidates"] = [{"label": label} | {part: getattr(p, part) for part in ("name", "phone", "address", "address_detail")
                                                 if getattr(p, part) and _shown(p.source, part)}
                             for label, p in zip(c.labels, c.items) if isinstance(p, Place)]
    return out
