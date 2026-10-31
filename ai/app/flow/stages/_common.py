"""단계 정의들이 같이 쓰는 조건(guard)·도구 목록·선택지. 통화 상태·임시 주문만 보는 작은 함수."""

from app.flow.engine import ENTERED, Transition

COMMON_TOOLS = ("get_state", "search_manual")  # 질문(RAG)은 어느 단계에서나 들어올 수 있다(§2.2)
ORDER_TOOLS = COMMON_TOOLS + ("record_order",)  # 접수 단계: 지난 항목 정정도 기록한다(§2.5(4))
YES_NO = {"yes": "예·맞다·그렇게 해 달라", "no": "아니다·다른 것이다"}

# 보내는 분 연락처는 묻지 않고 발신번호로 채운다(fill_sender). 기존 고객은 보내는 분을 그대로 두고 출발지 주소만 바꾼다
SENDER = ("sender_name", "sender_address", "sender_address_detail")
ORIGIN = ("sender_address", "sender_address_detail")
RECEIVER = ("receiver_name", "receiver_phone", "receiver_address", "receiver_address_detail")


def is_registered(ctx) -> bool:
    return ctx.customer_type == "registered"


def done(*names):
    """이 항목들이 다 있음."""
    return lambda ctx: all(ctx.field_done(n) for n in names)


def not_done(*names):
    return lambda ctx: not all(ctx.field_done(n) for n in names)


def task_is(*tasks):
    return lambda ctx: ctx.flow.task in tasks


def both(*guards):
    return lambda ctx: all(g(ctx) for g in guards)


def on_updated(target, guard, **kw) -> tuple[Transition, ...]:
    """항목이 기록됐을 때와, 다 찬 채로 들어왔을 때(건너뛰기) 같은 조건으로 옮긴다."""
    return tuple(Transition(event, target, guard, **kw) for event in ("order.updated", ENTERED))


# --- §2.4 도와드리지 못한 횟수 ---

def count_fail(ctx) -> None:
    """업무 처리 불가(조회 실패·이미 수거·취소 실패). 업무 흐름 안의 문구는 횟수와 상관없이 그대로 말한다."""
    ctx.fail_count += 1


def count_fail_offer(ctx) -> None:
    """RAG No·제한된 요청: 연속 3번째부터 상담원 연결을 제안한다(제안은 QnA·상담원 Hub에서만)."""
    count_fail(ctx)
    ctx.agent_offered = ctx.fail_count >= 3


def reset_fail(ctx) -> None:
    ctx.fail_count = 0
