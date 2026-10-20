from typing import Literal

from pydantic import Field

from app.tools._base import Args, Result, ToolError, tool


class RecentArgs(Args):
    answer: Literal["yes", "no", "unclear"] = Field(description="지난번 받는 분에게 다시 보내는지에 대한 고객 답")


@tool("use_recent_receiver", "지난번 받는 분에게 다시 보내는지 고객 답을 보고한다. yes면 받는 분 정보를 채운다.", RecentArgs)
async def use_recent_receiver(ctx, args: RecentArgs) -> Result:
    if args.answer == "unclear":
        raise ToolError("답이 애매함", "지난번 받는 분에게 보내는지 다시 여쭤보기")
    if args.answer == "yes" and ctx.recent_receiver:
        ctx.order.set_place("receiver", ctx.recent_receiver)
    ctx.recent_asked = True
    return Result({"answer": args.answer}, ["order.updated"])
