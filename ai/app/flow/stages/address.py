"""주소 확정: 백엔드가 기록한 주소(고객이 말한 것)를 주소DB로 실제 도로명주소로 정한다(spec/address.md).
고객에게 묻지 않는 단계라 들어오자마자 돌아간다. 정보 받는 중(collecting)·마지막 확인(confirming)에서
새 주소가 기록되면(order.updated) 들어오고, 돌아간 단계는 같은 사건으로 원래 흐름(마지막 확인 등)을 잇는다."""

import logging

from app import address
from app.flow.engine import ENTERED, RETURN, Stage, Transition
from app.flow.stages._common import COMMON_TOOLS

log = logging.getLogger(__name__)


async def resolve(ctx, prev: str) -> None:
    """확정이면 그 주소, 애매하면 가장 가까운 후보, 못 찾으면(지역을 말하지 않음 등)·보정 꺼짐이면 들은 그대로."""
    for key in sorted(ctx.address_pending):
        heard = getattr(ctx.order, key)
        result = await address.correct(heard) if heard else None
        if result and result["candidates"]:
            setattr(ctx.order, key, result["candidates"][0])
        status = result["status"] if result else "off"
        ctx.address_results[key] = {"status": status, "changed": getattr(ctx.order, key) != heard}
        log.info("주소 확정 %s %s %s", ctx.session_id, key, status)  # 주소는 개인정보라 남기지 않는다
    ctx.address_pending.clear()


STAGES = [
    Stage(
        name="address",
        description="주소 확정(주소DB)",
        tools=COMMON_TOOLS,
        transitions=(Transition(ENTERED, RETURN),),
        listen=False,  # 머무르지 않는 단계
        subflow=True,  # 들어온 단계(collecting·confirming)로 돌아간다
        on_enter=resolve,
    ),
]
