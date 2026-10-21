from pydantic import Field

from app.tools._base import Args, Result, ToolError, require_caller, require_confirmed, tool


class CancelArgs(Args):
    order_no: str = Field(max_length=20, description="취소할 주문의 접수번호")
    customer_confirmed: bool = Field(description="고객이 취소를 확인했으면 true")


@tool("cancel_order", "접수된 주문을 취소한다. 고객 확인 후에만.", CancelArgs)
async def cancel_order(ctx, args: CancelArgs) -> Result:
    require_confirmed(args)
    order_no = args.order_no.strip().upper()
    status = await ctx.backend.cancel_order(require_caller(ctx), order_no)
    if status == "cancelled":
        raise ToolError("이미 취소된 주문", "이미 취소된 주문이라고 안내")
    if status != "ok":
        raise ToolError("이 발신번호로 접수된 그 접수번호의 주문이 없음", "접수번호를 다시 여쭤보기(모르면 lookup_orders)")
    return Result({"order_no": order_no}, ["order.cancelled"])
