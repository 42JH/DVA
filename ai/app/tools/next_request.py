from typing import Literal

from pydantic import Field

from app.tools._base import Args, Result, tool


class IntentArgs(Args):
    intent: Literal["new_order", "modify", "cancel", "lookup", "handoff", "other"] = Field(
        description="고객 용건: 새 택배 접수, 접수한 주문 수정·취소·조회, 상담원 연결, 그 밖·애매함(other)")


@tool("next_request", "고객이 말한 용건을 보고한다. 통화를 끝내려는 경우는 end_call을 쓴다.", IntentArgs)
async def next_request(ctx, args: IntentArgs) -> Result:
    return Result({"intent": args.intent}, [f"intent.{args.intent}"])
