from pydantic import Field

from app.tools._base import Args, Result, require_confirmed, tool


class EndArgs(Args):
    customer_confirmed: bool = Field(description="고객이 통화를 마치겠다고 확인했으면 true")


@tool("end_call", "통화를 마친다. 고객 확인 후에만. 마무리 인사가 끝나면 서버가 끊는다.", EndArgs)
async def end_call(ctx, args: EndArgs) -> Result:
    require_confirmed(args)
    ctx.request_hangup()
    return Result({}, ["call.ending"])
