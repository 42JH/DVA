"""§4 진입과 HUB, 통화 종료. 발신번호 고객 조회는 accept 전에 Call.prepare가 하고, 그래프는 그 결과로 분기한다."""

from app.flow.engine import ENTERED, Stage, Transition, always
from app.flow.stages._common import COMMON_TOOLS, both, is_registered

HUB_CHOICES = {"order": "택배를 보내겠다(접수)",
               "lookup": "이미 보낸 택배에 대한 일(조회·배송 확인·취소·수정)",
               "no_more": "더 도와드릴 일이 없다·통화를 마치겠다"}
GREET_CHOICES = {"yes": "예·맞다(그 출발지에서 보내겠다)",
                 "no": "아니다·다른 곳에서 보내겠다·다른 용건이다",
                 "lookup": "이미 보낸 택배에 대한 일(조회·배송 확인·취소·수정)"}


async def hub_answer(ctx, answer: str) -> list[str]:
    return [f"hub.{answer}"]


async def greet_answer(ctx, answer: str) -> list[str]:
    if answer == "no":
        # 기존 출발지가 아니라고 했으니 이번 통화의 다음 접수는 새 출발지부터(§4.1 아니오, B1)
        ctx.new_origin_requested = True
    return [f"greet.{answer}"]


def has_recent_origin(ctx) -> bool:
    return ctx.recent_place("origin") is not None


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
            Transition(ENTERED, "B_GREET_CHOICE", both(is_registered, has_recent_origin), say="GREET_REGISTERED",
                       asks=True),
            # TODO(flow): 기존 고객은 접수가 1회 이상 있다는 전제. 백엔드가 최근 접수를 주지 않으면 출발지 없이 인사하고 HUB
            Transition(ENTERED, "HUB", is_registered, say="GREET_REGISTERED_PLAIN", asks=True),
            Transition(ENTERED, "A_NEW_ORDER", say="GREET_NEW", asks=True),
        ),
    ),
    Stage(
        name="B_GREET_CHOICE",
        description="기존 고객: 기존 출발지에서 보내는지",
        tools=COMMON_TOOLS,
        ask="GREET_REGISTERED",
        choices=lambda ctx: GREET_CHOICES,
        on_answer=greet_answer,
        unheard_ok=("no", "lookup"),  # 출발지를 듣기 전이어도 아니라는 답·다른 용건은 되돌릴 수 있다
        transitions=(
            Transition("greet.yes", "B_ORIGIN_ROUTE"),  # HUB에서 의도를 다시 묻지 않고 바로 접수
            Transition("greet.no", "HUB", say="HUB_ASK", asks=True),
            # 조회·취소처럼 이미 보낸 택배에 대한 용건이면 바로 조회로(다이어그램 밖, 2026-10-31 결정)
            Transition("greet.lookup", "C_REQUIRED_INFO"),
        ),
    ),
    Stage(
        name="HUB",
        description="택배 접수·조회 중 업무 고르기",
        tools=COMMON_TOOLS,
        ask="RESUME_HUB",  # HUB는 자체 인사말이 없다. 들어올 때 지나온 선의 문구가 질문이면 그것으로 묻는다
        choices=lambda ctx: HUB_CHOICES,
        on_answer=hub_answer,
        transitions=(
            Transition("hub.order", "B_ORIGIN_ROUTE"),
            Transition("hub.lookup", "C_REQUIRED_INFO"),
            Transition("hub.no_more", "END_CALL"),
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
