import logging

from app import address
from app.address import kakao
from app.tools._base import OrderFields, Result, ToolError, is_past, tool

log = logging.getLogger(__name__)

# 택배가 아니라 통화(주문) 전체에 하나인 값
CALL_FIELDS = ("pickup_at", "customer_name")
RETRY = {"pickup_at": "수거 희망 날짜와 시간을 다시 여쭤보기(지금 이후)"}


@tool(
    "record_order",
    "고객이 말한 택배 항목(보내는 분·받는 분·주소·물품·물품 가액·요청 사항)과 수거 희망 시각·전화 주신 분 성함을 기록한다"
    "(정정도 같은 도구). 이번에 들은 항목만 채우고 나머지는 null. "
    "전화번호는 들은 그대로 넘기면 서버가 숫자로 바꾸고 자릿수를 검사한다.",
    OrderFields,
)
async def record_order(ctx, args: OrderFields) -> Result:
    values, invalid = args.cleaned()
    before = ctx.snapshot_slots()
    for name in CALL_FIELDS:
        if name in values:
            setattr(ctx, name, values.pop(name))
            ctx.from_saved.discard(name)
    for role in ("sender", "receiver"):
        # 새 주소는 아래 resolve가 주소DB로 실제 주소로 정한다
        if values.get(f"{role}_address") and values[f"{role}_address"] != getattr(ctx.order, f"{role}_address"):
            ctx.address_pending.add(f"{role}_address")
        # 주소가 바뀌었는데 상세 주소를 같이 말하지 않았으면 이전 상세 주소는 맞지 않으므로 다시 묻는다
        address_ = values.get(f"{role}_address")
        if address_ is not None and address_ != getattr(ctx.order, f"{role}_address") \
                and f"{role}_address_detail" not in values:
            setattr(ctx.order, f"{role}_address_detail", None)
    for name, value in values.items():
        setattr(ctx.order, name, value)
    recorded = [*values, *(n for n in CALL_FIELDS if n in args.model_dump(exclude_none=True) and n not in invalid)]
    ctx.from_saved -= set(values)
    await resolve(ctx)
    ctx.note_changes(before)  # 이미 채운 항목이 바뀌었으면 정정(§2.5(4))
    events = ["order.updated"] if recorded else []
    if "pickup_at" in invalid and is_past(args.pickup_at):
        events.append("pickup.past")  # 지난 날짜(A5 구간 예외)
    if invalid:
        retry = "; ".join(RETRY.get(n, "해당 전화번호를 다시 또박또박 여쭤보기") for n in invalid)
        raise ToolError(f"형식이 맞지 않아 기록하지 않음: {', '.join(invalid)}", retry, events)
    if not recorded:
        raise ToolError("기록할 항목이 없음", "고객이 말한 항목을 채워 다시 호출")
    return Result({"recorded": recorded}, events)


async def resolve(ctx) -> None:
    """새로 기록된 주소를 주소DB로 실제 도로명주소로 정한다(spec/address.md). 확정이면 그 주소, 애매하면 가장 가까운 후보,
    못 찾으면 한 번 다시 묻고(지우면 단계가 그 항목을 구간 예외 문구로 다시 묻는다) 그래도 못 찾거나 보정 꺼짐이면 들은 그대로.
    정한 주소로 카카오에서 지번·동명·우편번호·좌표를 찾는다(접수에 필요. 못 찾으면 비워 두고 접수 때 막는다)."""
    for key in sorted(ctx.address_pending):
        heard = getattr(ctx.order, key)
        result = await address.correct(heard) if heard else None
        if result and result["status"] == "not_found" and key not in ctx.address_retry:
            # 없는 주소를 그대로 받지 않고 한 번 더 묻는다. 두 번째도 못 찾으면 들은 그대로 두고,
            # 지번·좌표가 없어 접수는 미완료로 넘어간다
            ctx.address_retry.add(key)
            setattr(ctx.order, key, None)
            setattr(ctx.order, key.replace("_address", "_geo"), None)
            ctx.address_results[key] = {"status": "not_found", "changed": False, "geo": False, "retry": True}
            log.info("주소 확정 %s %s not_found 다시 물음", ctx.session_id, key)
            continue
        if result and result["candidates"]:
            setattr(ctx.order, key, result["candidates"][0])
        geo = await kakao.geocode(getattr(ctx.order, key), ctx.cfg.address.kakao_timeout_sec) if heard else None
        setattr(ctx.order, key.replace("_address", "_geo"), geo)
        status = result["status"] if result else "off"
        ctx.address_results[key] = {"status": status, "changed": getattr(ctx.order, key) != heard, "geo": geo is not None}
        log.info("주소 확정 %s %s %s 좌표=%s", ctx.session_id, key, status, geo is not None)  # 주소는 개인정보라 남기지 않는다
    ctx.address_pending.clear()
