"""상태 엔진. 업무를 모른다: 단계 정의를 LangGraph 상태 그래프(단계 = 노드)로 엮어 "현재 단계 + 사건 → 다음 단계"를
계산하고, 허용 도구 확인과 진행 상태 문구 생성만 한다(spec/flow.md).

사건 하나 = 그래프 실행 한 번: 현재 단계 노드에서 시작해 전이가 없을 때까지 노드를 옮겨 다닌다.
진행 상태(FlowState)는 통화 객체가 들고(가드·관제·도구 결과가 모두 본다), 그래프에는 통화 객체를 context로 넘긴다.

할 말은 두 갈래다. 전이마다 붙은 말(say: 다이어그램 화살표의 문구)을 이번 실행 경로대로 모으고, 머무는 단계의
질문(ask)을 붙인다. 질문은 그릴 때마다 다시 계산한다(예외 문구·정정 중 다시 묻기).

ctx(통화 객체)에 기대하는 것: flow(FlowState), texts(Texts), field_done(name) -> bool,
recorded() -> [(label, value)], text_vars() -> dict, now_ms() -> int(세션 타임라인, 받아쓰기 전에는 0), heard_rev(고객 말 리비전).
"""

import dataclasses
import importlib
import inspect
import pkgutil
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from langgraph.errors import GraphRecursionError
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import Command
from pydantic import BaseModel

RETURN = "@return"  # 하위 흐름(QnA·상담원 Hub)을 끝내고 들어오기 전 업무 단계로 돌아간다(RESUME_TASK)
STAY = "@stay"  # 단계를 옮기지 않고 같은 단계를 예외 문구로 다시 묻는다(구간 예외)
ENTERED = "stage.entered"  # 단계에 들어온 직후 한 번 내는 사건(머무르지 않는 단계·건너뛰기 조건용)
COMMIT = "commit.due"  # 확정 지연이 끝남(§2.5(3)). 미뤄 둔 전이를 실행한다
COMMIT_WAIT = "COMMIT_WAIT"  # 확정을 기다리는 동안의 할 일(새 질문 없이 기다림)
CORRECT_ASK = "CORRECT_ASK"  # 정정한다고만 하고 값을 말하지 않았을 때 그 항목을 다시 묻는 문구 키(§2.5(4))
MAX_HOPS = 10  # 사건 하나로 이만큼 옮겨 가면 정의 오류(전이가 끝나지 않음)

Key = str | Callable[[Any], "str | tuple[str, ...] | None"] | None  # 문구 키, 또는 ctx → 문구 키(들)


def always(ctx: Any) -> bool:
    return True


@dataclass(frozen=True)
class Transition:
    event: str
    target: str
    guard: Callable[[Any], bool] = always
    say: Key = None  # 이 전이에서 할 말(다이어그램 화살표의 문구)
    asks: bool = False  # say가 들어간 단계의 질문까지 한다(그 단계의 ask를 덧붙이지 않는다)
    action: Callable[[Any], None] | None = None  # 전이할 때 할 일(실패 횟수 등)
    forward: bool = False  # 들어간 단계가 같은 사건을 먼저 본다(고른 업무를 HUB가 이어 받기 등)
    commit: bool = False  # 바로 옮기지 않고 확정 지연 뒤에 옮긴다(되돌릴 수 없는 확정, §2.5(3))


