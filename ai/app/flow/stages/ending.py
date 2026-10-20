from app.flow.engine import ANY, Stage

STAGES = [
    Stage(
        name="ending",
        description="마무리 인사 후 끊는 중",
        tools=("get_state",),
        enter_on="call.ending",
        enter_from=(ANY,),
    ),
]
