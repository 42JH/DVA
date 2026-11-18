"""§5.3 C 택배 조회(lookup)·취소(cancel). 받는 분 성함으로 가장 최근 택배를 찾고(lookup_orders, 도구 결과로 분기),
확인한 택배의 배송 상태를 안내한다. 취소는 고객의 "예"를 확정 지연(§2.5(3)) 뒤에 서버가 cancel_order로 실행한다
(백엔드 모델이 부르면 단계가 늦게 바뀌어 거절될 수 있다). 수정은 보류(§5.4): 제한된 요청으로 보낸다(§9)."""

from app.flow.engine import ENTERED, STAY, Stage, Transition
from app.flow.stages._common import COMMON_TOOLS, YES_NO, count_fail, reset_fail

FIND_CHOICES = {"forgot": "받는 분이 누구였는지 기억나지 않는다", "unclear": "받는 분 성함을 말했지만 알아들을 수 없음"}
RETRY_CHOICES = {"yes": "다시 확인해 달라", "no": "그만두겠다·괜찮다"}
CHOICE_CHOICES = {"cancel": "접수를 취소하겠다", "modify": "접수 내용을 수정하겠다", "no": "필요 없다·아니요",
                  "ambiguous": "답했지만 취소·수정·필요 없음 중 무엇인지 모호함"}
# TODO(flow): 백엔드 주문 상태 값이 정해지면 맞춘다. 접수만 된 택배만 전화로 취소한다
# 백엔드 취소 가능: 미완료(COLLECTING)·개인 카드 결제 대기(notPaid). 결제가 끝난 뒤(PAID·SUBMITTING·ACCEPTED·SUBMISSION_FAILED)는 불가
CANCELLABLE, CANCELLED = ("COLLECTING", "notPaid"), ("CANCELLED",)


def find_ask(ctx):
    lookup = ctx.lookup
    if lookup.get("failed"):
        return "C3_FAIL"  # 조회가 안 됨(업무 처리 불가)
    if lookup.get("name") and lookup.get("searched") and not lookup.get("orders"):
        return "C2_NONE"  # 그분께 보낸 택배 없음: 같은 단계
    return "C1"


def find_choices(ctx) -> dict[str, str]:
    return RETRY_CHOICES if ctx.lookup.get("failed") else FIND_CHOICES


async def find_answer(ctx, answer: str) -> list[str]:
    lookup = ctx.lookup
    if answer == "forgot":  # 최근에 접수한 택배부터 차례로
        return await ctx.find_orders(None, forgot=True)
    if answer == "unclear":
        return ["find.unclear"]
    if answer == "no":
        return ["lookup.quit"]
    if lookup.get("fails", 0) > ctx.cfg.flow.retry_limit:  # 다시 조회 상한(§9)
        return ["lookup.giveup"]
    return await ctx.find_orders(lookup.get("name"), forgot=lookup.get("forgot", False))


def record_ask(ctx):
    return "C2" if ctx.lookup.get("index", 0) == 0 else "C2_NO"


async def record_answer(ctx, answer: str) -> list[str]:
    lookup = ctx.lookup
    if answer == "yes":
        ctx.target_order = lookup["orders"][lookup["index"]]
        if not ctx.target_order.get("status"):  # 배송 상태를 확인하지 못함(조회가 안 됨)
            lookup.update(failed=True, fails=lookup.get("fails", 0) + 1)
            return ["record.failed"]
        return ["record.yes"]
    lookup["index"] += 1  # 그 전 택배로 C2 반복
    return ["record.next"] if lookup["index"] < len(lookup["orders"]) else ["record.end"]


async def choice_answer(ctx, answer: str) -> list[str]:
    return ["intent.restricted"] if answer == "modify" else [f"choice.{answer}"]


def status_is(statuses):
    return lambda ctx: (ctx.target_order or {}).get("status") in statuses


async def confirm_answer(ctx, answer: str) -> list[str]:
    return [f"cancel.{answer}"]


def cancel_failed(ctx) -> None:
    ctx.cancel_state = "failed"
    count_fail(ctx)


async def cancel_answer(ctx, answer: str) -> list[str]:
    if answer == "no":
        return ["cancel.no"]
    if ctx.cancel_attempts > ctx.cfg.flow.retry_limit:  # 다시 취소 상한(§9)
        return ["cancel.giveup"]
    ctx.start_cancel()  # 재시도 전에 원래 요청이 이미 처리됐는지 조회로 확인한다(cancel_order)
    return []


