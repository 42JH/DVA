"""상태 엔진. 업무를 모른다: 단계 정의를 LangGraph 상태 그래프(단계 = 노드)로 엮어 "현재 단계 + 사건 → 다음 단계"를
계산하고, 허용 도구 확인과 진행 상태 문구 생성만 한다(spec/flow.md).

사건 하나 = 그래프 실행 한 번: 현재 단계 노드에서 시작해 전이가 없을 때까지 노드를 옮겨 다닌다.
진행 상태(FlowState)는 통화 객체가 들고(가드·관제·도구 결과가 모두 본다), 그래프에는 통화 객체를 context로 넘긴다.

ctx(통화 객체)에 기대하는 것: flow(FlowState), texts(Texts), field_done(name) -> bool,
recorded() -> [(label, value)], text_vars() -> dict, stage_variant(stage) -> str | None.
"""

import importlib
import inspect
import pkgutil
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from langgraph.errors import GraphRecursionError
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import Command
from pydantic import BaseModel

RETURN = "@return"  # 하위 흐름을 끝내고 들어온 단계로 돌아간다
ANY = "*"  # enter_from에 쓰면 어느 단계에서나 들어올 수 있다(자기 자신 제외)
ENTERED = "stage.entered"  # 단계에 들어온 직후 한 번 내는 사건(바로 다음 단계로 넘길 조건용)
MAX_HOPS = 5  # 사건 하나로 이만큼 옮겨 가면 정의 오류(전이가 끝나지 않음)


def always(ctx: Any) -> bool:
    return True


@dataclass(frozen=True)
class Transition:
    event: str
    target: str
    guard: Callable[[Any], bool] = always


@dataclass(frozen=True)
class Stage:
    name: str
    description: str  # 관제·문서용
    tools: tuple[str, ...]
    transitions: tuple[Transition, ...] = ()
    fields: tuple[str, ...] = ()  # 받을 항목과 순서(수집 단계)
    order: Callable[[Any], tuple[str, ...]] | None = None  # 상황에 따라 순서가 다르면(fields의 순열)
    variants: tuple[str, ...] = ()  # 같은 단계 안의 결과별 안내 문구("단계.variant")
    # 고객 답 판별(app/listener.py): 이 단계에서 고객 말을 듣는지, 답 선택지(값 → 뜻), 답에 따른 처리(→ 사건)
    listen: bool = True
    choices: Callable[[Any], dict[str, str]] | None = None
    on_answer: Callable[[Any, str], Awaitable[list[str]]] | None = None
    subflow: bool = False  # 들어온 단계를 기억했다가 RETURN으로 돌아간다
    enter_on: str | None = None  # 이 사건이 enter_from 단계에서 나면 이 단계로 들어온다
    enter_from: tuple[str, ...] = ()
    start_if: Callable[[Any], bool] | None = None  # 통화 시작 단계 조건
    on_enter: Callable[[Any, str], None | Awaitable[None]] | None = None  # (ctx, 이전 단계). async도 된다


class FlowState(BaseModel):
    stage: str
    return_to: str | None = None
    history: list[dict] = []


class Step(BaseModel):
    """그래프 한 번 실행하는 동안의 상태: 지금 단계와 보고 있는 사건(개인정보 없음)."""

    stage: str
    event: str
    tool: str | None = None


class FlowError(Exception):
    pass


STAGES: dict[str, Stage] = {}
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
    STAGES.clear()
    STAGES.update(found)
    return found


def validate(tool_names: set[str], texts: Any, sample_vars: dict) -> None:
    """정의가 가리키는 단계·도구·문구가 모두 있는지. 실패하면 기동을 멈춘다."""
    errors = []
    if not any(s.start_if for s in STAGES.values()):
        errors.append("시작 단계가 없음")
    for s in STAGES.values():
        errors += [f"{s.name}: 없는 도구 {t}" for t in s.tools if t not in tool_names]
        targets = [t.target for t in s.transitions] + list(s.enter_from)
        errors += [f"{s.name}: 없는 단계 {t}" for t in targets if t not in (RETURN, ANY) and t not in STAGES]
        if s.enter_on and not s.enter_from:
            errors.append(f"{s.name}: enter_from 없음")
        names = [s.name] + [f"{s.name}.{v}" for v in s.variants]
        # 항목 문구와 고객 유형별 문구("sender_name.registered")
        field_keys = list(s.fields) + [k for k in texts.fields if k.partition(".")[0] in s.fields and "." in k]
        templates = [texts.stages.get(n) for n in names] + [texts.fields.get(f) for f in field_keys]
        names += field_keys
        for name, tpl in zip(names, templates):
            if tpl is None:
                errors.append(f"문구 없음: {name}")
                continue
            try:
                tpl.format(**sample_vars)
            except (KeyError, IndexError, ValueError) as e:
                errors.append(f"문구 자리표시자 오류 {name}: {e}")
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
    """이 단계에서 갈 수 있는 단계: 전이 대상, 이 단계에서 들어올 수 있는 하위 흐름, 복귀면 하위 흐름이 아닌 단계."""
    out = {t.target for t in stage.transitions if t.target != RETURN}
    out |= {s.name for s in STAGES.values()
            if s.enter_on and s.name != stage.name and (ANY in s.enter_from or stage.name in s.enter_from)}
    if any(t.target == RETURN for t in stage.transitions):
        out |= {s.name for s in STAGES.values() if not s.subflow}
    return (*sorted(out), END)


