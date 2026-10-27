"""저장된 받는 곳 찾기. 고객 말이 저장된 곳 중 어디인지(또는 이름만·여러 곳·없음·새 곳)를 판별하고,
결과에 따른 다음 안내는 코드가 정한다(spec/scenario.md)."""

from app.flow.engine import ENTERED, Stage, Transition
from app.flow.stages._common import (COMMON_TOOLS, no_saved_destinations, place_text, registered_without_recent,
                                     reset_for_new_order)

FIXED = {
    "name_only": "받는 분 이름만 말했고 그 이름의 저장된 곳이 여러 곳",
    "ambiguous": "말한 내용에 맞는 저장된 곳이 여러 곳",
    "not_found": "말한 받는 분·곳이 목록에 없음",
    "new": "처음 보내는 곳이거나 새 받는 분이라고 함",
}


def _dests(ctx):
    return ctx.places["destination"][:ctx.cfg.listener.max_choices]


def choices(ctx) -> dict[str, str]:
    return {**{f"dest_{i}": place_text(p) for i, p in enumerate(_dests(ctx), 1)}, **FIXED}


async def on_answer(ctx, answer: str) -> list[str]:
    ctx.dest_variant = None
    if answer.startswith("dest_"):
        ctx.use_place("receiver", _dests(ctx)[int(answer.removeprefix("dest_")) - 1])
        return ["destination.found"]
    if answer == "new":
        return ["destination.new"]
    if answer == "not_found":
        ctx.dest_misses += 1
        if ctx.dest_misses >= 2:
            return ["destination.not_found"]
        ctx.dest_variant = "need_more"
        return []
    ctx.dest_variant = "need_region" if answer == "name_only" else "need_detail"
    return []


STAGES = [
    Stage(
        name="find_destination",
        description="저장된 받는 곳 찾기",
        tools=COMMON_TOOLS,
        # 이름만 말함 · 여러 곳 · 처음 못 찾음 → 더 묻고 다시 판별
        variants=("need_region", "need_detail", "need_more"),
        transitions=(
            Transition("destination.found", "collecting"),
            Transition("destination.new", "collecting"),
            Transition("destination.not_found", "collecting"),
            # 저장된 받는 곳이 없으면 찾을 것도 없다
            Transition(ENTERED, "collecting", no_saved_destinations),
        ),
        choices=choices,
        on_answer=on_answer,
        start_if=registered_without_recent,
        on_enter=reset_for_new_order,
    ),
]
