from app.flow.engine import ANY, Stage

STAGES = [
    Stage(
        name="ending",
        description="마무리 인사 후 끊는 중",
        tools=("get_state",),
        # 상담원 연결 안내 · 전환 실패 안내 · 접수 완료 · 접수 확인 필요 · 접수 그만둠
        variants=("handoff", "refer_failed", "accepted", "pending", "cancelled"),
        listen=False,  # 마무리 인사 중에는 고객 말로 상태를 바꾸지 않는다
        enter_on="call.ending",
        enter_from=(ANY,),
        start_if=lambda ctx: ctx.customer_type == "withdrawn",  # 탈퇴 고객: 바로 상담원 연결 안내
    ),
]
