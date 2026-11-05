"""Live가 요청한 대화 동작을 기존 실행 계층에 연결하는 Responses 어댑터.

Live가 네이티브 함수 인자를 내보낸다고 가정하지 않는다. 별도 Decision 재호출은 없다.
"""
from typing import Literal
from pydantic import Field

from app.tools.context import ToolContext
from app.tools.executor import Args, model_tool
from app.tools.outcome import ToolOutcome


class ConversationArgs(Args):
    action: Literal["order", "lookup", "cancel", "inquiry", "agent", "end", "more", "no_more",
                    "confirm", "change", "reject", "select", "origin_yes", "origin_no",
                    "save_yes", "save_no", "callback_yes", "callback_no", "input_rejected"]
    utterance_id: int = Field(ge=1, description="최신 [통화 상태]의 고객 발화 ID. 과거 발화를 재사용하지 않음")
    pending_id: str | None = Field(None, description="confirm/change/reject의 확인 ID")
    candidate_label: str | None = Field(None, description="select일 때 서버가 준 후보 이름표 그대로")
    candidate_version: int | None = Field(None, description="select일 때 서버가 준 후보 세트 버전")
    field: str | None = Field(None, description="input_rejected일 때 거절한 항목 이름")


@model_tool("manage_conversation", "Live의 용건 전환·확인·후보 선택·추가 택배·종료·저장 동의를 서버에 전달한다. "
            "새 값/정정은 record_fields로 먼저 기록한다. 도구 결과 전 실행 성공을 단정하지 않는다.", ConversationArgs)
async def manage_conversation(ctx: ToolContext, args: ConversationArgs) -> ToolOutcome:
    if not ctx.live_led or ctx.control is None:
        return ToolOutcome("rejected", "TOOL_NOT_ALLOWED")
    result = await ctx.control(args.model_dump())
    return ToolOutcome(result.pop("status", "ok"), result.pop("code", None), facts=result)
