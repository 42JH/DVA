from app.flow.engine import ANY, Stage

STAGES = [
    Stage(
        name="ending",
        description="마무리 인사 후 끊는 중",
        tools=("get_state",),
        variants=("handoff", "refer_failed"),  # 상담원 연결 안내 · 전환 실패 안내
        listen=False,  # 마무리 인사 중에는 고객 말로 상태를 바꾸지 않는다
        enter_on="call.ending",
        enter_from=(ANY,),
    ),
]