@dataclass(frozen=True)
class Stage:
    name: str  # 다이어그램 노드 ID
    description: str  # 관제·진행 상태용
    tools: tuple[str, ...] = ("get_state",)
    transitions: tuple[Transition, ...] = ()
    fields: tuple[str, ...] = ()  # 받을 항목과 순서(항목 받는 단계). 질문은 빠진 첫 항목의 문구
    field_texts: dict = field(default_factory=dict)  # 항목 → 문구 키(또는 ctx → 문구 키)
    ask: Key = None  # 머무를 때의 질문. 복귀(RESUME_TASK) 뒤에도 이것을 다시 묻는다
    # 고객 답 판별(app/listener.py): 이 단계에서 고객 말을 듣는지, 답 선택지(값 → 뜻), 답에 따른 처리(→ 사건)
    listen: bool | Callable[[Any], bool] = True
    choices: Callable[[Any], dict[str, str]] | None = None
    on_answer: Callable[[Any, str], Awaitable[list[str]]] | None = None
    unheard_ok: tuple[str, ...] = ()  # 질문을 다 듣기 전에 말해도 받는 답(되돌릴 수 있는 거절, §2.5(1))
    # 답마다 바로 이어서 할 말을 단계가 직접 계산할 때(전이로 갈 곳이 정해지지 않는 단계, 예: ORDER의 제안)
    preview: Callable[[Any], list[tuple[str, list[str]]]] | None = None
    # 받을 항목이 둘 이상 남았을 때 "그다음" 항목도 알려 줄지(답에 따라 다음이 갈리는 질문이면 False)
    then: Callable[[Any], bool] | None = None
    subflow: bool = False  # QnA·상담원 Hub: 들어오기 전 업무 단계를 기억했다가 RETURN으로 돌아간다
    final: bool = False  # 통화를 끝내는 단계. 끼어드는 용건(enter_on)으로 나가지 않는다
    enter_on: tuple[str, ...] = ()  # 이 사건이 나면 어느 단계에서나(final 제외) 이 단계로 들어온다
    task: str | None = None  # 들어오면 진행 중 업무를 이것으로
    start_if: Callable[[Any], bool] | None = None  # 통화 시작 단계 조건
    on_enter: Callable[[Any, str], None | Awaitable[None]] | None = None  # (ctx, 이전 단계). async도 된다


class FlowState(BaseModel):
    stage: str
    task: str | None = None  # 진행 중 업무(order · lookup · cancel)
    resume: dict | None = None  # {"task", "stage"}: QnA·상담원으로 빠지기 직전 업무 단계(§2.2)
    say: list[str] = []  # 마지막 전이 경로에서 할 말(문구 키)
    say_asks: bool = False  # say가 머무는 단계의 질문까지 했음
    variant: str | None = None  # 같은 단계를 다시 물을 예외 문구(STAY 전이). 단계를 옮기면 지운다
    variant_field: str | None = None  # 그 예외 문구가 묻던 항목(그 항목이 차면 예외 문구도 끝난다)
    notice: list[str] = []  # 다음 진행 상태 한 번만 앞에 붙일 말(정정 확인). 보낸 뒤 지운다
    correcting: str | None = None  # 고친다고만 하고 값을 아직 말하지 않은 항목(그 항목을 다시 묻는다)
    pending: dict | None = None  # 확정 지연 중인 전이 {stage, transition, at, rev, suspended}
    entered_ms: int | None = None  # 지금 단계에 들어온 세션 타임라인 시각(꼬리 조각·질문을 들었는지 판단)
    reasked: bool = False  # 이 단계에서 "질문을 다 듣기 전 답"으로 한 번 다시 물었음
    history: list[dict] = []


class Step(BaseModel):
    """그래프 한 번 실행하는 동안의 상태: 지금 단계와 보고 있는 사건(개인정보 없음)."""

    stage: str
    event: str
    tool: str | None = None
    moved: bool = False  # 이번 실행에서 이미 옮겼음(할 말을 새 경로로 모은다)


class FlowError(Exception):
    pass


STAGES: dict[str, Stage] = {}
GROUPS: dict[str, str] = {}  # 단계 → 정의한 모듈 이름(관제 그림에서 흐름별로 묶는다)
GRAPH: Any = None  # build()가 만든 그래프(통화끼리 같이 쓴다. 통화별 상태는 context로)


def load_stages(package: str = "app.flow.stages") -> dict[str, Stage]:
    """stages 패키지의 모든 모듈에서 STAGES 목록을 모은다. 이름이 겹치면 실패."""
    pkg = importlib.import_module(package)
    found: dict[str, Stage] = {}
    for info in pkgutil.iter_modules(pkg.__path__):
        if info.name.startswith("_"):
            continue
        module = importlib.import_module(f"{package}.{info.name}")
        for stage in getattr(module, "STAGES", ()):
            if stage.name in found:
                raise FlowError(f"단계 이름 중복: {stage.name}")
            found[stage.name] = stage
            GROUPS[stage.name] = info.name
    STAGES.clear()
    STAGES.update(found)
    return found


