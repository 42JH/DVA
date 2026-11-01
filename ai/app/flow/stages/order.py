"""접수(order): 택배 하나의 정보를 받는 단계(ORDER) 하나와 확정 관문(A_CONFIRM·A_PAYMENT)·담기(A_DONE)·추가 접수(A_CHOICE).

정보를 받는 순서·되묻기·정정은 음성 모델이 하고, 서버는 빠진 항목·권장 다음 질문·제안만 계산한다(spec/flow.md).
값은 백엔드가 record_order로 언제든 기록하고(순서 밖에서 말해도, 정정도), 항목이 다 차면 되읽기 확인(A_CONFIRM)으로 간다.
제안 = 저장된 값을 쓸지 묻기: 기존 출발지(등록 고객의 첫 택배, 인사가 곧 그 질문), 최근 도착지(B4), 주소록 후보(match_pins
결과: 하나면 B9, 여럿이면 B8). 제안 질문은 그 항목의 질문 자리에 대신 들어가고, 답(예/아니오·후보 고르기)은 서버 판별로 받는다.
MVP 전제(다이어그램 메모): 고객 = 보내는 분, 보내는 분 연락처는 발신번호(묻지 않음)."""

from app.flow.engine import ENTERED, STAY, Stage, Transition, missing
from app.flow.stages._common import COMMON_TOOLS, ORDER_TOOLS, YES_NO, on_updated, reset_fail

# 받을 항목과 권장 순서(진행 상태의 "다음"). 보내는 분 연락처는 발신번호로 채워 보통 묻지 않는다(발신번호가 없을 때만)
FIELDS = ("sender_name", "sender_phone", "sender_address", "sender_address_detail", "receiver_name", "receiver_phone",
          "receiver_address", "receiver_address_detail", "item", "item_price", "pickup_at")

ORIGIN_CHOICES = {"yes": "예·맞다(그 출발지에서 보낸다)", "no": "아니다, 다른 곳에서 보낸다",
                  "other": "아니다(무엇을 할지 말하지 않음)·택배를 보내려는 것이 아닌 다른 용건"}
MORE_CHOICES = {"order": "택배를 더 보내겠다", "lookup": "보낸 택배를 조회·취소하겠다",
                "other": "다른 일을 도와 달라(무엇인지는 말하지 않음)", "no_more": "더 없다·통화를 마치겠다"}
PAY_TEXTS = {"credit": "PAY_CREDIT", "groupBilling": "PAY_GROUP", "billing": "PAY_BILLING"}
PAY_CHOICES = {"credit": "월결제(기업 월결제)로 하겠다", "groupBilling": "부서 그룹결제로 하겠다"}


def offer(ctx) -> str | None:
    """지금 묻는 제안: 빠진 첫 항목의 질문 자리에 들어가는 저장된 값 확인. 없으면 None(그 항목을 그냥 묻는다)."""
    m = missing(ctx)
    first = m[0] if m else None
    if first == "sender_address" and ctx.origin_offer:
        return "origin"
    if first == "receiver_name":
        return receiver_offer(ctx)
    return None


def receiver_offer(ctx) -> str | None:
    if ctx.dest_offer:
        return "recent"
    if ctx.pin_offer:
        return "pin"
    if len(ctx.pin_candidates) > 1:
        return "pins"
    return None


def retry_or(role: str, normal: str, retry: str):
    """주소DB에서 못 찾아 지운 주소는 찾을 때까지 예외 문구로 다시 묻는다."""
    return lambda ctx: retry if f"{role}_address" in ctx.address_retry else normal


def sender_address_text(ctx) -> str:
    return "ORIGIN_ASK" if ctx.origin_offer else retry_or("sender", "A1_2", "A_ADDR_RETRY_SENDER")(ctx)


def receiver_name_text(ctx) -> str:
    """받는 분: 제안(최근 도착지·하나 남은 핀·후보들)이 있으면 그것, 주소록에서 찾다가 한쪽만 들었으면 빠진 쪽,
    주소록이 있는 고객이면 받는 분·장소를 열어 묻고(B6, 백엔드가 match_pins), 아니면 성함.
    받는 곳 주소를 이미 받았으면 성함만 묻는다(2026-11-01 21:47 통화: 주소를 말했는데 "어디로 보내실 건가요?"를 또 물음)."""
    kind = receiver_offer(ctx)
    if kind:
        return {"recent": "B4", "pin": "B9", "pins": "B8"}[kind]
    if ctx.pin_ask == "place" and not ctx.order.has("receiver_address"):
        return "A2_3"  # 이름만 들었고 주소록에 없음: 주소(이 질문은 받는 분 성함 자리지만 주소가 비었을 때만)
    if ctx.pin_ask == "name" or ctx.order.has("receiver_address"):
        return "A2_1"
    return "B6" if ctx.pin_scope("destination") else "A2_1"


