"""접수 중에 끼어드는 하위 흐름: 수정·취소·조회·상담원 전환. 끝나면 들어온 단계로 돌아간다."""

from app.flow.engine import ANY, RETURN, Stage, Transition
from app.flow.stages._common import MAIN_STAGES, SUBFLOWS

BACK = (Transition("intent.other", RETURN), Transition("intent.new_order", RETURN))
ENTER_FROM = MAIN_STAGES + SUBFLOWS

STAGES = [
    Stage(
        name="modify",
        description="접수된 주문 수정",
        tools=("get_state", "lookup_orders", "modify_order", "next_request", "end_call"),
        transitions=(Transition("order.modified", RETURN),) + BACK,
        subflow=True,
        enter_on="intent.modify",
        enter_from=ENTER_FROM,
    ),
    Stage(
        name="cancel",
        description="접수된 주문 취소",
        tools=("get_state", "lookup_orders", "cancel_order", "next_request", "end_call"),
        transitions=(Transition("order.cancelled", RETURN),) + BACK,
        subflow=True,
        enter_on="intent.cancel",
        enter_from=ENTER_FROM,
    ),
    Stage(
        name="lookup",
        description="접수된 주문 조회",
        tools=("get_state", "lookup_orders", "next_request", "end_call"),
        transitions=BACK,
        subflow=True,
        enter_on="intent.lookup",
        enter_from=ENTER_FROM,
    ),
    Stage(
        name="handoff",
        description="상담원 전환",
        tools=("get_state", "transfer_to_agent", "next_request", "end_call"),
        transitions=(Transition("handoff.requested", "ending"),) + BACK,
        subflow=True,
        enter_on="intent.handoff",
        enter_from=(ANY,),
    ),
]
