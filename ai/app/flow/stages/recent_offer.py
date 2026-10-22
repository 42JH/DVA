from app.flow.engine import Stage, Transition
from app.flow.stages._common import COMMON_TOOLS, registered_with_recent, reset_for_new_order

CHOICES = {"yes": "최근 배송과 같은 곳(보내는 곳·받는 곳)으로 보낸다", "no": "다른 곳으로 보낸다"}


async def on_answer(ctx, answer: str) -> list[str]:
    if answer == "yes" and ctx.recent:
        for role in ("sender", "receiver"):
            ctx.order.set_place(role, ctx.recent.place(role))
        return ["recent.accepted"]
    return ["recent.declined"]


STAGES = [
    Stage(
        name="recent_offer",
        description="최근 배송으로 보내는지 확인",
        tools=COMMON_TOOLS,
        transitions=(
            # 예: 물품만 남은 채로 collecting
            Transition("recent.accepted", "collecting"),
            Transition("recent.declined", "find_destination"),
        ),
        choices=lambda ctx: CHOICES,
        on_answer=on_answer,
        start_if=registered_with_recent,
        on_enter=reset_for_new_order,
    ),
]
