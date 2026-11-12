"""고객 확인을 마친 뒤 서버가 실행하는 주문 전체 또는 택배 한 건 취소."""

import asyncio
import logging
from functools import partial

from app.integrations.backend.gateway import BackendFailure
from app.tools.context import ToolContext
from app.tools.outcome import ToolOutcome

log = logging.getLogger(__name__)


async def cancel_parcel(ctx: ToolContext, order_seq: int, order_parcel_seq: int) -> ToolOutcome:
    return await _cancel(ctx, order_seq, order_parcel_seq)


async def cancel_order(ctx: ToolContext, order_seq: int) -> ToolOutcome:
    return await _cancel(ctx, order_seq, None)


async def _cancel(ctx: ToolContext, order_seq: int, order_parcel_seq: int | None) -> ToolOutcome:
    s, gw = ctx.state, ctx.backend
    seq = s.customer.call_session_seq
    if not seq:
        return ToolOutcome("unavailable", "CALL_NOT_REGISTERED")
    order_key = f"cancel:{order_seq}:"
    key = order_key + (str(order_parcel_seq) if order_parcel_seq is not None else "all")
    if order_parcel_seq is None:
        read_target = partial(gw.api.order_detail, seq, order_seq)
        write_cancel = partial(gw.api.cancel_order, seq, order_seq)
    else:
        read_target = partial(gw.api.parcel, seq, order_seq, order_parcel_seq)
        write_cancel = partial(gw.api.cancel_parcels, seq, order_seq, [order_parcel_seq])
    async with ctx.lock:  # 검사·예약
        op = ctx.ops.get(key)
        if any(k.startswith(order_key) and v["status"] == "running" for k, v in ctx.ops.items()):
            return ToolOutcome("unknown", "CANCEL_OUTCOME_UNKNOWN", {"op": "running"})
        if op and op["status"] in ("done", "already"):
            return ToolOutcome("ok", "CANCEL_ALREADY" if op["status"] == "already" else None, {"outcome": op["status"]})
        retry = op is not None  # 앞 시도가 unknown·failed
        ctx.ops[key] = {"status": "running"}
    if retry:
        try:
            now = await gw.read("cancel_target", read_target)
        except asyncio.CancelledError:
            _finish(ctx, key, "unknown", ToolOutcome("unknown", "CANCEL_OUTCOME_UNKNOWN"))
            raise
        except BackendFailure:
            return _finish(ctx, key, "unknown", ToolOutcome("unknown", "CANCEL_OUTCOME_UNKNOWN"))
        if now and now["status"] == "CANCELLED":
            return _finish(ctx, key, "done", ToolOutcome("ok", None, {"outcome": "done", "already_done": True}))
    try:
        result = await gw.write("cancel", write_cancel)
    except asyncio.CancelledError:
        _finish(ctx, key, "unknown", ToolOutcome("unknown", "CANCEL_OUTCOME_UNKNOWN"))
        raise
    except BackendFailure as e:
        if e.kind in ("unavailable", "in_progress"):  # 결과 불확실: 완료라고 말하지 않는다
            log.warning("취소 결과 불확실 %s %s", ctx.session_id, e.code)
            return _finish(ctx, key, "unknown", ToolOutcome("unknown", "CANCEL_OUTCOME_UNKNOWN"))
        return _finish(ctx, key, "failed", ToolOutcome("rejected", e.code))
    if result == "ok":
        return _finish(ctx, key, "done", ToolOutcome("ok", None, {"outcome": "done"}))
    if result == "not_found":
        return _finish(ctx, key, "failed", ToolOutcome("rejected", "ORDER_OUT_OF_RANGE"))
    try:  # 409: 이미 취소됐거나 결제가 끝남 — 지금 상태로 안내
        now = await gw.read("cancel_target", read_target)
    except asyncio.CancelledError:
        _finish(ctx, key, "unknown", ToolOutcome("unknown", "CANCEL_OUTCOME_UNKNOWN"))
        raise
    except BackendFailure:
        return _finish(ctx, key, "unknown", ToolOutcome("unknown", "CANCEL_OUTCOME_UNKNOWN"))
    if now and now["status"] == "CANCELLED":
        return _finish(ctx, key, "already", ToolOutcome("ok", "CANCEL_ALREADY", {"outcome": "already"}))
    return _finish(ctx, key, "refused", ToolOutcome("rejected", "CANCEL_LOCKED", {"outcome": "locked"}))


def _finish(ctx: ToolContext, key: str, status: str, outcome: ToolOutcome) -> ToolOutcome:
    ctx.ops[key] = {"status": status}
    if status in ("done", "already"):
        ctx.state.cancel_done = True
    return outcome
