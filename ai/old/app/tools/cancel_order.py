"""접수 취소(주문 상세 하나). 고객의 "예"를 확정 지연 뒤에 서버가 부른다(app/flow/stages/lookup_orders.py C_CANCEL).
쓰기마다 작업 번호(operation_id)를 남기고, 다시 시도하기 전에는 원래 요청이 이미 처리됐는지 조회로 확인한다(중복 취소 방지).
백엔드: POST /api/orders/{id}/parcels/cancel(204, 같은 상세를 다시 취소해도 204). 결제가 끝난 주문은 409(spec/backend-api.md)."""

import logging

from pydantic import Field

from app.tools._base import Args, Result, ToolError, require_confirmed, tool

log = logging.getLogger(__name__)
DB_INT = 2_147_483_647


class CancelArgs(Args):
    order_seq: int = Field(ge=1, le=DB_INT, description="취소할 택배의 주문 번호(조회에서 확인한 것)")
    order_parcel_seq: int = Field(ge=1, le=DB_INT, description="취소할 택배의 주문 상세 번호(조회에서 확인한 것)")
    customer_confirmed: bool = Field(description="고객이 취소를 확인했으면 true")
    operation_id: str = Field(max_length=120, description="서버가 붙이는 쓰기 작업 번호")


@tool("cancel_order", "조회에서 확인한 접수를 취소한다. 고객 확인 후 서버만 부른다.", CancelArgs)
async def cancel_order(ctx, args: CancelArgs) -> Result:
    require_confirmed(args)
    if not ctx.call_session_seq:
        raise ToolError("통화 번호 없음(고객 확인 실패)", "취소 처리 중 문제가 생겼다고 안내", ["cancel.failed"])
    target = (args.order_seq, args.order_parcel_seq)
    tried = [op for op in ctx.running_ops.values() if op["tool"] == "cancel_order" and op["target"] == target]
    op = ctx.running_ops[args.operation_id] = {"tool": "cancel_order", "target": target, "status": "running"}
    if tried:  # 앞 시도의 결과가 불확실할 수 있다(시간 초과 등): 다시 보내기 전에 조회로 확인
        try:
            now = await ctx.backend.parcel(ctx.call_session_seq, *target)
        except Exception:
            op["status"] = "failed"
            raise ToolError("취소 전 확인 조회 실패", "취소 처리 중 문제가 생겼다고 안내", ["cancel.failed"]) from None
        if now and now["status"] == "CANCELLED":
            op.update(status="done", checked=True)
            return Result({"order_seq": args.order_seq, "already_done": True}, ["cancel.done"])
    try:
        result = await ctx.backend.cancel_parcels(ctx.call_session_seq, args.order_seq, [args.order_parcel_seq])
    except BaseException:  # 시간 초과로 취소돼도(CancelledError) 결과는 불확실로 남긴다
        op["status"] = "unknown"
        log.warning("취소 결과 불확실 %s %s", ctx.session_id, args.operation_id)
        raise
    if result == "ok":
        op["status"] = "done"
        return Result({"order_seq": args.order_seq}, ["cancel.done"])
    op["status"] = "refused"
    if result == "not_found":
        raise ToolError("이 통화 고객의 그 주문 상세가 없음", "취소 처리 중 문제가 생겼다고 안내", ["cancel.failed"])
    # 409: 이미 전체 취소됐거나 결제가 끝남(또는 결제 승인 처리 중). 지금 상태로 안내한다
    now = await ctx.backend.parcel(ctx.call_session_seq, *target)
    if now and now["status"] == "CANCELLED":
        op["status"] = "already"
        raise ToolError("이미 취소된 접수", "이미 취소된 접수라고 안내", ["cancel.already"])
    raise ToolError("결제가 끝나 접수가 진행된 주문이라 취소할 수 없음", "전화로는 취소가 어렵다고 안내", ["cancel.locked"])
