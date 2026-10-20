"""상태 엔진. 업무를 모른다: 단계 정의를 읽어 "현재 단계 + 사건 → 다음 단계"를 계산하고,
허용 도구 확인과 진행 상태 문구 생성만 한다(spec/flow.md).

ctx(통화 객체)에 기대하는 것: flow(FlowState), texts(Texts), field_done(name) -> bool,
recorded() -> [(label, value)], text_vars() -> dict.
"""

import importlib
import pkgutil
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

RETURN = "@return"  # 하위 흐름을 끝내고 들어온 단계로 돌아간다
ANY = "*"  # enter_from에 쓰면 어느 단계에서나 들어올 수 있다(자기 자신 제외)
ENTERED = "stage.entered"  # 단계에 들어온 직후 한 번 내는 사건(바로 다음 단계로 넘길 조건용)
MAX_HOPS = 5


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
    subflow: bool = False  # 들어온 단계를 기억했다가 RETURN으로 돌아간다
    enter_on: str | None = None  # 이 사건이 enter_from 단계에서 나면 이 단계로 들어온다
    enter_from: tuple[str, ...] = ()
    start_if: Callable[[Any], bool] | None = None  # 통화 시작 단계 조건
    on_enter: Callable[[Any, str], None] | None = None  # (ctx, 이전 단계)


class FlowState(BaseModel):
    stage: str
    return_to: str | None = None
    history: list[dict] = []


class FlowError(Exception):
    pass


STAGES: dict[str, Stage] = {}


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
        templates = [texts.stages.get(s.name)] + [texts.fields.get(f) for f in s.fields]
        names = [s.name] + list(s.fields)
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
    return [f for f in current(ctx).fields if not ctx.field_done(f)]


def next_text(ctx: Any) -> str:
    m = missing(ctx)
    tpl = ctx.texts.fields[m[0]] if m else ctx.texts.stages[ctx.flow.stage]
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


def _move(ctx: Any, target: str, event: str, tool: str | None) -> None:
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
    if STAGES[target].on_enter:
        STAGES[target].on_enter(ctx, prev)


def apply(ctx: Any, events: list[str], tool: str | None = None) -> None:
    """도구가 낸 사건으로 단계를 옮긴다. 단계에 들어오면 ENTERED를 한 번 더 평가한다."""
    for event in events:
        hops = 0
        while (target := _target(ctx, event)) is not None:
            _move(ctx, target, event, tool)
            hops += 1
            if hops >= MAX_HOPS:
                raise FlowError(f"단계 전이가 끝나지 않음: {ctx.flow.stage}")
            event = ENTERED


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
    items = ctx.recorded()
    for cut in (None, 40, 24, 12, 6, 0):
        shown = [(k, v if cut is None else v[:cut]) for k, v in items] if cut != 0 else []
        recorded = texts.progress_sep.join(texts.progress_item.format(label=k, value=v) for k, v in shown)
        text = texts.progress.format(stage=current(ctx).description, recorded=recorded, next=nxt)
        if len(text) <= max_chars:
            return text
    return text[:max_chars]
