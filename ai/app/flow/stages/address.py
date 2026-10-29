"""주소 확정: 백엔드가 기록한 주소(고객이 말한 것)를 주소DB로 실제 도로명주소로 정한다(spec/address.md).
고객에게 묻지 않는 단계라 들어오자마자 돌아간다. 정보 받는 중(collecting)·마지막 확인(confirming)에서
새 주소가 기록되면(order.updated) 들어오고, 돌아간 단계는 같은 사건으로 원래 흐름(마지막 확인 등)을 잇는다."""

import logging

from app import address
from app.address import kakao
from app.flow.engine import ENTERED, RETURN, Stage, Transition
from app.flow.stages._common import COMMON_TOOLS

log = logging.getLogger(__name__)


async def resolve(ctx, prev: str) -> None:
    """확정이면 그 주소, 애매하면 가장 가까운 후보, 못 찾으면 한 번 다시 묻고 그래도 못 찾거나 보정 꺼짐이면 들은 그대로.
    정한 주소로 카카오에서 지번·동명·우편번호·좌표를 찾는다(접수에 필요. 못 찾으면 비워 두고 접수 때 막는다)."""
    for key in sorted(ctx.address_pending):
        heard = getattr(ctx.order, key)
        result = await address.correct(heard) if heard else None
        if result and result["status"] == "not_found" and key not in ctx.address_retry:
            # 없는 주소를 그대로 받지 않고 한 번 더 묻는다(지우면 collecting이 그 항목을 다시 묻는다).
            # 두 번째도 못 찾으면 들은 그대로 두고, 지번·좌표가 없어 접수는 미완료로 넘어간다
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