def validate(tool_names: set[str], texts: Any, sample_vars: dict) -> None:
    """정의가 가리키는 단계·도구·문구가 모두 있는지, 문구의 자리표시자가 맞는지. 실패하면 기동을 멈춘다.
    ctx를 받는 문구 키(callable)는 실행 때 정해지므로 시나리오 테스트가 확인한다."""
    errors = []
    if not any(s.start_if for s in STAGES.values()):
        errors.append("시작 단계가 없음")
    known = set(texts.say) | set(texts.note)
    for s in STAGES.values():
        errors += [f"{s.name}: 없는 도구 {t}" for t in s.tools if t not in tool_names]
        errors += [f"{s.name}: 없는 단계 {t.target}" for t in s.transitions
                   if t.target not in (RETURN, STAY) and t.target not in STAGES]
        keys = [k for k in (s.ask, *s.field_texts.values(), *(t.say for t in s.transitions)) if isinstance(k, str)]
        errors += [f"{s.name}: 문구 없음 {k}" for k in keys if k not in known]
        errors += [f"{s.name}: 항목 문구 없음 {f}" for f in s.fields if f not in s.field_texts]
    errors += [f"핵심 구간의 질문 문구 없음: {k}" for k in texts.core if k not in texts.say]
    for name, table in (("say", texts.say), ("note", texts.note), ("core", texts.core)):
        for key, tpl in table.items():
            try:
                tpl.format(**sample_vars)
            except (KeyError, IndexError, ValueError) as e:
                errors.append(f"문구 자리표시자 오류 {name}.{key}: {e}")
    if errors:
        raise FlowError("; ".join(errors))


def build() -> None:
    """검증을 통과한 단계 정의로 그래프를 만든다(기동 시 한 번). 모든 단계 노드는 같은 _step이고,
    어디로 갈지는 노드가 전이를 보고 정한다. destinations는 그림(get_graph)에 엣지를 그리기 위한 것."""
    global GRAPH
    graph = StateGraph(Step)
    for stage in STAGES.values():
        graph.add_node(stage.name, _step, destinations=_destinations(stage))
    graph.add_conditional_edges(START, _enter, list(STAGES))
    GRAPH = graph.compile()


def _destinations(stage: Stage) -> tuple[str, ...]:
    """이 단계에서 갈 수 있는 단계: 전이 대상, 이 단계에서 들어갈 수 있는 끼어드는 단계, 복귀면 하위 흐름이 아닌 단계."""
    out = {t.target for t in stage.transitions if t.target not in (RETURN, STAY)}
    if not stage.final:
        out |= {s.name for s in STAGES.values() if s.enter_on and s.name != stage.name}
    if any(t.target == RETURN for t in stage.transitions):
        out |= {s.name for s in STAGES.values() if not s.subflow}
    return (*sorted(out), END)


async def _enter(step: Step) -> str:
    return step.stage


