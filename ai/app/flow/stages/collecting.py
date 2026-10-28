"""주문 정보 받기. 신규·등록 고객은 받는 순서만 다르다. 항목 기록은 백엔드가 record_order로 한다.
택배 항목 뒤에 통화 항목(전화 주신 분 성함·수거 시각·결제 방식)을 첫 택배에서 한 번 받는다."""

from app.flow import engine
from app.flow.engine import ENTERED, Stage, Transition
from app.flow.stages._common import (COMMON_TOOLS, address_pending, complete, is_new, is_registered, origin_due,
                                     reset_for_new_order)

# 전화 주신 분 성함은 묻는지가 보내는 분 연락처로 정해지므로 그 바로 뒤(등록 고객은 묻지 않음)
NEW_ORDER_FIELDS = ("sender_name", "sender_phone", "customer_name", "sender_address", "sender_address_detail",
                    "receiver_address", "receiver_address_detail", "receiver_name", "receiver_phone",
                    "item", "item_price", "pickup_at", "payment_method")
REGISTERED_ORDER_FIELDS = ("receiver_address", "receiver_address_detail", "receiver_name", "receiver_phone",
                           "sender_address", "sender_address_detail", "sender_name", "sender_phone",
                           "item", "item_price", "customer_name", "pickup_at", "payment_method")


def field_order(ctx) -> tuple[str, ...]:
    return REGISTERED_ORDER_FIELDS if is_registered(ctx) else NEW_ORDER_FIELDS


def _due(ctx, field: str) -> bool:
    """아직 비어 있음. 바로 다음 차례가 아니어도 된다: 진행 상태는 앞 항목이 기록된 뒤에야 넘어가므로, 상담원이 먼저
    다음 질문을 하고 고객이 바로 답하면 그 답이 버려진다(2026-10-28 통화). 어느 질문의 답인지는 판별 모델이
    상담원의 직전 말로 가린다."""
    return field in engine.missing(ctx)


def choices(ctx) -> dict[str, str]:
    """보내는 분 연락처가 비어 있으면 "지금 전화하신 번호로 연락드리면 될까요?"에 대한 답, 결제 방식이 비어 있으면 고른 결제 방식."""
    out = {}
    if is_registered(ctx) and ctx.registered_name and _due(ctx, "sender_name"):
        out["use_customer"] = f"보내는 분이 전화한 고객 본인({ctx.registered_name})이라고 함"
    if ctx.caller and _due(ctx, "sender_phone"):
        out["use_caller"] = "보내는 분 연락처로 지금 전화한 번호를 쓰겠다고 함"
    if _due(ctx, "payment_method"):
        out |= {key: f"{name}(으)로 결제하겠다고 함" for key, name in ctx.payment_options().items()}
    return out


async def on_answer(ctx, answer: str) -> list[str]:
    if answer == "use_customer" and is_registered(ctx) and ctx.registered_name and _due(ctx, "sender_name"):
        ctx.order.sender_name = ctx.registered_name
        if ctx.caller and _due(ctx, "sender_phone"):
            ctx.order.sender_phone = ctx.caller
        return ["order.updated"]
    if answer == "use_caller" and ctx.caller and _due(ctx, "sender_phone"):
        ctx.order.sender_phone = ctx.caller
        return ["order.updated"]
    if answer in ctx.payment_options() and _due(ctx, "payment_method"):
        ctx.payment_method = answer
        return ["order.updated"]
    return []


STAGES = [
    Stage(
        name="collecting",
        description="주문 정보 받는 중",
        tools=COMMON_TOOLS + ("record_order",),
        fields=NEW_ORDER_FIELDS,
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