STAGES = [
    Stage(name="C_REQUIRED_INFO", description="조회에 필요한 정보(받는 분 성함) 묻기", task="lookup",
          # 어느 업무 중이든 이미 보낸 택배를 조회·취소하겠다고 하면(switch_task lookup) 조회로(spec/flow.md 업무 전환)
          enter_on=("intent.lookup",),
          on_enter=lambda ctx, prev: ctx.lookup.clear(), transitions=(Transition(ENTERED, "C_FIND_RECENT"),)),
    Stage(
        name="C_FIND_RECENT",
        description="받는 분 확인 / 가장 최근 택배 찾기",
        tools=COMMON_TOOLS + ("lookup_orders",),
        ask=find_ask,
        choices=find_choices,
        on_answer=find_answer,
        transitions=(
            Transition("lookup.found", "C_CHECK_RECORD",
                       say=lambda ctx: "C1_FORGOT" if ctx.lookup.get("forgot") else None),
            Transition("find.unclear", STAY, say="C1_RETRY"),
            Transition("lookup.failed", STAY, action=count_fail),
            Transition("lookup.none", STAY, lambda ctx: bool(ctx.lookup.get("name"))),  # 그분께 보낸 택배 없음: 같은 단계
            # TODO(flow): 이 번호로 접수된 택배가 하나도 없음·재시도 상한·그만둠은 다이어그램에 없음
            Transition("lookup.none", "HUB", lambda ctx: not ctx.lookup.get("name"), say="C_NO_ORDERS"),
            Transition("lookup.giveup", "HUB"),
            Transition("lookup.quit", "HUB"),
        ),
    ),
    Stage(
        name="C_CHECK_RECORD",
        description="택배 기록 확인",
        ask=record_ask,
        choices=lambda ctx: YES_NO,
        on_answer=record_answer,
        unheard_ok=("no",),
        # §2.4 C_CHECK_RECORD 도달(택배를 찾음). QnA에서 돌아온 것은 새로 찾은 것이 아니다
        on_enter=lambda ctx, prev: reset_fail(ctx) if prev == "C_FIND_RECENT" else None,
        transitions=(
            Transition("record.yes", "C_CHOICE"),
            Transition("record.next", STAY),  # 그 전 택배로 C2 반복(앞 경로의 안내는 되풀이하지 않는다)
            Transition("record.failed", "C_FIND_RECENT", action=count_fail),
            Transition("record.end", "C_FIND_RECENT", say="C2_END", action=lambda ctx: ctx.lookup.clear()),
        ),
    ),
    Stage(
        name="C_CHOICE",
        description="배송 상태 안내 후 취소·수정 여부",
        ask="C3",
        choices=lambda ctx: CHOICE_CHOICES,
        on_answer=choice_answer,
        transitions=(
            Transition("choice.cancel", "C_CANCEL_INFO"),
            Transition("choice.no", "HUB", say="C4", asks=True),
            Transition("choice.ambiguous", STAY, say="C3_UNCLEAR"),
        ),
    ),
    Stage(
        name="C_CANCEL_INFO",
        description="취소할 택배 확인",
        task="cancel",
        on_enter=lambda ctx, prev: setattr(ctx, "cancel_attempts", 0),
        transitions=(
            Transition(ENTERED, "HUB", status_is(CANCELLED), say="C7_CANCELLED"),  # 이후 HUB는 §9
            Transition(ENTERED, "C_CANCEL_CONFIRM", status_is(CANCELLABLE)),
            # 이미 접수가 진행됨(다이어그램은 "이미 수거·배송 중", 업무 처리 불가 +1)
            Transition(ENTERED, "HUB", say="C7_LOCKED", asks=True, action=count_fail),
        ),
    ),
    Stage(
        name="C_CANCEL_CONFIRM",
        description="취소 동의 확인",
        ask="C7",
        choices=lambda ctx: YES_NO,
        on_answer=confirm_answer,
        confirm=True,
        consent=("yes",),  # 취소로 이어진다(두 열쇠)
        unheard_ok=("no",),
        transitions=(
            # 되돌릴 수 없는 확정: commit_delay_ms 동안 새 입력이 없을 때만 취소를 시작한다(§2.5(3))
            Transition("cancel.yes", "C_CANCEL", commit=True, action=lambda ctx: ctx.start_cancel()),
            Transition("cancel.no", "HUB", say="C10"),
        ),
    ),
    Stage(
        name="C_CANCEL",
        description="접수 취소 처리",
        tools=("get_state", "cancel_order"),  # 서버만 부른다(백엔드 모델 도구 목록에 없음)
        ask=lambda ctx: "C9_FAIL" if ctx.cancel_state == "failed" else "C_CANCEL_RUNNING",
        # 실행 중에는 듣지 않는다(끼어든 말은 쌓았다가 결과를 안내한 뒤 판별, §2.5(5)). 실패하면 다시 시도할지 듣는다
        listen=lambda ctx: ctx.cancel_state == "failed",
        choices=lambda ctx: YES_NO,
        on_answer=cancel_answer,
        confirm=True,
        consent=("yes",),  # 취소를 다시 시도한다(두 열쇠)
        transitions=(
            Transition("cancel.done", "HUB", say="C9", asks=True, action=reset_fail),
            Transition("cancel.failed", STAY, action=cancel_failed),
            Transition("cancel.already", "HUB", say="C7_CANCELLED"),
            Transition("cancel.locked", "HUB", say="C7_LOCKED", asks=True, action=count_fail),
            Transition("cancel.no", "HUB"),
            Transition("cancel.giveup", "HUB"),  # TODO(flow): 재시도 상한(§9)을 넘으면 업무 처리 불가로 보고 HUB
        ),
    ),
]
