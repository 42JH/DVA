from app.flow.engine import Stage
from app.flow.stages._common import COMMON_TOOLS, NEW_ORDER

CHOICES = {"more": "택배를 더 보내겠다고 함", "no_more": "더 보낼 택배가 없다고 함"}


async def on_answer(ctx, answer: str) -> list[str]:
    if answer == "more":
        return ["intent.new_order"]
    # 확인한 택배 전부를 한 번에 접수한다. 지번·좌표 등 접수 필수값을 못 찾았으면 임의 값 없이 미완료로 넘긴다.
    # 결과(접수 성공·확인 필요)는 마무리 안내(ending)에서 말한다
    await ctx.send_result("COMPLETE" if ctx.complete_ready() else "INCOMPLETE")
    ctx.request_hangup()
    return ["call.ending"]


STAGES = [
    Stage(
        name="after_order",
        description="택배 추가 여부 확인",
        tools=COMMON_TOOLS,
        # 담은 택배는 임시 주문에서 비웠으므로 새 택배는 빈 주문서로, 통화 시작과 같은 규칙으로 시작한다
        transitions=NEW_ORDER,
        choices=lambda ctx: CHOICES,
        on_answer=on_answer,
    ),
]