FIELD_TEXTS = {
    "sender_name": "A1_1",
    "sender_phone": "A1_3",
    "sender_address": sender_address_text,
    "sender_address_detail": "A_ADDR_DETAIL_SENDER",
    "receiver_name": receiver_name_text,
    "receiver_phone": "A2_2",
    "receiver_address": retry_or("receiver", "A2_3", "A_ADDR_RETRY_RECEIVER"),
    "receiver_address_detail": "A_ADDR_DETAIL_RECEIVER",
    "item": "A3",
    "item_price": "A4",
    "pickup_at": "A5",
}


def next_after(ctx, filled: tuple[str, ...]) -> list[str]:
    """그 항목들이 채워졌다고 보고 다음에 물을 질문(문구 키). 다 차면 되읽기 확인."""
    for f in missing(ctx):
        if f not in filled:
            text = FIELD_TEXTS[f]
            return [text(ctx) if callable(text) else text]
    return ["A_CONFIRM"]


def order_preview(ctx) -> list[tuple[str, list[str]]]:
    """제안 질문의 답마다 바로 이어서 할 말(engine.preview). 음성 모델은 판별보다 먼저 말을 시작해, 미리 알려 주지 않으면
    다음 질문을 스스로 지었다(2026-10-31 통화). 받는 분 질문은 그때의 제안 상태로 계산한다."""
    kind = offer(ctx)
    if kind == "origin":
        return [(ORIGIN_CHOICES["yes"], next_after(ctx, ("sender_phone", "sender_address", "sender_address_detail"))),
                (ORIGIN_CHOICES["no"], ["A1_2"]), (ORIGIN_CHOICES["other"], ["HUB_ASK"])]
    if kind in ("recent", "pin"):
        receiver = ("receiver_name", "receiver_phone", "receiver_address", "receiver_address_detail")
        out = [(YES_NO["yes"], next_after(ctx, receiver))]
        if kind == "recent":
            out.append((YES_NO["no"], ["B6" if ctx.pin_scope("destination") else "A2_1"]))
        return out
    return []


def then_hint(ctx) -> bool:
    """"그다음" 항목 알림은 그냥 항목을 묻는 질문에만. 받는 곳을 열어 묻거나(B6) 제안·후보를 묻는 중이면 답에 따라 다음이
    갈려(주소록 찾기·제안 답) 엉뚱한 항목을 미리 묻게 된다."""
    m = missing(ctx)
    return not m or m[0] != "receiver_name" or receiver_name_text(ctx) == "A2_1"


def order_choices(ctx) -> dict[str, str]:
    kind = offer(ctx)
    if kind == "origin":
        return ORIGIN_CHOICES
    if kind in ("recent", "pin"):
        return YES_NO
    if kind == "pins":
        return {**{f"pin_{i}": label for i, label in enumerate(ctx.pin_labels(), 1)}, "other": "말한 곳이 이 중에 없다"}
    return {}  # 제안이 없으면 고를 답이 없다(값은 백엔드가 기록하고, 전역 의도만 판별로 받는다)


async def order_answer(ctx, answer: str) -> list[str]:
    """제안에 대한 답. 예면 저장된 값을 임시 주문에 쓰고, 아니면 제안을 지워 그 항목을 그냥 묻는다."""
    kind = offer(ctx)
    if kind == "origin":
        place, ctx.origin_offer = ctx.origin_offer, None
        if answer == "yes":
            ctx.use_place("sender", place)
        elif answer == "other":  # 접수가 아닌 용건: "무엇을 도와드릴까요?"(나중에 접수하면 출발지를 묻는다)
            return ["order.leave"]
    elif kind == "recent":
        place, ctx.dest_offer = ctx.dest_offer, None
        if answer == "yes":
            ctx.use_place("receiver", place)
    elif kind == "pin":
        if answer == "yes":
            ctx.use_place("receiver", ctx.pin_offer)
            ctx.pin_offer, ctx.pin_candidates = None, []
        else:
            await ctx.reject_pin()
    elif kind == "pins":
        if answer.startswith("pin_"):
            ctx.pins_found([ctx.pin_candidates[int(answer.removeprefix("pin_")) - 1]], narrowing=True)
        else:  # 이 중에 없다: 후보들은 버린다(같은 주소를 다시 말해도 같은 후보를 또 묻지 않게)
            ctx.pin_rejected["destination"] += ctx.pin_candidates
            ctx.pin_candidates = []
            await ctx.carry_dest_said()
    await ctx.sync_asking()
    return ["order.updated"]


def start_parcel(ctx, prev: str) -> None:
    ctx.start_parcel()


def past_pickup(ctx) -> None:
    if "A5_PAST" not in ctx.flow.notice:
        ctx.flow.notice.append("A5_PAST")


def order_complete(ctx) -> bool:
    return ctx.order.complete() and ctx.pickup_at is not None


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


async def event_answer(ctx, answer: str) -> list[str]:
    return [f"answer.{answer}"]


async def more_answer(ctx, answer: str) -> list[str]:
    return [f"hub.{answer}"]