async def _enter(step: Step) -> str:
    return step.stage


async def _step(step: Step, runtime: Runtime) -> Command:
    """현재 단계에서 사건 하나를 본다. 노드·라우터는 async여야 한다: ainvoke는 동기 함수를 다른 스레드에서 돌리는데
    통화 객체와 관제 버스는 스레드 안전하지 않다. 가드는 여기서 부른다(조건부 엣지 함수로 쓰지 않는다)."""
    ctx = runtime.context
    target = _target(ctx, step.event)
    if target is None:
        return Command(goto=END)
    await _move(ctx, target, step.event, step.tool)
    # 하위 흐름에서 돌아왔으면 돌아간 단계가 같은 사건을 먼저 본다(예: 조회 중 "새 주문" → 복귀 후 새 주문).
    # 아니면 들어온 직후 사건(ENTERED)을 한 번 더 본다
    event = step.event if target == RETURN and _target(ctx, step.event) is not None else ENTERED
    return Command(goto=ctx.flow.stage, update={"stage": ctx.flow.stage, "event": event})


async def start(ctx: Any) -> None:
    """통화 시작 단계로 들어간다(들어온 직후 조건도 평가)."""
    ctx.flow.stage = start_stage(ctx)
    await apply(ctx, [ENTERED])


def start_stage(ctx: Any) -> str:
    for s in STAGES.values():
        if s.start_if and s.start_if(ctx):
            return s.name
    raise FlowError("시작 조건에 맞는 단계가 없음")


def current(ctx: Any) -> Stage:
    return STAGES[ctx.flow.stage]


def allowed_tools(ctx: Any) -> tuple[str, ...]:
    return current(ctx).tools


def missing(ctx: Any) -> list[str]:
    stage = current(ctx)
    fields = stage.order(ctx) if stage.order else stage.fields
    return [f for f in fields if not ctx.field_done(f)]


def field_text(ctx: Any, field: str) -> str:
    """항목 질문 문구. 고객 유형별 문구("항목.registered")가 있으면 그것."""
    fields = ctx.texts.fields
    return fields.get(f"{field}.{ctx.customer_type}") or fields[field]


def next_text(ctx: Any) -> str:
    m = missing(ctx)
    if m:
        tpl = field_text(ctx, m[0])
    else:
        variant = ctx.stage_variant(ctx.flow.stage)
        tpl = ctx.texts.stages[f"{ctx.flow.stage}.{variant}" if variant else ctx.flow.stage]
    return tpl.format(**ctx.text_vars())


def _target(ctx: Any, event: str) -> str | None:
    stage = current(ctx)
    for t in stage.transitions:
        if t.event == event and t.guard(ctx):
            return t.target
    for s in STAGES.values():
        if s.enter_on == event and s.name != stage.name and (ANY in s.enter_from or stage.name in s.enter_from):
            return s.name
    return None


async def _move(ctx: Any, target: str, event: str, tool: str | None) -> None:
    state = ctx.flow
    prev = state.stage
    if target == RETURN:
        target, state.return_to = state.return_to or start_stage(ctx), None
    elif STAGES[target].subflow:
        if not STAGES[prev].subflow:
            state.return_to = prev
    else:
        state.return_to = None
    state.stage = target
    state.history.append({"at": time.time(), "from": prev, "to": target, "event": event, "tool": tool})
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


def progress_text(ctx: Any, max_chars: int) -> str:
    """음성 모델에 thinking.append로 줄 "다음에 물을 것 + 기록된 값". max_chars를 넘지 않는다."""
    texts = ctx.texts
    nxt = next_text(ctx)
    m = missing(ctx)
    # 기록이 한 박자 늦어 방금 답한 항목을 또 묻지 않게 그다음 항목도 알려 준다
    then = texts.progress_then.format(next2=field_text(ctx, m[1]).format(**ctx.text_vars())) if len(m) > 1 else ""
    items = ctx.recorded()
    for cut in (None, 40, 24, 12, 6, 0):
        shown = [(k, v if cut is None else v[:cut]) for k, v in items] if cut != 0 else []
        recorded = (texts.progress_sep.join(texts.progress_item.format(label=k, value=v) for k, v in shown)
                    or texts.empty_value)
        text = texts.progress.format(stage=current(ctx).description, recorded=recorded, next=nxt, then=then)
        if len(text) <= max_chars:
            return text
    return text[:max_chars]
