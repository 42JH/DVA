"""Tool Executor: 찾기 → 허용 확인 → 인수 검증(strict) → 실행(예산) → 결과 형식화·기록.

옛 tools/runner.py에서 바뀐 것(tool-contracts.md §4 위험): 허용 확인을 인수 검증보다 먼저(위험 4), 결과에 기계 판독
status·code(위험 2), 부분 반영은 facts.recorded로 명시(위험 3), 같은 call_id 재수신은 처음 결과 그대로(F15).
모델이 만든 인수는 미신뢰 입력이라 strict 스키마 검증 뒤에만 실행한다. 어느 도구를 허용할지는 부르는 쪽이 정한다.
"""

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass

import openai
from pydantic import BaseModel, ConfigDict, ValidationError

from app.integrations.backend.gateway import BackendFailure
from app.tools.context import ToolContext
from app.tools.outcome import ToolOutcome

log = logging.getLogger(__name__)


class Args(BaseModel):
    """모든 도구 인수의 기반: 모르는 키 거부, 타입 강제."""
    model_config = ConfigDict(extra="forbid", strict=True)


@dataclass(frozen=True)
class ModelTool:
    name: str
    description: str
    args: type[Args]
    run: Callable[[ToolContext, Args], Awaitable[ToolOutcome]]
    budget: str = "tool"           # tool · rag
    timeout_code: str = "TOOL_TIMEOUT"

    def spec(self) -> dict:
        """Responses 위임 tools에 넣는 strict 함수 도구(delegation.md §2.1)."""
        fn = openai.pydantic_function_tool(self.args, name=self.name, description=self.description)["function"]
        return {"type": "function", "name": fn["name"], "description": fn["description"],
                "parameters": fn["parameters"], "strict": fn["strict"]}


MODEL_TOOLS: dict[str, ModelTool] = {}


def model_tool(name: str, description: str, args: type[Args], budget: str = "tool", timeout_code: str = "TOOL_TIMEOUT"):
    def register(fn):
        if name in MODEL_TOOLS:
            raise RuntimeError(f"도구 이름 중복: {name}")
        MODEL_TOOLS[name] = ModelTool(name, description, args, fn, budget, timeout_code)
        return fn
    return register


def function_specs(names: Iterable[str] | None = None) -> list[dict]:
    return [t.spec() for n, t in MODEL_TOOLS.items()
            if (n != "manage_conversation" if names is None else n in names)]


def _hint(e: ValidationError) -> list[dict]:
    return [{"field": ".".join(map(str, err["loc"])) or "arguments", "reason": err["type"]} for err in e.errors()[:5]]


async def run_tool(ctx: ToolContext, name: str, arguments: str, call_id: str,
                   allowed: Iterable[str] | None = None) -> dict:
    """function_call_output에 넣을 dict. 어떤 실패도 결과로 돌려준다(통화를 끊지 않는다, 무응답 위임 금지)."""
    if call_id in ctx.outputs:
        return ctx.outputs[call_id]
    t0 = time.monotonic()
    tool = MODEL_TOOLS.get(name)
    if tool is None or (allowed is not None and name not in allowed):
        outcome = ToolOutcome("rejected", "TOOL_NOT_ALLOWED")
    else:
        try:
            args = tool.args.model_validate_json(arguments or "{}")
        except ValidationError as e:
            outcome = ToolOutcome("needs_input", "TOOL_ARGS_INVALID", needs=_hint(e))  # 모델에게 재호출
        else:
            budget = ctx.rag_budget_sec if tool.budget == "rag" else ctx.tool_budget_sec
            try:
                outcome = await asyncio.wait_for(tool.run(ctx, args), budget)
            except TimeoutError:
                log.warning("도구 시간 초과 %s %s", ctx.session_id, name)
                outcome = ToolOutcome("unavailable", tool.timeout_code)
            except BackendFailure as e:
                outcome = ToolOutcome("unavailable", e.code)
            except Exception:
                log.exception("도구 예외 %s %s", ctx.session_id, name)
                outcome = ToolOutcome("unavailable", "INTERNAL_ERROR")
    output = outcome.to_output()
    ctx.outputs[call_id] = output
    log.info("도구 %s %s %s %.0fms", ctx.session_id, name, output.get("code") or output["status"],
             (time.monotonic() - t0) * 1000)
    return output


def output_json(output: dict) -> str:
    return json.dumps(output, ensure_ascii=False)
