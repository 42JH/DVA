from pydantic import Field

from app.tools._base import Args, Result, require_confirmed, tool


class TransferArgs(Args):
    customer_confirmed: bool = Field(description="고객이 상담원 연결에 동의했으면 true")


@tool("transfer_to_agent", "상담원에게 전화를 넘긴다. 고객 동의 후에만. 전환 안내를 마치면 서버가 넘긴다.", TransferArgs)
async def transfer_to_agent(ctx, args: TransferArgs) -> Result:
    require_confirmed(args)
    ctx.request_refer()
    return Result({}, ["handoff.requested"])
