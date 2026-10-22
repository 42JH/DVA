"""주문 정보 받기. 신규·등록 고객은 받는 순서만 다르다. 항목 기록은 백엔드가 record_order로 한다."""

from app.flow.engine import ENTERED, Stage, Transition
from app.flow.stages._common import COMMON_TOOLS, complete, is_new, is_registered, origin_due, reset_for_new_order
from app.order import ORDER_FIELDS

NEW_ORDER_FIELDS = ("sender_name", "sender_phone", "sender_address", "sender_address_detail",
                    "receiver_address", "receiver_address_detail", "receiver_name", "receiver_phone", "item")
REGISTERED_ORDER_FIELDS = ("receiver_address", "receiver_address_detail", "receiver_name", "receiver_phone",
                           "sender_address", "sender_address_detail", "sender_name", "sender_phone", "item")


def field_order(ctx) -> tuple[str, ...]:
    return REGISTERED_ORDER_FIELDS if is_registered(ctx) else NEW_ORDER_FIELDS


STAGES = [
    Stage(
        name="collecting",
        description="주문 정보 받는 중",
        tools=COMMON_TOOLS + ("record_order",),
        fields=ORDER_FIELDS,
        order=field_order,
        transitions=tuple(
            Transition(event, target, guard)
            for event in ("order.updated", ENTERED)
            for target, guard in (("confirming", complete), ("find_origin", origin_due))
        ),
        start_if=is_new,
        on_enter=reset_for_new_order,
    ),
]
