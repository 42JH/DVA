"""LangGraph Studio용 통화 흐름 그래프(개발 전용, 이미지에 들어가지 않는다). spec/flow.md "LangGraph Studio로 보기".

전화 없이 가짜 통화 하나를 스레드마다 두고, 실행 한 번에 보고 하나(고객 답·용건·도구 호출)를 넣는다.
보고 처리는 실제 코드(통화 준비·답 처리·디스패처)를 그대로 쓰고, 거기서 나온 사건은 실제 엔진 노드(engine._step)로
이 그래프의 단계 노드를 하나씩 지나가게 해 Studio에서 경로가 보이게 한다. 판별 모델(LLM)은 부르지 않는다.
"""

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

# 테스트의 설정·가짜 백엔드·고객 상황을 그대로 쓴다(Studio에서 보는 것 = 테스트한 것)
from conftest import CALLER, CFG, FULL_ORDER, TEXTS  # noqa: E402
from test_flow import new_db, recent_db, saved_db  # noqa: E402

from app.call import Call  # noqa: E402
from app.dispatcher import dispatch  # noqa: E402
from app.flow import engine  # noqa: E402
from app.listener import INTENTS, NO_ANSWER, apply_answer, stage_choices  # noqa: E402
from app.tools._base import TOOLS  # noqa: E402

CUSTOMERS = {"new": new_db, "recent": recent_db, "saved": saved_db}
CALLS: dict[str, Call] = {}  # 스레드 → 가짜 통화. 서버를 다시 띄우면 비므로 새 통화로 시작한다

IntentName = Literal[tuple(k for k in INTENTS if k != "none")]
ToolName = Literal[tuple(TOOLS)]


class StudioInput(BaseModel):
    """Studio 입력. 스레드 첫 실행은 customer만, 그다음부터는 answer·intent·tool 중 하나만 채워 실행한다."""

    customer: Literal["new", "recent", "saved"] = Field(
        "new", description="첫 실행에서만 쓴다. new 신규 고객, recent 최근 배송 있는 등록 고객, saved 저장된 배송지만 있는 등록 고객")
    answer: str | None = Field(None, description="지금 단계 질문에 대한 고객 답. 결과의 choices 중 하나")
    intent: IntentName | None = Field(None, description="끼어드는 용건(조회·수정·취소·상담원·그만·종료·새 주문)")
    tool: ToolName | None = Field(None, description="백엔드 모델의 도구 호출. 결과의 tools 중 하나")
    args: dict = Field(default_factory=dict, description="도구 인수. record_order는 결과의 example_args를 붙여 넣으면 된다")


class StudioView(BaseModel):
    """실행이 끝난 뒤 통화 모습."""

    stage: str = ""
    next: str = ""
    choices: list[str] = []
    tools: list[str] = []
    recorded: dict[str, str] = {}
    example_args: dict[str, str] = {}
    path: list[str] = []
    result: dict = {}


class StudioState(StudioInput, StudioView):
    event: str = ""  # 지금 단계 노드가 볼 사건
    by: str | None = None  # 그 사건을 낸 쪽(전이 기록의 tool)
    queue: list[tuple[str, str | None]] = []  # 아직 흘려보내지 않은 사건


def _thread(config: RunnableConfig) -> str:
    return (config.get("configurable") or {}).get("thread_id") or "default"


async def _collect(run) -> tuple[Any, list[tuple[str, str | None]]]:
    """실제 코드를 돌리되 단계는 옮기지 않고 사건만 모은다. 모은 사건은 이 그래프의 단계 노드로 흘려보낸다."""
    events: list[tuple[str, str | None]] = []

    async def collect(ctx, evs, tool=None):
        events.extend((e, tool) for e in evs)

    # shortcut: 모듈 함수를 잠시 바꾼다. 실행이 한 번에 하나일 때만 안전(langgraph dev 기본 n-jobs 1). 동시 실행이 필요하면 바꾼다
    real, engine.apply = engine.apply, collect
    try:
        return await run(), events
    finally:
        engine.apply = real


