"""도구 결과 형식 ToolOutcome(error-recovery.md §1). Live·Backend는 status·fields·missing·needs만으로 다음 행동을 고른다.
code는 사유 표시·관측·테스트용. 문장 지시는 넣지 않는다(delegation.md §6.1)."""

from dataclasses import dataclass, field
from typing import Literal

from app.domain.assess import assess
from app.domain.state import ConversationState
from app.policy.model import Policy

Status = Literal["ok", "needs_input", "needs_choice", "needs_confirmation", "rejected", "unavailable", "unknown"]


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
    """값 기록·조회 결과에 붙이는 상태 요약(delegation.md §6.2-6). 값은 넣지 않고 상태만."""
    a = assess(state, policy)
    fields = {}
    if state.current is not None:
        fields = {n: f.status.value for n, f in state.current.fields.items() if policy.fields[n].kind != "auto"}
    result = {"stage": a.stage, "fields": fields, "missing": list(a.missing), "can_proceed": a.readback_ready,
              "parcels": len(state.parcels)}
    if state.pending:
        result["confirmation"] = {"id": state.pending.id, "kind": state.pending.kind}
    if state.candidates:
        result["candidates"] = {"version": state.candidates.version, "labels": list(state.candidates.labels)}
    return result