def add_parcel(ctx, prev: str) -> None:
    """접수 완료: 받은 택배를 임시 주문 그대로 접수 목록에 담고 새 택배를 비운다(같은 택배를 두 번 담지 않게).
    백엔드 접수는 통화 끝에 한 번(통화당 주문 한 건, 택배는 parcels로 묶는다)."""
    parcel = ctx.order
    ctx.parcels.append(parcel)
    if ctx.customer_type != "registered" and not ctx.customer_name:
        ctx.customer_name = parcel.sender_name  # MVP: 고객 = 보내는 분
    ctx.new_parcel()
    reset_fail(ctx)


STAGES = [
    Stage(
        name="ORDER",
        description="택배 접수: 정보 받기",
        tools=ORDER_TOOLS + ("match_pins",),
        task="order",
        enter_on=("intent.order",),  # 다른 업무 중에 택배를 보내겠다고 함(switch_task)
        fields=FIELDS,
        field_texts=FIELD_TEXTS,
        choices=order_choices,
        on_answer=order_answer,
        preview=order_preview,
        then=then_hint,
        on_enter=start_parcel,
        unheard_ok=("no", "other"),  # 제안을 듣기 전이어도 아니라는 답은 되돌릴 수 있다(§2.5(1))
        transitions=on_updated("A_CONFIRM", order_complete) + (
            # 접수가 아닌 용건: 접수 업무를 끝내고 HUB(QnA에서 돌아올 때 "이어서 접수"라고 하지 않게)
            Transition("order.leave", "HUB", say="HUB_ASK", asks=True, action=lambda ctx: setattr(ctx.flow, "task", None)),
            Transition("pickup.past", STAY, action=past_pickup),
            # 그 밖의 기록·제안 답·주소록 찾기 결과: 단계는 그대로, 할 말(빠진 항목·제안)을 새로 계산한다
            *(Transition(e, STAY) for e in ("order.updated", "pins.one", "pins.many", "pins.none",
                                              "pins.ask_name", "pins.ask_place")),
        ),
    ),
    Stage(
        name="A_CONFIRM",
        description="접수 내용 되읽고 확인(택배를 담기 전)",
        tools=ORDER_TOOLS,  # 아니라고 하면 고칠 값을 기록한다
        ask="A_CONFIRM",
        choices=lambda ctx: YES_NO,
        on_answer=event_answer,
        confirm=True,
        transitions=(
            Transition("order.updated", "ORDER", lambda ctx: not order_complete(ctx)),  # 고치다 값이 비면 다시 받기
            # 결제 방식을 물어야 하면(후불 자격 둘) 운임만 말하고 결제 단계에서 묻는다. 고른 답이 확정이다
            Transition("answer.yes", "A_PAYMENT", payment_asked, say=fare_text),
            # A_PAYMENT 진입은 되돌릴 수 없는 확정으로 이어진다: commit_delay_ms 동안 새 입력이 없을 때만(§2.5(3))
            Transition("answer.yes", "A_PAYMENT", say=fare_and_payment, commit=True),
            Transition("answer.no", STAY, say="A_CONFIRM_FIX"),
            Transition("order.updated", STAY),  # 고친 뒤에는 바뀐 내용으로 다시 되읽는다
        ),
    ),
    Stage(
        name="A_PAYMENT",
        description="결제 방식 정하기(후불 자격이 하나면 그것, 둘이면 묻고, 없으면 개인 카드)",
        tools=COMMON_TOOLS,
        ask="PAY_ASK",
        listen=payment_asked,
        choices=lambda ctx: PAY_CHOICES if payment_asked(ctx) else {},
        on_answer=payment_answer,
        confirm=True,
        on_enter=set_payment,
        transitions=(
            Transition(ENTERED, "A_DONE", lambda ctx: ctx.payment_method is not None),
            Transition("payment.chosen", "A_DONE", commit=True, action=use_payment_pick,
                       say=lambda ctx: PAY_TEXTS[ctx.payment_pick], asks=True),
        ),
    ),
    Stage(name="A_DONE", description="접수 완료(접수 목록에 담음)", on_enter=add_parcel,
          # 담았다고 분명히 말한다: 운임 안내 뒤 바로 추가 접수를 물어 고객이 "접수되지 않았나요"로 헷갈림(2026-11-01 23:09)
          transitions=(Transition(ENTERED, "A_CHOICE", say="A_ADDED"),)),
    Stage(
        name="A_CHOICE",
        description="추가 접수·다른 업무 고르기",
        tools=ORDER_TOOLS,  # 다음 택배 정보를 바로 말하면 기록하고 받기로 간다
        ask="A8",
        choices=lambda ctx: MORE_CHOICES,
        on_answer=more_answer,
        # 추가 접수·조회·다른 업무·더 없음은 HUB가 이어 받는다(질문은 GLOBAL_INTENT가 QNA로)
        transitions=tuple(Transition(f"hub.{c}", "HUB", forward=True) for c in MORE_CHOICES)
        + (Transition("order.updated", "ORDER"),),
    ),
]