async def _step(step: Step, runtime: Runtime) -> Command:
    """현재 단계에서 사건 하나를 본다. 노드·라우터는 async여야 한다: ainvoke는 동기 함수를 다른 스레드에서 돌리는데
    통화 객체와 관제 버스는 스레드 안전하지 않다. 가드는 여기서 부른다(조건부 엣지 함수로 쓰지 않는다)."""
    ctx = runtime.context
    t = _due_commit(ctx) if step.event == COMMIT else _target(ctx, step.event)
    if t is None:
        return Command(goto=END)
    if t.commit:  # 되돌릴 수 없는 확정: 새 입력 없이 commit_delay_ms가 지나면 COMMIT 사건으로 옮긴다
        ctx.flow.pending = {"stage": ctx.flow.stage, "transition": t, "at": time.monotonic(),
                            "rev": ctx.heard_rev, "suspended": False}
        # 이 전이의 말(운임·결제 안내)은 옮길 때 다음 질문(추가 접수)과 한 진행 상태로 차례대로 준다. 기다리는 동안
        # 미리 주면 도구 결과로 늦게 도착해, 확정 뒤의 다음 질문이 먼저 나갔다(2026-10-31 통화)
        ctx.flow.say, ctx.flow.say_asks = [COMMIT_WAIT], True
        return Command(goto=END)
    if t.target == STAY:  # 같은 단계를 예외 문구로 다시 묻는다
        if t.action:
            t.action(ctx)
        m = missing(ctx)
        ctx.flow.variant, ctx.flow.variant_field = _key(ctx, t.say), m[0] if m else None
        # 새 질문(정보 받기는 단계 하나라 기록·제안 답마다 질문이 바뀐다): 다 듣기 전 답을 다시 묻는 것도 이 질문에서 한 번,
        # 이 질문 전에 시작한 말(앞 답의 늦은 꼬리 "네네")은 이 질문의 답으로 쓰지 않는다(§2.5(2), 진입 시각을 새로)
        ctx.flow.say, ctx.flow.say_asks, ctx.flow.reasked = [], False, False
        ctx.flow.entered_ms = ctx.now_ms()
        return Command(goto=END)
    await _move(ctx, t, step)
    # 끼어드는 단계로 들어왔거나 넘겨 받는 전이면 들어간 단계가 같은 사건을 먼저 본다. 아니면 들어온 직후 사건
    event = step.event if t.forward and _target(ctx, step.event) is not None else ENTERED
    return Command(goto=ctx.flow.stage, update={"stage": ctx.flow.stage, "event": event, "moved": True})


def _due_commit(ctx: Any) -> Transition | None:
    p = ctx.flow.pending
    if not p or p["suspended"] or p["stage"] != ctx.flow.stage:
        return None
    return dataclasses.replace(p["transition"], commit=False)


async def start(ctx: Any) -> None:
    """통화 시작 단계로 들어간다(들어온 직후 조건도 평가)."""
    ctx.flow.stage = start_stage(ctx)
    ctx.flow.entered_ms = ctx.now_ms()
    await apply(ctx, [ENTERED])


def start_stage(ctx: Any) -> str:
    for s in STAGES.values():
        if s.start_if and s.start_if(ctx):
            return s.name
    raise FlowError("시작 조건에 맞는 단계가 없음")


def current(ctx: Any) -> Stage:
    return STAGES[ctx.flow.stage]


def listening(ctx: Any) -> bool:
    listen = current(ctx).listen
    return listen(ctx) if callable(listen) else listen


def gated(ctx: Any) -> bool:
    """지금 단계가 확정 관문(확정 지연 전이가 있음: 담기·결제·취소 확인). 여기서는 다른 용건이 섞인 답을 받지 않는다."""
    return any(t.commit for t in current(ctx).transitions)


def allowed_tools(ctx: Any) -> tuple[str, ...]:
    return current(ctx).tools


def missing(ctx: Any) -> list[str]:
    """빈 항목(단계의 순서대로). 못 찾아 지운 주소(ctx.address_retry)는 맨 앞: 다른 항목보다 먼저 다시 묻는다."""
    retry = getattr(ctx, "address_retry", ())
    return sorted((f for f in current(ctx).fields if not ctx.field_done(f)), key=lambda f: f not in retry)


def _key(ctx: Any, key: Key) -> Any:
    return key(ctx) if callable(key) else key


def _keys(value: Any) -> list[str]:
    return [] if not value else [value] if isinstance(value, str) else list(value)


def field_key(ctx: Any, name: str) -> str:
    return _key(ctx, current(ctx).field_texts[name])


