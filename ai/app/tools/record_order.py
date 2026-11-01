import logging

from app import address
from app.address import kakao
from app.flow.stages._common import SENDER
from app.order import PHONE_FIELDS
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
    phones = [n for n in PHONE_FIELDS if n in values and values[n] != before.get(n)]
    if phones:  # 고객이 불러 준 번호는 한 번 읽어 확인한다(숫자 하나라도 틀리면 안 됨)
        ctx.phone_check = values[phones[-1]]
        if "PHONE_CHECK" not in ctx.flow.notice:
            ctx.flow.notice.append("PHONE_CHECK")
    await resolve(ctx)
    ctx.note_changes(before)  # 이미 채운 항목이 바뀌었으면 정정(§2.5(4))
    ctx.drop_offers()  # 제안(기존 출발지·최근 도착지)에 답하지 않고 새 값을 말했으면 기록된 값이 이긴다
    if all(ctx.field_done(f) for f in SENDER):
        # 신규 고객은 보내는 분 정보를 다 말한 순간 고객 등록 + 보내는 곳을 주소록에(2026-10-31 결정, 한 번만)
        await ctx.register_customer()
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
    못 찾으면 기록하지 않고 지워서 찾을 때까지 다시 묻는다(단계가 그 항목을 다른 빈 항목보다 먼저 구간 예외 문구로 묻는다.
    2026-10-31: 확정되지 않은 주소로 다음 단계로 넘어가지 않게). 보정 꺼짐이면 들은 그대로.
    정한 주소로 카카오에서 지번·동명·우편번호·좌표를 찾는다(접수에 필요. 못 찾으면 비워 두고 접수 때 막는다)."""
    for key in sorted(ctx.address_pending):
        heard = getattr(ctx.order, key)
        result = await address.correct(heard) if heard else None
        if result and result["status"] == "not_found":
            ctx.address_retry.add(key)
            setattr(ctx.order, key, None)
            setattr(ctx.order, f"{key}_detail", None)  # 못 찾은 주소에 붙은 상세주소도 믿을 수 없다(다시 받는다)
            setattr(ctx.order, key.replace("_address", "_geo"), None)
            ctx.address_results[key] = {"status": "not_found", "changed": False, "geo": False, "retry": True}
            log.info("주소 확정 %s %s not_found 다시 물음", ctx.session_id, key)
            continue
        ctx.address_retry.discard(key)
        if result and result["candidates"]:
            setattr(ctx.order, key, result["candidates"][0])
        geo = await kakao.geocode(getattr(ctx.order, key), ctx.cfg.address.kakao_timeout_sec) if heard else None
        setattr(ctx.order, key.replace("_address", "_geo"), geo)
        status = result["status"] if result else "off"
        ctx.address_results[key] = {"status": status, "changed": getattr(ctx.order, key) != heard, "geo": geo is not None}
        log.info("주소 확정 %s %s %s 좌표=%s", ctx.session_id, key, status, geo is not None)  # 주소는 개인정보라 남기지 않는다
    ctx.address_pending.clear()
