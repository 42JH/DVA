"""서버 전용 쓰기: 택배 취소. 모델에 주지 않는다(되돌릴 수 없음). 확정 관문(G1~G5) + 확정 지연 뒤 서버만 부른다.
원본 cancel_order 규칙 그대로: 작업 키 ops["cancel:{o}:{p}"]로 같은 대상 동시 실행 금지, 앞 시도가 불확실했으면 다시
보내기 전에 상세를 조회해 이미 취소됐는지 본다. BE: 204 성공(같은 상세 재취소도 204), 404 없음, 409 결제 완료 등.
"""

import logging

from app.integrations.backend.gateway import BackendFailure
from app.tools.context import ToolContext
from app.tools.outcome import ToolOutcome

log = logging.getLogger(__name__)


async def cancel_parcel(ctx: ToolContext, order_seq: int, order_parcel_seq: int) -> ToolOutcome:
    s, gw = ctx.state, ctx.backend
    seq = s.customer.call_session_seq
    if not seq:
        return ToolOutcome("unavailable", "CALL_NOT_REGISTERED")
    key = f"cancel:{order_seq}:{order_parcel_seq}"
    async with ctx.lock:  # 검사·예약
        op = ctx.ops.get(key)
        if op and op["status"] == "running":
            return ToolOutcome("unknown", "CANCEL_OUTCOME_UNKNOWN", {"op": "running"})
        if op and op["status"] in ("done", "already"):
            return ToolOutcome("ok", "CANCEL_ALREADY" if op["status"] == "already" else None, {"outcome": op["status"]})
        retry = op is not None  # 앞 시도가 unknown·failed
        ctx.ops[key] = {"status": "running"}
    if retry:
        try:
            now = await gw.read("parcel", gw.api.parcel, seq, order_seq, order_parcel_seq)
        except BackendFailure:
            return _finish(ctx, key, "unknown", ToolOutcome("unknown", "CANCEL_OUTCOME_UNKNOWN"))
        if now and now["status"] == "CANCELLED":
            return _finish(ctx, key, "done", ToolOutcome("ok", None, {"outcome": "done", "already_done": True}))
    try:
        result = await gw.write("cancel", gw.api.cancel_parcels, seq, order_seq, [order_parcel_seq])
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
        now = await gw.read("parcel", gw.api.parcel, seq, order_seq, order_parcel_seq)
    except BackendFailure:
        now = None
    if now and now["status"] == "CANCELLED":
        return _finish(ctx, key, "already", ToolOutcome("ok", "CANCEL_ALREADY", {"outcome": "already"}))
    return _finish(ctx, key, "refused", ToolOutcome("rejected", "CANCEL_LOCKED", {"outcome": "locked"}))


def _finish(ctx: ToolContext, key: str, status: str, outcome: ToolOutcome) -> ToolOutcome:
    ctx.ops[key] = {"status": status}
    if status in ("done", "already"):
        ctx.state.cancel_done = True  # 결과 문구 검사(claims)의 근거
    return outcome
