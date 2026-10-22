from app.flow.engine import Stage
from app.flow.stages._common import COMMON_TOOLS, NEW_ORDER

CHOICES = {"more": "택배를 더 보내겠다고 함", "no_more": "더 용건이 없다고 함"}


async def on_answer(ctx, answer: str) -> list[str]:
    if answer == "more":
        return ["intent.new_order"]
    ctx.request_hangup()
    return ["call.ending"]


STAGES = [
    Stage(
        name="after_order",
        description="추가 주문·다른 용건 확인",
        tools=COMMON_TOOLS,
        # 접수 때 임시 주문을 비웠으므로 새 주문은 빈 주문서로, 통화 시작과 같은 규칙으로 시작한다
        transitions=NEW_ORDER,
        choices=lambda ctx: CHOICES,
        on_answer=on_answer,
    ),
]