def question(ctx: Any) -> list[str]:
    """머무는 단계의 질문(문구 키들): 정정 중이면 다시 묻기, 예외 문구, 항목 받는 단계면 빠진 첫 항목, 아니면 ask."""
    if ctx.flow.correcting:
        return [CORRECT_ASK]
    m = missing(ctx)
    if ctx.flow.variant and (m[0] if m else None) == ctx.flow.variant_field:
        return [ctx.flow.variant]
    if m:
        return [field_key(ctx, m[0])]
    return _keys(_key(ctx, current(ctx).ask))


def question_key(ctx: Any) -> str | None:
    """고객이 지금 답하는 질문의 문구 키(핵심 구간을 찾을 때). 들어오는 전이의 말이 질문까지 했으면 그 말."""
    keys = ctx.flow.say if ctx.flow.say_asks else question(ctx)
    return keys[-1] if keys else None


def render(ctx: Any, key: str) -> str:
    texts, values = ctx.texts, ctx.text_vars()
    if key in texts.note:
        return texts.note[key].format(**values)
    return "'" + texts.say[key].format(**values) + "'"


def next_text(ctx: Any) -> str:
    """다음에 할 말: 한 번만 붙일 말 + 마지막 전이 경로의 말 + 머무는 단계의 질문."""
    flow = ctx.flow
    keys = [*flow.notice, *flow.say]
    if not flow.say_asks or flow.correcting:
        keys += [k for k in question(ctx) if k not in keys]
    return " ".join(render(ctx, k) for k in keys) or current(ctx).description


def handles(ctx: Any, event: str) -> bool:
    """지금 단계에서 이 사건으로 갈 곳이 있음."""
    return _target(ctx, event) is not None


def _target(ctx: Any, event: str) -> Transition | None:
    stage = current(ctx)
    for t in stage.transitions:
        if t.event == event and t.guard(ctx):
            return t
    if not stage.final:
        for s in STAGES.values():
            if event in s.enter_on and s.name != stage.name:
                return Transition(event, s.name, forward=True)
    return None


async def _move(ctx: Any, t: Transition, step: Step) -> None:
    state = ctx.flow
    prev, target = state.stage, t.target
    if t.action:
        t.action(ctx)
    if target == RETURN:  # RESUME_TASK: 저장해 둔 업무 단계로(고정 엣지 없이)
        back = state.resume or {}
        target = back.get("stage") or start_stage(ctx)
        state.task = back.get("task", state.task)
        state.resume = None
    elif STAGES[target].subflow:
        if not STAGES[prev].subflow:  # 이미 QnA·상담원 흐름 안이면 덮어쓰지 않는다
            state.resume = {"task": state.task, "stage": prev}
    else:
        state.resume = None
    if not step.moved:
        state.say = []
    say = _key(ctx, t.say)
    state.say += _keys(say)
    state.say_asks = bool(say) and t.asks
    state.stage, state.variant, state.pending, state.reasked, state.correcting = target, None, None, False, None
    state.entered_ms = ctx.now_ms()
    if STAGES[target].task:
        state.task = STAGES[target].task
    state.history.append({"at": time.time(), "ms": state.entered_ms, "from": prev, "to": target, "event": step.event,
                          "tool": step.tool})
    if STAGES[target].on_enter and inspect.isawaitable(done := STAGES[target].on_enter(ctx, prev)):
        await done


async def apply(ctx: Any, events: list[str], tool: str | None = None) -> None:
    """도구·답 처리가 낸 사건마다 그래프를 한 번 실행해 단계를 옮긴다."""
    for event in events:
        try:
            # 노드 실행 수 = 이동 수 + 1이고, LangGraph는 실행 수가 한도에 닿으면 멈춘다 → MAX_HOPS번째 이동에서 실패
            await GRAPH.ainvoke(Step(stage=ctx.flow.stage, event=event, tool=tool), context=ctx,
                                config={"recursion_limit": MAX_HOPS + 1})
        except GraphRecursionError:
            raise FlowError(f"단계 전이가 끝나지 않음: {ctx.flow.stage}") from None


def summary(ctx: Any) -> dict:
    """모든 도구 결과에 붙이는 상태 요약(백엔드는 thinking.append를 받지 않는다)."""
    return {
        "stage": ctx.flow.stage,
        "missing": missing(ctx),
        "tools": list(allowed_tools(ctx)),
        "recorded": dict(ctx.recorded()),
        "next": next_text(ctx),
    }


