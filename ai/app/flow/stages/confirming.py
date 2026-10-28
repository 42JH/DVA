from app.flow.engine import ENTERED, Stage, Transition
from app.flow.stages._common import COMMON_TOOLS, address_pending, incomplete
from app.order import Order

CHOICES = {"confirm": "되읽은 내용이 맞으니 이대로 접수해 달라고 함", "correct": "고칠 곳이 있다고 함"}


def add_parcel(ctx) -> None:
    """고객이 확인한 택배를 임시 주문 그대로 접수 목록에 담고 비운다(같은 택배를 두 번 담지 않게).
    접수는 통화 끝에 한 번(백엔드는 통화당 주문 한 건, 택배는 parcels로 묶는다)."""
    ctx.parcels.append(ctx.order)
    ctx.recent = ctx.order  # 이번 통화의 다음 택배에서 "최근 배송"
    ctx.order = Order()
    ctx.from_saved = set()


async def on_answer(ctx, answer: str) -> list[str]:
    # 고칠 곳은 백엔드가 record_order로 기록한다. 담는 것은 이 단계의 확인 질문에 "맞다"고 답했을 때만
    if answer != "confirm" or incomplete(ctx):
        return []
    add_parcel(ctx)
    return ["parcel.confirmed"]


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
            Transition("parcel.confirmed", "after_order"),
        ),
        choices=lambda ctx: CHOICES,
        on_answer=on_answer,
    ),
]
