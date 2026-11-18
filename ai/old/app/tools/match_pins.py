from pydantic import Field

from app.tools._base import Args, Result, ToolError, tool


class MatchArgs(Args):
    name: str | None = Field(None, max_length=30, description="고객이 말한 보내는 분·받는 분 이름(조사·호칭 빼고)")
    place: str | None = Field(None, max_length=80, description="고객이 말한 지역·도로명·건물명(조사 빼고)")
    detail: str | None = Field(None, max_length=40, description="고객이 말한 층·동·호수")
    organization: str | None = Field(None, max_length=80, description="찾을 기업명. 개인 주소록과 별도로 기업 사원을 검색")
    department: str | None = Field(None, max_length=80, description="찾을 부서명")
    restart: bool = Field(False, description="다른 수신인/기업으로 정정하면 true. 이전 이름·장소·후보를 버리고 새로 검색")


@tool(
    "match_pins",
    "개인 주소록과 기업·사원 배송지에서 고객이 말한 받는 곳을 찾는다. 기업명은 organization, 부서는 department. "
    "다른 수신인으로 바꾸면 restart=true로 이전 조건을 지운다. "
    "고객이 말한 문자열만 채우고 나머지는 null, restart는 true/false. 결과에 따라 서버가 다음 질문을 정한다.",
    MatchArgs,
)
async def match_pins(ctx, args: MatchArgs) -> Result:
    said = {k: v.strip() for k, v in args.model_dump(exclude={"restart"}).items() if v and v.strip()}
    if not said:
        raise ToolError("찾을 말이 없음", "고객이 말한 이름이나 장소를 넣어 다시 호출")
    events = await ctx.find_places(said.get("name"), said.get("place"), said.get("detail"),
                                   said.get("organization"), said.get("department"), args.restart)
    if events == ["pins.none"]:  # 저장된 곳이 없음: 고객이 말한 받는 분 이름·장소를 받는 분 정보로 가져간다(B12)
        await ctx.carry_dest_said()
    return Result({"found": len(ctx.pin_candidates)}, events)
