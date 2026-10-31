"""§5.1 B 기존 고객 택배 접수(order). 출발지는 최근 접수의 출발지를 쓰고(새 출발지를 원하면 주소만 새로 받음),
도착지는 최근 접수 1건의 도착지를 먼저 확인한 뒤 아니면 주소록 핀에서 찾는다. 물건 규격(A_ITEM_SIZE)부터는 신규 접수와
같은 노드로 합류한다. 핀 매칭은 백엔드 모델의 match_pins 도구 결과로 분기한다(§2.1). 후보를 늘어놓고 물은 뒤의
답("301호요")은 선택지라 서버 판별(①)로도 받는다. 차이 나는 값을 묻는 단계(DIFF)는 머무르지 않고 MATCH로 돌아간다."""

from app.flow.engine import ENTERED, STAY, Stage, Transition
from app.flow.stages._common import ORDER_TOOLS, ORIGIN, RECEIVER, YES_NO, done, on_updated
from app.flow.stages.new_order import address_text

MATCH_TOOLS = ORDER_TOOLS + ("match_pins",)


def start_parcel(ctx, prev: str) -> None:
    ctx.new_parcel()


def use_recent_origin(ctx) -> None:
    ctx.use_place("sender", ctx.recent_place("origin"))


def new_origin(ctx) -> bool:
    """새 출발지: 인사 질문에서 기존 출발지가 아니라고 했거나, 최근 접수 정보가 없음(§9)."""
    return ctx.new_origin_requested or ctx.recent_place("origin") is None


def change_origin(ctx, prev: str) -> None:
    ctx.new_origin_requested = False  # 이번 택배에만. 다음 택배는 이번에 바꾼 출발지가 최근 출발지다
    ctx.fill_sender()


def has_recent_destination(ctx) -> bool:
    return ctx.recent_place("destination") is not None


def any_receiver(ctx) -> bool:
    return any(getattr(ctx.order, f) is not None for f in RECEIVER)


def load_pins(ctx, prev: str) -> None:
    ctx.set_pin_role(None)
    ctx.load_pins()


def matching(ctx, prev: str) -> None:
    ctx.set_pin_role("destination")


def pin_ask(ctx) -> str:
    """후보가 여럿이면 차이 나는 값으로 다시 묻고(B8), 아니면 처음 질문(B6)."""
    return "B8" if len(ctx.pin_candidates) > 1 else "B6"


def pin_choices(ctx) -> dict[str, str]:
    """후보를 늘어놓고 물었을 때의 답(선택지라 판별로도 받는다). 처음 질문의 답은 match_pins로 찾는다."""
    if len(ctx.pin_candidates) < 2:
        return {}
    labels = ctx.pin_labels()
    return {**{f"pin_{i}": label for i, label in enumerate(labels, 1)}, "other": "말한 곳이 이 중에 없다"}


async def pin_answer(ctx, answer: str) -> list[str]:
    if answer.startswith("pin_"):
        return ctx.pins_found([ctx.pin_candidates[int(answer.removeprefix("pin_")) - 1]], narrowing=True)
    return ctx.pins_found([])


async def recent_answer(ctx, answer: str) -> list[str]:
    """"이번에도 {도착지 주소}로 보내시나요?" 예면 최근 접수의 도착지(받는 분 포함)를 그대로 쓴다."""
    if answer == "yes":
        ctx.use_place("receiver", ctx.recent_place("destination"))
    return [f"destination.{answer}"]


async def verify_answer(ctx, answer: str) -> list[str]:
    """하나 남은 핀이 맞는지. 아니면 그 핀은 버리고 새 받는 분으로 받는다(B11, 2026-10-31 결정)."""
    if answer == "yes":
        ctx.use_place("receiver", ctx.pin_offer)
    else:
        ctx.pin_rejected["destination"].append(ctx.pin_offer)
        ctx.pin_offer = None
    return [f"destination.{answer}"]


def matched(ask_other: str) -> tuple[Transition, ...]:
    """match_pins 결과. B6 이후 규칙: 못 찾았는데 주소만 말했으면 이름을, 이름만 말했으면 주소를 묻는다
    (매칭 단계에서는 같은 단계를 그 문구로 다시 묻고, 확인 질문에서 바로 말했으면 매칭 단계로 옮겨 묻는다)."""
    move = {"asks": True} if ask_other != STAY else {}
    return (
        Transition("pins.one", "B_DEST_VERIFY"),
        Transition("pins.many", "B_DEST_DIFF"),
        Transition("pins.none", "A_RECEIVER_HUB"),  # B12: 핀 없음 → 수신인 정보 Hub(말한 이름·주소는 가져간다)
        Transition("pins.ask_name", ask_other, say="A2_1", **move),
        Transition("pins.ask_place", ask_other, say="A2_3", **move),
    )