def preview(ctx: Any) -> list[tuple[str, list[str]]]:
    """선택지를 묻는 단계에서 답마다 바로 이어서 할 말(문구 키들). 음성 모델은 고객 말이 끝나자마자 말을 시작해
    판별·진행 상태보다 앞서고, 그때 다음 질문을 스스로 지었다(2026-10-31 통화: "접수할게요" 뒤 "어디에서 보내시나요?",
    진행 상태가 온 뒤 다시 성함). 답의 사건은 on_answer가 정하지만 "<무엇>.<답>" 꼴이라 그 이름으로 전이를 찾는다."""
    stage = current(ctx)
    if not stage.choices or not listening(ctx):
        return []
    if stage.preview:
        return stage.preview(ctx)
    out = []
    for choice, meaning in stage.choices(ctx).items():
        t = next((t for t in stage.transitions if t.event.rsplit(".", 1)[-1] == choice and t.guard(ctx)), None)
        keys = _ahead(ctx, t) if t else None
        if keys:
            out.append((meaning, keys))
    return out


def _ahead(ctx: Any, t: Transition) -> list[str] | None:
    """이 전이로 가면 할 말. 들어온 직후 전이는 지금 상태로 가드를 보고 따라간다(답 처리가 가드를 바꾸는 답은 갈 곳을
    직접 가리키게 단계를 정의한다, 예: 인사의 new_origin). 넘겨 받기·확정 지연·같은 단계 다시 묻기·복귀는 미리 말하지
    않는다(None)."""
    if t.target in (STAY, RETURN) or t.forward or t.commit:
        return None
    say = _keys(_key(ctx, t.say))
    if say and t.asks:
        return say
    stage = STAGES[t.target]
    for _ in range(MAX_HOPS):
        e = next((e for e in stage.transitions if e.event == ENTERED and e.guard(ctx)), None)
        if e is None:
            break
        if e.target in (STAY, RETURN) or e.commit:
            return None
        say += _keys(_key(ctx, e.say))
        stage = STAGES[e.target]
    else:
        return None
    m = [f for f in stage.fields if not ctx.field_done(f)]
    return say + ([_key(ctx, stage.field_texts[m[0]])] if m else _keys(_key(ctx, stage.ask))) or None


def progress_text(ctx: Any, max_chars: int) -> str:
    """음성 모델에 thinking.append로 줄 "다음에 할 말 + 기록된 값". max_chars를 넘지 않는다."""
    texts = ctx.texts
    nxt = next_text(ctx)
    m = missing(ctx)
    ahead = preview(ctx)
    stage = current(ctx)
    asking = bool(stage.choices and listening(ctx) and stage.choices(ctx))
    # 기록이 한 박자 늦어 방금 답한 항목을 또 묻지 않게 그다음 항목도 알려 준다(답을 고르는 질문 중에는 답마다 알려 줌)
    hint = len(m) > 1 and not asking and (stage.then is None or stage.then(ctx))
    then = texts.progress_then.format(next2=render(ctx, field_key(ctx, m[1]))) if hint else ""
    if ahead:  # 답을 고르는 질문: 판별을 기다리지 않고 바로 맞는 다음 말을 하게
        then += texts.progress_preview.format(items=texts.progress_sep.join(
            texts.progress_preview_item.format(choice=c, next=" ".join(render(ctx, k) for k in keys))
            for c, keys in ahead))
    items = ctx.recorded()
    for cut in (None, 40, 24, 12, 6, 0):
        shown = [(k, v if cut is None else v[:cut]) for k, v in items] if cut != 0 else []
        recorded = (texts.progress_sep.join(texts.progress_item.format(label=k, value=v) for k, v in shown)
                    or texts.empty_value)
        text = texts.progress.format(stage=current(ctx).description, recorded=recorded, next=nxt, then=then)
        if len(text) <= max_chars:
            return text
    return text[:max_chars]
