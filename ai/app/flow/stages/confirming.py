from app.flow.engine import Stage, Transition
from app.flow.stages._common import has_save_candidates, incomplete_new, incomplete_registered

STAGES = [
    Stage(
        name="confirming",
        description="마지막 확인 대기",
        tools=("get_state", "record_order", "find_saved_places", "use_saved_place", "confirm_order",
               "next_request", "end_call"),
        transitions=(
            # 정정하다 빠진 항목이 생기면 다시 받는다
            Transition("order.updated", "collecting_new", incomplete_new),
            Transition("order.updated", "collecting_registered", incomplete_registered),
            Transition("order.submitted", "save_offer", has_save_candidates),
            Transition("order.submitted", "after_order"),
        ),
    ),
]
