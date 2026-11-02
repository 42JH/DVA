from pydantic import Field

from app.tools._base import Args, Result, ToolError, tool


class MatchArgs(Args):
    name: str | None = Field(None, max_length=30, description="고객이 말한 보내는 분·받는 분 이름(조사·호칭 빼고)")
    place: str | None = Field(None, max_length=80, description="고객이 말한 지역·도로명·건물명(조사 빼고)")
    detail: str | None = Field(None, max_length=40, description="고객이 말한 층·동·호수")


@tool(
    "match_pins",
    "고객 주소록에서 고객이 말한 받는 곳을 찾는다. "
    "고객이 말한 이름·장소·층/호수만 채우고 나머지는 null. 결과(하나·여러 곳·없음)에 따라 서버가 다음 질문을 정한다.",
    MatchArgs,
)
async def match_pins(ctx, args: MatchArgs) -> Result:
    said = {k: v.strip() for k, v in args.model_dump().items() if v and v.strip()}
    if not said:
        raise ToolError("찾을 말이 없음", "고객이 말한 이름이나 장소를 넣어 다시 호출")
    events = ctx.match_pins(said.get("name"), said.get("place"), said.get("detail"))
    if events == ["pins.none"]:  # 저장된 곳이 없음: 고객이 말한 받는 분 이름·장소를 받는 분 정보로 가져간다(B12)
        await ctx.carry_dest_said()
    return Result({"found": len(ctx.pin_candidates)}, events)
