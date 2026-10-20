"""저장된 배송지 찾기·쓰기·저장. 발신번호 주인 것만(모델이 넘긴 번호가 아니라 서버가 아는 발신번호)."""

from typing import Literal

from pydantic import Field

from app.tools._base import Args, Result, ToolError, require_caller, require_confirmed, tool


async def _places(ctx):
    if ctx.places is None:
        ctx.places = await ctx.db.list_places(require_caller(ctx))
    return ctx.places


@tool("find_saved_places", "이 발신번호로 저장된 배송지 목록(번호·이름·주소)을 찾는다.")
async def find_saved_places(ctx, args) -> Result:
    places = await _places(ctx)
    return Result({"places": [{"place_id": i, "name": p.name, "address": p.address,
                               "address_detail": p.address_detail} for i, p in enumerate(places, 1)]})


class UsePlaceArgs(Args):
    place_id: int = Field(ge=1, description="find_saved_places 결과의 번호")
    role: Literal["sender", "receiver"] = Field(description="보내는 곳(sender)인지 받는 곳(receiver)인지")


@tool("use_saved_place", "고객이 고른 저장된 배송지를 보내는 분 또는 받는 분 정보로 채운다.", UsePlaceArgs)
async def use_saved_place(ctx, args: UsePlaceArgs) -> Result:
    places = await _places(ctx)
    if args.place_id > len(places):
        raise ToolError("없는 배송지 번호", "find_saved_places 목록에서 다시 고르기")
    ctx.order.set_place(args.role, places[args.place_id - 1])
    return Result({"used": args.role}, ["order.updated"])


class SaveArgs(Args):
    answer: Literal["yes", "no", "unclear"] = Field(description="이번 주소를 저장할지에 대한 고객 답")
    customer_confirmed: bool = Field(description="고객이 저장에 동의했으면 true")


@tool("save_places", "방금 접수한 주문의 저장 안 된 배송지를 저장할지 고객 답을 보고한다.", SaveArgs)
async def save_places(ctx, args: SaveArgs) -> Result:
    if args.answer == "unclear":
        raise ToolError("답이 애매함", "저장할지 다시 여쭤보기")
    if args.answer == "no":
        ctx.save_candidates = []
        return Result({"saved": 0}, ["place.declined"])
    require_confirmed(args)
    saved = await ctx.db.save_places(require_caller(ctx), ctx.save_candidates)
    ctx.save_candidates, ctx.places = [], None
    return Result({"saved": saved}, ["place.saved"])
