"""주문 정보 받기. 신규·등록 고객은 받는 항목 순서만 다르다."""

from app.flow.engine import ENTERED, Stage, Transition
from app.flow.stages._common import complete, is_new, is_registered
from app.order import ORDER_FIELDS

TOOLS = ("get_state", "record_order", "find_saved_places", "use_saved_place", "next_request", "end_call")
TO_CONFIRM = (Transition("order.updated", "confirming", complete), Transition(ENTERED, "confirming", complete))

STAGES = [
    Stage(
        name="collecting_new",
        description="주문 정보 받는 중(신규 고객)",
        tools=TOOLS,
        transitions=TO_CONFIRM,
        fields=ORDER_FIELDS,
        start_if=is_new,
    ),
    Stage(
        name="collecting_registered",
        description="주문 정보 받는 중(등록 고객)",
        tools=TOOLS + ("use_recent_receiver",),
        transitions=TO_CONFIRM,
        # 지난번 받는 분을 다시 쓸지 먼저 묻는다
        fields=("recent",) + ORDER_FIELDS,
        start_if=is_registered,
    ),
]
