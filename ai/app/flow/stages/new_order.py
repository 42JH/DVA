"""§5.2 A 신규 고객 택배 접수(new_order). 물건 규격(A_ITEM_SIZE)부터 접수 완료까지는 B(기존 고객 접수, order.py)도
같은 노드로 합류한다. MVP 전제(다이어그램 메모): 고객 = 보내는 분, 연락처는 발신번호(묻지 않음).
항목 값은 백엔드가 record_order로 기록하고(②), 단계의 항목이 다 차면 다음 단계로 간다. 질문 하나가 한 턴이다."""

from app.flow.engine import ENTERED, STAY, Stage, Transition, always
from app.flow.stages._common import (COMMON_TOOLS, ORDER_TOOLS, ORIGIN, RECEIVER, SENDER, both, done, not_done,
                                     on_updated, reset_fail, task_is)
from app.order import Order

NEW_CHOICES = {"order": "택배를 보내겠다(접수)", "lookup": "보낸 택배를 조회·취소하겠다"}
ITEM_CHOICES = {"vague": "물건을 말했지만 크기와 개수를 말하지 않음", "partial": "크기와 개수 중 하나만 말함"}
VALUE_CHOICES = {"unclear": "가격을 말했지만 금액이 불명확하거나 모른다고 함"}
MORE_CHOICES = {"order": "택배를 더 보내겠다", "lookup": "보낸 택배를 조회·취소하겠다",
                "other": "다른 일을 도와 달라(무엇인지는 말하지 않음)", "no_more": "더 없다·통화를 마치겠다"}


async def new_answer(ctx, answer: str) -> list[str]:
    return [f"new.{answer}"]


async def event_answer(ctx, answer: str) -> list[str]:
    return [f"answer.{answer}"]


async def more_answer(ctx, answer: str) -> list[str]:
    return [f"hub.{answer}"]


def address_text(role: str, normal: str, retry: str):
    """주소DB에서 못 찾아 지운 주소는 구간 예외 문구로 한 번 다시 묻는다(보내는 곳/받는 곳 중 단계에 맞는 쪽)."""
    return lambda ctx: retry if f"{role}_address" in ctx.address_retry else normal


SENDER_TEXTS = {"sender_name": "A1_1", "sender_address": address_text("sender", "A1_2", "A_ADDR_RETRY_SENDER"),
                "sender_address_detail": "A_ADDR_DETAIL"}
RECEIVER_TEXTS = {"receiver_name": "A2_1", "receiver_phone": "A2_2",
                  "receiver_address": address_text("receiver", "A2_3", "A_ADDR_RETRY_RECEIVER"),
                  "receiver_address_detail": "A_ADDR_DETAIL"}


def new_parcel(ctx, prev: str) -> None:
    ctx.new_parcel()


def fill_sender(ctx, prev: str) -> None:
    ctx.fill_sender()  # 보내는 분 연락처 = 발신번호(이전 다이어그램의 "이 번호로 등록해드릴까요?"는 삭제됨)


async def enter_receiver_hub(ctx, prev: str) -> None:
    if prev == "A_REGISTER_SENDER":
        await ctx.register_customer()  # 고객 등록 + 보내는 사람 정보 등록(다이어그램 A_REGISTER_SENDER)
    await ctx.carry_dest_said()  # B12·B11로 들어오면 고객이 말한 받는 분 이름·주소는 다시 묻지 않는다


PAY_TEXTS = {"credit": "PAY_CREDIT", "groupBilling": "PAY_GROUP", "billing": "PAY_BILLING"}
PAY_CHOICES = {"credit": "월결제(기업 월결제)로 하겠다", "groupBilling": "부서 그룹결제로 하겠다"}


def payment_asked(ctx) -> bool:
    """결제 방식을 고객에게 물어야 함(후불 자격이 둘). 통화(주문)에 하나라 이미 정했으면 묻지 않는다."""
    return ctx.payment_method is None and ctx.payment_choice() is None


def fare_text(ctx):
    """A6 앞부분: 요금표로 배송비를 알면 "운임은 {운임}원이에요."(모르면 금액을 말하지 않는다)."""
    return ("A6",) if ctx.parcel_fare(ctx.order) else ()


