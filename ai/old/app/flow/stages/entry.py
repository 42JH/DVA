"""진입과 HUB, 통화 종료. 발신번호 고객 조회는 accept 전에 Call.prepare가 하고, 그래프는 그 결과로 시작 단계를 고른다.
등록 고객에게 기존 출발지가 있으면 인사가 곧 "그 출발지에서 보내시나요?"(ORDER의 출발지 제안)이고, 그 밖에는 HUB."""

from app.flow.engine import ENTERED, Stage, Transition, always
from app.flow.stages._common import ORDER_TOOLS, both, is_registered

HUB_CHOICES = {"order": "택배를 보내겠다(접수)",
               "lookup": "이미 보낸 택배에 대한 일(조회·배송 확인·취소·수정)",
               "no_more": "더 도와드릴 일이 없다·통화를 마치겠다"}


async def hub_answer(ctx, answer: str) -> list[str]:
    return [f"hub.{answer}"]


def has_recent_origin(ctx) -> bool:
    return ctx.recent_place("origin") is not None


def is_new(ctx) -> bool:
    return ctx.customer_type == "new"


async def finish(ctx, prev: str) -> None:
    """담은 택배가 있으면 전부를 한 번에 접수하고(통화당 주문 한 건) 마무리 인사 뒤 끊는다.
    지번·좌표 등 접수 필수값을 못 찾았으면 임의 값 없이 미완료로 넘긴다."""
    if ctx.parcels and ctx.result_body is None:
        await ctx.send_result("COMPLETE" if ctx.complete_ready() else "INCOMPLETE")
    ctx.request_hangup()


def goodbye(ctx):
    # TODO(flow): 접수 결과 안내는 다이어그램에 없음. ACCEPTED일 때만 접수 완료라고 말한다(AGENTS.md)
    result = {"accepted": "END_ACCEPTED", "not_paid": "END_NOT_PAID", "pending": "END_PENDING"}.get(ctx.submit_variant())
    return (result, "END_CALL") if result else "END_CALL"


STAGES = [
    Stage(name="CALLER_ID", description="착신: 발신번호로 고객 조회",
          transitions=(Transition(ENTERED, "IS_REGISTERED"),), start_if=always),
    Stage(
        name="IS_REGISTERED",
        description="등록 고객인지 판단",
        transitions=(
            # TODO(flow): 탈퇴 고객은 다이어그램에 없음. 신규로 다루지 않고 바로 상담원 연결(spec/backend-api.md)
            Transition(ENTERED, "AGENT_HANDOFF", lambda ctx: ctx.customer_type == "withdrawn", say="D9"),
            # 인사가 곧 기존 출발지 제안(ORDER가 들어올 때 제안을 준비한다)
            Transition(ENTERED, "ORDER", both(is_registered, has_recent_origin), say="GREET_REGISTERED", asks=True),
            # TODO(flow): 기존 고객은 접수가 1회 이상 있다는 전제. 백엔드가 최근 접수를 주지 않으면 출발지 없이 인사하고 HUB
            Transition(ENTERED, "HUB", is_registered, say="GREET_REGISTERED_PLAIN", asks=True),
            Transition(ENTERED, "HUB", say="GREET_NEW", asks=True),
        ),
    ),
    Stage(
        name="HUB",
        description="택배 접수·조회 중 업무 고르기",
        tools=ORDER_TOOLS,  # 용건 없이 주문 정보부터 말해도 기록하고 접수로 간다
        ask="RESUME_HUB",  # HUB는 자체 인사말이 없다. 들어올 때 지나온 선의 문구가 질문이면 그것으로 묻는다
        choices=lambda ctx: HUB_CHOICES,
        on_answer=hub_answer,
        transitions=(
            Transition("hub.order", "ORDER"),
            # 신규 고객은 이 번호로 접수한 택배가 없다: 안내 문구 뒤 접수로(§4.1)
            Transition("hub.lookup", "ORDER", is_new, say="NEW_LOOKUP"),
            Transition("hub.lookup", "C_REQUIRED_INFO"),
            Transition("hub.no_more", "END_CALL"),
            Transition("order.updated", "ORDER"),
        ),
    ),
    Stage(
        name="END_CALL",
        description="마무리 인사 후 끊는 중",
        listen=False,  # 마무리 인사 중에는 고객 말로 상태를 바꾸지 않는다
        final=True,
        enter_on=("call.ending",),  # 감시(무응답·최대 통화 시간)·종료 요청은 어느 단계에서나
        ask=goodbye,
        on_enter=finish,
    ),
]
