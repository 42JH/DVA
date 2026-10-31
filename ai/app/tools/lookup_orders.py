from pydantic import Field

from app.tools._base import Args, Result, tool


class LookupArgs(Args):
    receiver_name: str | None = Field(None, max_length=30, description="받는 분 성함(조사·호칭 빼고). 기억하지 못하면 null")


@tool("lookup_orders", "이 발신번호로 접수된 택배를 받는 분 성함으로 찾는다(가장 최근 것부터). "
      "결과(있음·없음·조회 실패)에 따라 서버가 다음 질문을 정한다.", LookupArgs)
async def lookup_orders(ctx, args: LookupArgs) -> Result:
    events = await ctx.find_orders(args.receiver_name)
    return Result({"found": len(ctx.lookup.get("orders") or []), "failed": bool(ctx.lookup.get("failed"))}, events)