def fare_and_payment(ctx):
    """A6: 운임 + 결제 안내(방식별 사실만, 결제 완료·메시지 발송은 말하지 않는다).
    TODO(flow): 다이어그램 A6 뒷문장("결제는 기사님 방문 시…")은 백엔드에 현장 결제가 없어 바꿨다(2026-10-31 결정)."""
    method = None if ctx.payment_method else ctx.payment_choice()  # 두 번째 택배부터는 결제 안내를 되풀이하지 않는다
    return fare_text(ctx) + ((PAY_TEXTS[method],) if method else ())


def set_payment(ctx, prev: str) -> None:
    ctx.payment_method = ctx.payment_method or ctx.payment_choice()


async def payment_answer(ctx, answer: str) -> list[str]:
    ctx.payment_pick = answer  # 확정 지연 뒤에 정한다("잠깐만요"로 번복하면 다시 묻는다)
    return ["payment.chosen"]


def use_payment_pick(ctx) -> None:
    ctx.payment_method = ctx.payment_pick


def add_parcel(ctx, prev: str) -> None:
    """접수 완료: 받은 택배를 임시 주문 그대로 접수 목록에 담고 비운다(같은 택배를 두 번 담지 않게).
    백엔드 접수는 통화 끝에 한 번(통화당 주문 한 건, 택배는 parcels로 묶는다). 신규 고객은 이제 등록 고객처럼 다룬다."""
    parcel = ctx.order
    ctx.parcels.append(parcel)
    if ctx.customer_type != "registered" and not ctx.customer_name:
        ctx.customer_name = parcel.sender_name  # MVP: 고객 = 보내는 분
    ctx.order, ctx.from_saved = Order(), set()
    reset_fail(ctx)


def back(*steps: str) -> tuple[Transition, ...]:
    """정정으로 앞 단계 값이 비면(못 찾은 주소를 지움 등) 그 단계로 되돌아간다(§2.5(4)). 앞 단계부터 본다."""
    earlier = {
        "A_REGISTER_SENDER": (SENDER, task_is("new_order")),
        "B_ORIGIN_CHANGE": (ORIGIN, task_is("order")),
        "A_RECEIVER_HUB": (RECEIVER, always),
        "A_ITEM_SIZE": (("item",), always),
        "A_ITEM_VALUE": (("item_price",), always),
    }
    return tuple(Transition("order.updated", s, both(earlier[s][1], not_done(*earlier[s][0]))) for s in steps)


SENDER_STEPS = ("A_REGISTER_SENDER", "B_ORIGIN_CHANGE")
# 기존 고객(B)이 최근 접수·주소록에서 가져온 출발지·도착지를 바꾸면 출발지는 새 출발지 받기, 도착지는 핀 매칭부터
# 다시 한다(§2.5(4), §9 "접수 중 고객이 다른 출발지를 말한 경우", 이전 매칭 결과는 버림)
REMATCH = (Transition("correct.origin", "B_ORIGIN_CHANGE"), Transition("correct.destination", "B_DEST_MATCH"))


def order_complete(ctx) -> bool:
    return ctx.order.complete() and ctx.pickup_at is not None


