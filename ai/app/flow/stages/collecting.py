"""주문 정보 받기. 신규·등록 고객은 받는 순서만 다르다. 항목 기록은 백엔드가 record_order로 한다.
택배 항목 뒤에 통화 항목(전화 주신 분 성함·수거 시각·결제 방식)을 첫 택배에서 한 번 받는다."""

from app.call import CALL_FIELDS
from app.flow import engine
from app.flow.engine import ENTERED, Stage, Transition
from app.flow.stages._common import (COMMON_TOOLS, address_pending, complete, is_new, is_registered, origin_due,
                                     reset_for_new_order)
from app.order import ORDER_FIELDS

NEW_ORDER_FIELDS = ("sender_name", "sender_phone", "sender_address", "sender_address_detail",
                    "receiver_address", "receiver_address_detail", "receiver_name", "receiver_phone",
                    "item", "item_price") + CALL_FIELDS
REGISTERED_ORDER_FIELDS = ("receiver_address", "receiver_address_detail", "receiver_name", "receiver_phone",
                           "sender_address", "sender_address_detail", "sender_name", "sender_phone",
                           "item", "item_price") + CALL_FIELDS


def field_order(ctx) -> tuple[str, ...]:
    return REGISTERED_ORDER_FIELDS if is_registered(ctx) else NEW_ORDER_FIELDS


def _asking(ctx, field: str) -> bool:
    missing = engine.missing(ctx)
    return bool(missing and missing[0] == field)


def choices(ctx) -> dict[str, str]:
    """보내는 분 연락처 차례에 "지금 전화하신 번호로 연락드리면 될까요?"에 대한 답, 결제 방식 차례에 고른 결제 방식."""
    if ctx.caller and _asking(ctx, "sender_phone"):
        return {"use_caller": "지금 전화한 번호로 연락받겠다고 함"}
    if _asking(ctx, "payment_method"):
        return {key: f"{name}(으)로 결제하겠다고 함" for key, name in ctx.payment_options().items()}
    return {}


async def on_answer(ctx, answer: str) -> list[str]:
    if answer == "use_caller" and ctx.caller and _asking(ctx, "sender_phone"):
        ctx.order.sender_phone = ctx.caller
        return ["order.updated"]
    if answer in ctx.payment_options() and _asking(ctx, "payment_method"):
        ctx.payment_method = answer
        return ["order.updated"]
    return []


STAGES = [
    Stage(
        name="collecting",
        description="주문 정보 받는 중",
        tools=COMMON_TOOLS + ("record_order",),
        fields=ORDER_FIELDS + CALL_FIELDS,
        order=field_order,
        transitions=(Transition("order.updated", "address", address_pending),) + tuple(
            Transition(event, target, guard)
            for event in ("order.updated", ENTERED)
            for target, guard in (("confirming", complete), ("find_origin", origin_due))
        ),
        choices=choices,
        on_answer=on_answer,
        start_if=is_new,
        on_enter=reset_for_new_order,
    ),
]
