from app.flow.engine import ENTERED, Stage, Transition
from app.flow.stages._common import COMMON_TOOLS, has_save_candidates

STAGES = [
    Stage(
        name="submitted",
        description="접수 안내",
        tools=COMMON_TOOLS,
        # 머무르지 않고 바로 넘어간다. 접수번호 안내 문장은 confirm_order 결과의 say에 있다
        transitions=(
            Transition(ENTERED, "save_offer", has_save_candidates),
            Transition(ENTERED, "after_order"),
        ),
    ),
]
