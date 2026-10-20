from app.flow.engine import Stage, Transition

STAGES = [
    Stage(
        name="save_offer",
        description="배송지 저장 여부 대기",
        tools=("get_state", "save_places", "end_call"),
        transitions=(
            Transition("place.saved", "after_order"),
            Transition("place.declined", "after_order"),
        ),
    ),
]
