from app.flow.engine import ENTERED, Stage, Transition
from app.flow.stages._common import COMMON_TOOLS, address_pending, incomplete
from app.order import PLACE_KIND, Order

CHOICES = {"confirm": "되읽은 내용이 맞으니 이대로 접수해 달라고 함", "correct": "고칠 곳이 있다고 함"}


async def submit(ctx) -> None:
    """임시 주문 그대로 접수하고 비운다(중복 접수 방지). 접수번호는 백엔드가 발급한다.
    Idempotency-Key: 응답을 못 받고 고객이 다시 확인해도 같은 주문이 두 번 생기지 않게 이 통화의 n번째 주문으로 고정."""
    order, biz = ctx.order, ctx.cfg.business
    key = f"{ctx.session_id}-{len(ctx.submitted) + 1}"
    order_no = await ctx.backend.create_order(ctx.caller, ctx.session_id, order, None, key)
    ctx.order = Order()
    ctx.from_saved = set()
    ctx.last_order_no = order_no
    ctx.submitted.append(order_no)
    ctx.recent = order  # 이번 통화의 다음 주문에서 "최근 배송"
    if ctx.caller:
        ctx.save_candidates = [(kind, p) for role, kind in PLACE_KIND.items()
                               if (p := order.place(role)) not in ctx.places[kind]]


async def on_answer(ctx, answer: str) -> list[str]:
    # 고칠 곳은 백엔드가 record_order로 기록한다. 접수는 이 단계의 확인 질문에 "맞다"고 답했을 때만
    if answer != "confirm" or not ctx.order.complete():
        return []
    await submit(ctx)
    return ["order.submitted"]


STAGES = [
    Stage(
        name="confirming",
        description="마지막 확인 대기",
        tools=COMMON_TOOLS + ("record_order",),
        transitions=(
            Transition("order.updated", "address", address_pending),
            # 주소 확정에서 돌아온 직후(ENTERED)에도 같은 조건으로 본다
            Transition(ENTERED, "collecting", incomplete),
            # 정정하다 빠진 항목이 생기면(예: 주소를 바꿔 상세 주소를 다시 물어야 함) 다시 받는다
            Transition("order.updated", "collecting", incomplete),
            Transition("order.submitted", "submitted"),
        ),
        choices=lambda ctx: CHOICES,
        on_answer=on_answer,
    ),
]
