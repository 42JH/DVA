from app.flow.engine import Stage, Transition
from app.flow.stages._common import COMMON_TOOLS

CHOICES = {"yes": "이번 주소를 저장하는 데 동의함", "no": "저장하지 않겠다고 함"}


async def on_answer(ctx, answer: str) -> list[str]:
    if answer != "yes" or not ctx.caller:
        ctx.save_candidates = []
        return ["place.declined"]
    # 발신번호 주인의 배송지로 저장한다
    await ctx.backend.save_places(ctx.caller, ctx.save_candidates)
    for kind, place in ctx.save_candidates:
        if place not in ctx.places[kind]:
            ctx.places[kind].append(place)
    ctx.save_candidates = []
    ctx.customer_type = "registered"  # 저장에 동의한 신규 고객은 등록 고객이 된다
    return ["place.saved"]


STAGES = [
    Stage(
        name="save_offer",
        description="배송지 저장 여부 대기",
        tools=COMMON_TOOLS,
        transitions=(
            Transition("place.saved", "after_order"),
            Transition("place.declined", "after_order"),
        ),
        choices=lambda ctx: CHOICES,
        on_answer=on_answer,
    ),
]