STAGES = [
    Stage(
        name="B_ORIGIN_ROUTE",
        description="기존 출발지로 보낼지, 새 출발지로 보낼지",
        task="order",
        on_enter=start_parcel,
        transitions=(
            Transition(ENTERED, "B_ORIGIN_CHANGE", new_origin),  # B1
            Transition(ENTERED, "B_LOAD_RECENT", action=use_recent_origin),  # B2
        ),
    ),
    Stage(
        name="B_ORIGIN_CHANGE",
        description="출발지 변경: 보내는 분은 그대로, 출발지 주소만 새로 받기",
        tools=ORDER_TOOLS,
        fields=ORIGIN,
        # TODO(flow): 다이어그램에 문구 없음(§9). A1 ② 문구와 주소 예외 문구. 이번 주문에만 쓰고 등록 주소는 바꾸지 않는다
        field_texts={"sender_address": address_text("sender", "A1_2", "A_ADDR_RETRY_SENDER"),
                     "sender_address_detail": "A_ADDR_DETAIL"},
        on_enter=change_origin,
        transitions=on_updated("B_LOAD_RECENT", done(*ORIGIN)),  # B3
    ),
    Stage(
        name="B_LOAD_RECENT",
        description="최근 주문 1건(도착지) 불러오기",
        on_enter=load_pins,
        transitions=(
            Transition(ENTERED, "A_ITEM_SIZE", done(*RECEIVER)),  # 출발지만 다시 받은 경우(정정)
            Transition(ENTERED, "A_RECEIVER_HUB", any_receiver),  # 받는 분 정보를 받던 중 출발지를 고친 경우
            Transition(ENTERED, "B_DEST_CONFIRM_Q", has_recent_destination),  # B4
            Transition(ENTERED, "B_DEST_MATCH"),  # TODO(flow): 최근 주문이 없으면 B6("어디로 보내실 건가요?")부터(§9)
        ),
    ),
    Stage(
        name="B_DEST_CONFIRM_Q",
        description="최근 도착지로 보내는지 확인",
        tools=MATCH_TOOLS,  # "아니요, 엄마 집으로요"처럼 바로 다른 곳을 말하면 그대로 찾는다
        ask="B4",
        choices=lambda ctx: YES_NO,
        on_answer=recent_answer,
        on_enter=matching,
        unheard_ok=("no",),
        transitions=(
            Transition("destination.yes", "B_DEST_FIXED"),  # B5
            Transition("destination.no", "B_DEST_MATCH"),  # B6
        ) + matched("B_DEST_MATCH") + (Transition("order.updated", "A_RECEIVER_HUB", any_receiver),),
    ),
    Stage(
        name="B_DEST_MATCH",
        description="도착지 핀 매칭",
        tools=MATCH_TOOLS,
        ask=pin_ask,
        choices=pin_choices,
        on_answer=pin_answer,
        on_enter=matching,
        # 핀 없이 새 받는 분 정보를 말해 백엔드가 기록했으면 수신인 정보 Hub로(B12와 같은 곳)
        transitions=matched(STAY) + (Transition("order.updated", "A_RECEIVER_HUB", any_receiver),),
    ),
    Stage(
        name="B_DEST_DIFF",
        description="도착지 후보끼리 차이 나는 값(층·상세주소) 확인",
        transitions=(  # B7·B8
            Transition(ENTERED, "B_DEST_MATCH", lambda ctx: len(ctx.pin_candidates) >= 2),
            Transition(ENTERED, "B_DEST_VERIFY", lambda ctx: len(ctx.pin_candidates) == 1),
            Transition(ENTERED, "A_RECEIVER_HUB"),
        ),
    ),
    Stage(
        name="B_DEST_VERIFY",
        description="받는 분 확인",
        tools=ORDER_TOOLS,
        ask="B9",
        choices=lambda ctx: YES_NO,
        on_answer=verify_answer,
        unheard_ok=("no",),
        transitions=(
            Transition("destination.yes", "B_DEST_FIXED"),  # B10
            # B11: 다이어그램에 선 없음. 하나 남은 핀이 아니므로 새 받는 분으로(2026-10-31 결정)
            Transition("destination.no", "A_RECEIVER_HUB", say="B11_NEW"),
        ),
    ),
    Stage(name="B_DEST_FIXED", description="도착지 확정", on_enter=lambda ctx, prev: ctx.set_pin_role(None),
          transitions=(Transition(ENTERED, "A_ITEM_SIZE"),)),  # B13
]
