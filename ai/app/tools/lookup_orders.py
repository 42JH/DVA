from app.tools._base import Result, require_caller, tool


@tool("lookup_orders", "이 발신번호로 접수된 최근 주문(접수번호·받는 분·물품·상태)을 찾는다.")
async def lookup_orders(ctx, args) -> Result:
    orders = await ctx.db.list_orders(require_caller(ctx), ctx.cfg.storage.lookup_limit)
    return Result({"orders": orders}, ["orders.listed"])
