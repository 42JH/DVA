from app.tools._base import OrderFields, Result, ToolError, tool


@tool(
    "record_order",
    "고객이 말한 주문 항목을 임시 주문에 기록한다(정정도 같은 도구). 이번에 들은 항목만 채우고 나머지는 null. "
    "전화번호는 들은 그대로 넘기면 서버가 숫자로 바꾸고 자릿수를 검사한다.",
    OrderFields,
)
async def record_order(ctx, args: OrderFields) -> Result:
    values, invalid = args.cleaned()
    for role in ("sender", "receiver"):
        # 주소가 바뀌었는데 상세 주소를 같이 말하지 않았으면 이전 상세 주소는 맞지 않으므로 다시 묻는다
        address = values.get(f"{role}_address")
        if address is not None and address != getattr(ctx.order, f"{role}_address") \
                and f"{role}_address_detail" not in values:
            setattr(ctx.order, f"{role}_address_detail", None)
    for name, value in values.items():
        setattr(ctx.order, name, value)
    events = ["order.updated"] if values else []
    if invalid:
        raise ToolError(f"전화번호 자릿수가 맞지 않아 기록하지 않음: {', '.join(invalid)}",
                        "해당 전화번호를 다시 또박또박 여쭤보기", events)
    if not values:
        raise ToolError("기록할 항목이 없음", "고객이 말한 항목을 채워 다시 호출")
    return Result({"recorded": list(values)}, events)
