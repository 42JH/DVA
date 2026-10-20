from typing import Literal

from pydantic import Field

from app.order import Order
from app.tools._base import Args, Result, ToolError, require_confirmed, tool


class ConfirmArgs(Args):
    answer: Literal["confirm", "correct", "unclear"] = Field(
        description="되읽은 주문에 대한 고객 답: 맞다(confirm), 고칠 것이 있다(correct), 애매함(unclear)")
    customer_confirmed: bool = Field(description="고객이 이대로 접수하라고 확인했으면 true")


@tool("confirm_order", "마지막 확인에 대한 고객 답을 보고한다. confirm이면 기록된 임시 주문 그대로 접수한다.", ConfirmArgs)
async def confirm_order(ctx, args: ConfirmArgs) -> Result:
    if args.answer == "unclear":
        raise ToolError("답이 애매함", "이대로 접수할지 다시 여쭤보기")
    if args.answer == "correct":
        return Result({"answer": "correct"})
    require_confirmed(args)
    order = ctx.order
    if not order.complete():
        raise ToolError("빠진 항목이 있음", "state.missing 항목을 여쭤보기")
    biz = ctx.cfg.business
    order_no = await ctx.db.insert_order(ctx.caller, ctx.session_id, order, biz.fare, biz.order_prefix)
    # 접수 후 임시 주문을 비워 중복 접수를 막는다
    ctx.order = Order()
    ctx.last_order_no = order_no
    ctx.submitted.append(order_no)
    ctx.recent_receiver = order.place("receiver")
    ctx.recent_asked = False
    if ctx.caller:
        saved = set(await ctx.db.list_places(ctx.caller))
        both = (order.place("sender"), order.place("receiver"))
        ctx.save_candidates = list(dict.fromkeys(p for p in both if p not in saved))
    say = biz.submitted_message.format(order_no=order_no, fare=biz.fare)
    return Result({"order_no": order_no, "fare": biz.fare, "say": say}, ["order.submitted"])