def _next(call: Call, queue: list, update: dict) -> Command:
    """남은 사건이 있으면 지금 단계 노드로, 없으면 결과 정리로."""
    if queue:
        (event, by), rest = queue[0], queue[1:]
        return Command(goto=call.flow.stage,
                       update={**update, "stage": call.flow.stage, "event": event, "by": by, "queue": rest})
    return Command(goto="done", update=update)


async def report(state: StudioState, config: RunnableConfig) -> Command:
    """보고 하나를 실제 코드로 처리하고 사건을 모은다."""
    tid = _thread(config)
    call = CALLS.get(tid)
    if call is None:
        db = await asyncio.to_thread(CUSTOMERS[state.customer])  # recent_db는 안에서 asyncio.run을 부른다
        call = CALLS[tid] = Call(tid, CALLER, CFG, TEXTS, db)
        _, events = await _collect(call.prepare)
        return _next(call, events, {"result": {"started": state.customer, "start_stage": call.flow.stage}})
    given = [name for name in ("answer", "intent", "tool") if getattr(state, name)]
    if len(given) != 1:
        return _next(call, [], {"result": {"error": "answer·intent·tool 중 하나만 채워 실행"}})
    if state.answer:
        if state.answer == NO_ANSWER or state.answer not in stage_choices(call):
            return _next(call, [], {"result": {"error": f"{call.flow.stage} 단계의 답이 아님. choices 중 하나"}})
        out, events = await _collect(lambda: apply_answer(call, state.answer, "none"))
    elif state.intent:
        out, events = await _collect(lambda: apply_answer(call, "none", state.intent))
    else:
        call_id = f"studio-{len(call.tool_calls) + 1}"
        out, events = await _collect(lambda: dispatch(call, state.tool, json.dumps(state.args, ensure_ascii=False), call_id))
        out = {k: v for k, v in out.items() if k != "state"}  # 단계를 옮기기 전 요약이라 뺀다(done에서 다시 만든다)
    return _next(call, events, {"result": {given[0]: getattr(state, given[0]), "output": out}})


async def stage_node(state: StudioState, config: RunnableConfig) -> Command:
    """모든 단계 노드: 실제 엔진 노드(engine._step)를 그대로 부른다. 더 갈 곳이 없으면 다음 사건이나 결과 정리로."""
    call = CALLS[_thread(config)]
    cmd = await engine._step(engine.Step(stage=state.stage, event=state.event, tool=state.by),
                             SimpleNamespace(context=call))
    if cmd.goto != END:
        return cmd
    return _next(call, state.queue, {})


async def done(state: StudioState, config: RunnableConfig) -> dict:
    """통화 모습을 정리하고 입력을 비운다(다음 실행에 남지 않게)."""
    call = CALLS[_thread(config)]
    stage = engine.current(call)
    tools = list(engine.allowed_tools(call))
    first = call.flow.history[0]["from"] if call.flow.history else call.flow.stage
    return {
        "answer": None, "intent": None, "tool": None, "args": {}, "queue": [],
        "stage": call.flow.stage,
        "next": engine.next_text(call),
        "choices": [c for c in stage_choices(call) if c != NO_ANSWER] if stage.listen else [],
        "tools": tools,
        "recorded": dict(call.recorded()),
        "example_args": {f: FULL_ORDER[f] for f in engine.missing(call)} if "record_order" in tools else {},
        "path": [first] + [h["to"] for h in call.flow.history],
    }


def builder() -> StateGraph:
    graph = StateGraph(StudioState, input_schema=StudioInput, output_schema=StudioView)
    graph.add_node("report", report, destinations=(*engine.STAGES, "done"))
    for stage in engine.STAGES.values():
        # 갈 곳 = 엔진 그림과 같은 단계들 + 같은 단계에서 다음 사건 + 결과 정리
        dest = {*engine._destinations(stage), stage.name, "done"} - {END}
        graph.add_node(stage.name, stage_node, destinations=tuple(sorted(dest)))
    graph.add_node("done", done)
    graph.add_edge(START, "report")
    graph.add_edge("done", END)
    return graph


graph = builder().compile()  # 체크포인터는 langgraph dev 서버가 붙인다
