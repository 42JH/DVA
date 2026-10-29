"""택배를 더 보낼 때: 보내는 곳·보내는 분이 앞 택배와 같은지. 같으면 보내는 쪽을 채우고 받는 곳부터 받는다.
여러 택배는 보통 같은 곳에서 다른 분께 보내므로 받는 곳은 채우지 않는다(신규·등록 고객 모두)."""

from app.flow.engine import Stage, Transition
from app.flow.stages._common import COMMON_TOOLS, is_new, is_registered, reset_for_new_order

CHOICES = {"yes": "보내는 곳·보내는 분이 앞 택배와 같다", "no": "보내는 곳이 다르다"}


async def on_answer(ctx, answer: str) -> list[str]:
    if answer == "yes" and ctx.recent:
        ctx.use_place("sender", ctx.recent.place("sender"))
        return ["recent.accepted"]
    return ["recent.declined"]


STAGES = [
    Stage(
        name="recent_offer",
        description="보내는 곳이 앞 택배와 같은지 확인",
        tools=COMMON_TOOLS,
        # 받는 곳은 통화 시작과 같은 규칙으로(등록 고객은 주소록에서 찾기)
        transitions=tuple(Transition(event, target, guard)
                          for event in ("recent.accepted", "recent.declined")
                          for target, guard in (("collecting", is_new), ("find_destination", is_registered))),
        choices=lambda ctx: CHOICES,
        on_answer=on_answer,
        on_enter=reset_for_new_order,
    ),
]
