from pydantic import Field

from app.tools._base import OrderFields, Result, ToolError, require_caller, require_confirmed, tool


class ModifyArgs(OrderFields):
    order_no: str = Field(max_length=20, description="고칠 주문의 접수번호")
    customer_confirmed: bool = Field(description="고객이 이렇게 고치라고 확인했으면 true")


@tool("modify_order", "접수된 주문의 항목을 고친다. 고칠 항목만 채우고 나머지는 null. 고객 확인 후에만.", ModifyArgs)
async def modify_order(ctx, args: ModifyArgs) -> Result:
    require_confirmed(args)
    values, invalid = args.cleaned()
    if invalid:
        raise ToolError(f"전화번호 자릿수가 맞지 않음: {', '.join(invalid)}", "해당 전화번호를 다시 여쭤보기")
    if not values:
        raise ToolError("고칠 항목이 없음", "무엇을 고칠지 여쭤보기")
    order_no = args.order_no.strip().upper()
    status = await ctx.backend.update_order(require_caller(ctx), order_no, values)
    if status == "cancelled":
        raise ToolError("취소된 주문이라 고칠 수 없음", "취소된 주문은 수정할 수 없다고 안내")
    if status != "ok":
        raise ToolError("이 발신번호로 접수된 그 접수번호의 주문이 없음", "접수번호를 다시 여쭤보기(모르면 lookup_orders)")
    return Result({"order_no": order_no, "modified": list(values), "fare": None,
                   "price_status": "backend_confirmation_required"}, ["order.modified"])
