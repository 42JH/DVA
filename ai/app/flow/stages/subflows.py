"""어느 단계에서나(ending 제외) 끼어드는 하위 흐름: 조회·수정·취소·상담원 연결.
들어가는 것은 고객 말의 용건 판별(intent.*), 끝나면 들어온 단계로 돌아간다.
돌아간 단계는 같은 사건을 다시 본다(예: "새 주문" → after_order에서 새 주문 시작)."""

from app.flow.engine import ANY, RETURN, Stage, Transition

# 고객이 그만두거나 새 주문을 말하면 복귀
BACK = (Transition("intent.stop", RETURN), Transition("intent.new_order", RETURN))
HANDOFF_CHOICES = {"yes": "상담원 연결에 동의함", "no": "상담원 연결을 원하지 않음"}


async def handoff_answer(ctx, answer: str) -> list[str]:
    if answer == "yes":
        ctx.request_refer()  # 전환 안내가 끝나면 서버가 refer
        return ["handoff.requested"]
    return ["intent.stop"]


STAGES = [
    Stage(
        name="lookup",
        description="접수된 주문 조회",
        tools=("get_state", "search_manual", "lookup_orders"),
        transitions=(Transition("orders.listed", RETURN),) + BACK,
        subflow=True,
        enter_on="intent.lookup",
        enter_from=(ANY,),
    ),
    Stage(
        name="modify",
        description="접수된 주문 수정",
        tools=("get_state", "search_manual", "lookup_orders", "modify_order"),
        transitions=(Transition("order.modified", RETURN),) + BACK,
        subflow=True,
        enter_on="intent.modify",
        enter_from=(ANY,),
    ),
    Stage(
        name="cancel",
        description="접수된 주문 취소",
        tools=("get_state", "search_manual", "lookup_orders", "cancel_order"),
        transitions=(Transition("order.cancelled", RETURN),) + BACK,
        subflow=True,
        enter_on="intent.cancel",
        enter_from=(ANY,),
    ),
    Stage(
        name="handoff",
        description="상담원 연결",
        tools=("get_state", "search_manual"),
        transitions=(Transition("handoff.requested", "ending"),) + BACK,
        variants=("offer",),  # 처리할 수 없는 요청·반복 실패로 서버가 먼저 제안
        choices=lambda ctx: HANDOFF_CHOICES,
        on_answer=handoff_answer,
        subflow=True,
        enter_on="intent.handoff",
        enter_from=(ANY,),
    ),
]
