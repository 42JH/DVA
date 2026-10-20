from app.flow.engine import Stage, Transition
from app.flow.stages._common import is_new, is_registered

STAGES = [
    Stage(
        name="after_order",
        description="추가 주문·다른 용건 확인",
        tools=("get_state", "next_request", "end_call"),
        transitions=(
            # 접수 때 임시 주문을 비웠으므로 새 주문은 빈 주문서로 시작한다
            Transition("intent.new_order", "collecting_new", is_new),
            Transition("intent.new_order", "collecting_registered", is_registered),
        ),
    ),
]