STAGES = [
    Stage(
        name="A_NEW_ORDER",
        description="신규 고객: 용건 듣기",
        tools=ORDER_TOOLS,
        ask="GREET_NEW",
        task="new_order",
        choices=lambda ctx: NEW_CHOICES,
        on_answer=new_answer,
        on_enter=new_parcel,
        transitions=(
            Transition("new.order", "A_REGISTER_SENDER"),
            # 신규 고객의 조회 요청: 안내 문구 뒤 신규 접수로(§4.1)
            Transition("new.lookup", "A_REGISTER_SENDER", say="NEW_LOOKUP"),
            # 용건 없이 보내는 분 정보부터 말해도 접수로 본다
            Transition("order.updated", "A_REGISTER_SENDER"),
        ),
    ),
    Stage(
        name="A_REGISTER_SENDER",
        description="고객 등록 + 보내는 분 정보 받기(성함·주소)",
        tools=ORDER_TOOLS,
        fields=SENDER,
        field_texts=SENDER_TEXTS,
        on_enter=fill_sender,
        transitions=on_updated("A_RECEIVER_HUB", done(*SENDER)),
    ),
    Stage(
        name="A_RECEIVER_HUB",
        description="수신인 정보 Hub: 받는 분 성함·연락처·주소 중 빈 것만 받기",
        tools=ORDER_TOOLS,
        fields=RECEIVER,  # 기본 순서 성함 → 연락처 → 주소. 한 번에 여러 항목을 말하면 채워진 항목은 건너뛴다
        field_texts=RECEIVER_TEXTS,
        on_enter=enter_receiver_hub,
        transitions=back(*SENDER_STEPS) + (REMATCH[0],) + on_updated("A_REGISTER_RECEIVER", done(*RECEIVER)),
    ),
    Stage(name="A_REGISTER_RECEIVER", description="받는 사람 정보 등록(Hub 안)",
          transitions=(Transition(ENTERED, "A_ITEM_SIZE"),)),
    Stage(
        name="A_ITEM_SIZE",
        description="물건 규격(크기·개수) 확인",
        tools=ORDER_TOOLS,
        fields=("item",),
        field_texts={"item": "A3"},
        choices=lambda ctx: ITEM_CHOICES,
        on_answer=event_answer,
        transitions=back(*SENDER_STEPS, "A_RECEIVER_HUB") + REMATCH + (
            Transition("answer.vague", STAY, say="A3_VAGUE"),
            Transition("answer.partial", STAY, say="A3_PARTIAL"),
        ) + on_updated("A_ITEM_VALUE", done("item")),
    ),
    Stage(
        name="A_ITEM_VALUE",
        description="물건 가액 기록",
        tools=ORDER_TOOLS,
        fields=("item_price",),
        field_texts={"item_price": "A4"},
        choices=lambda ctx: VALUE_CHOICES,
        on_answer=event_answer,
        transitions=back(*SENDER_STEPS, "A_RECEIVER_HUB", "A_ITEM_SIZE") + REMATCH + (
            Transition("answer.unclear", STAY, say="A4_UNCLEAR"),
        ) + on_updated("A_PICKUP_TIME", done("item_price")),
    ),
    Stage(
        name="A_PICKUP_TIME",
        description="수거 희망 일시 받기",
        tools=ORDER_TOOLS,
        fields=("pickup_at",),  # 통화(주문)에 하나: 두 번째 택배부터는 이미 차 있어 건너뛴다
        field_texts={"pickup_at": "A5"},
        transitions=back(*SENDER_STEPS, "A_RECEIVER_HUB", "A_ITEM_SIZE", "A_ITEM_VALUE") + REMATCH + (
            Transition("pickup.past", STAY, say="A5_PAST"),
        ) + on_updated(
            # 결제 방식을 물어야 하면(후불 자격 둘) 운임만 말하고 결제 단계에서 묻는다. 고른 답이 확정이다
            "A_PAYMENT", both(order_complete, payment_asked), say=fare_text,
        ) + on_updated(
            # A_PAYMENT 진입은 되돌릴 수 없는 확정으로 이어진다: commit_delay_ms 동안 새 입력이 없을 때만(§2.5(3))
            "A_PAYMENT", order_complete, say=fare_and_payment, commit=True),
    ),
    Stage(
        name="A_PAYMENT",
        description="결제 방식 정하기(후불 자격이 하나면 그것, 둘이면 묻고, 없으면 개인 카드)",
        tools=COMMON_TOOLS,
        ask="PAY_ASK",
        listen=payment_asked,
        choices=lambda ctx: PAY_CHOICES if payment_asked(ctx) else {},
        on_answer=payment_answer,
        on_enter=set_payment,
        transitions=(
            Transition(ENTERED, "A_DONE", lambda ctx: ctx.payment_method is not None),
            Transition("payment.chosen", "A_DONE", commit=True, action=use_payment_pick,
                       say=lambda ctx: PAY_TEXTS[ctx.payment_pick], asks=True),
        ),
    ),
    Stage(name="A_DONE", description="접수 완료(접수 목록에 담음)", on_enter=add_parcel,
          transitions=(Transition(ENTERED, "A_CHOICE"),)),
    Stage(
        name="A_CHOICE",
        description="추가 접수·다른 업무 고르기",
        tools=("get_state", "search_manual"),
        ask="A8",
        choices=lambda ctx: MORE_CHOICES,
        on_answer=more_answer,
        # 추가 접수·조회·다른 업무·더 없음은 HUB가 이어 받는다(질문은 GLOBAL_INTENT가 QNA로)
        transitions=tuple(Transition(f"hub.{c}", "HUB", forward=True) for c in MORE_CHOICES),
    ),
]
