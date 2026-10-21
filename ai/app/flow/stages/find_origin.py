from app.flow.engine import Stage, Transition
from app.flow.stages._common import COMMON_TOOLS, place_text


def _origins(ctx):
    return ctx.places["origin"][:ctx.cfg.listener.max_choices]


def choices(ctx) -> dict[str, str]:
    origins = _origins(ctx)
    if len(origins) == 1:
        found = {"origin_1": f"지난번과 같은 곳({place_text(origins[0])})에서 보낸다"}
    else:
        found = {f"origin_{i}": f"지난번 보낸 곳 중 이곳: {place_text(p)}" for i, p in enumerate(origins, 1)}
        found["same"] = "지난번과 같다고만 했고 어느 곳인지 말하지 않음"
    return {**found, "different": "지난번과 다른 곳에서 보낸다"}


async def on_answer(ctx, answer: str) -> list[str]:
    if answer.startswith("origin_"):
        ctx.order.set_place("sender", _origins(ctx)[int(answer.removeprefix("origin_")) - 1])
        ctx.origin_checked, ctx.origin_variant = True, None
        return ["origin.found"]
    if answer == "different":
        ctx.origin_checked, ctx.origin_variant = True, None
        return ["origin.different"]
    ctx.origin_variant = "which"
    return []


STAGES = [
    Stage(
        name="find_origin",
        description="보내는 곳이 지난번과 같은지 확인",
        tools=COMMON_TOOLS,
        variants=("which",),  # 같음, 저장된 출발지가 여러 곳 → 어느 곳인지
        transitions=(
            Transition("origin.found", "collecting"),
            Transition("origin.different", "collecting"),
        ),
        choices=choices,
        on_answer=on_answer,
    ),
]
