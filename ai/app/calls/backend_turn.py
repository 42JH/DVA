"""Responses tool loop for the isolated turn comparison."""

import json
from dataclasses import dataclass

from app.policy.render import render_backend
from app.tools import function_specs, run_tool
from app.tools.context import ToolContext

SHADOW_TOOLS = ("record_fields", "get_state")
MAX_RESPONSES = 3


@dataclass(frozen=True)
class BackendTurnResult:
    status: str
    tool_calls: int
    address_unverified: bool


class BackendTurn:
    def __init__(self, client, model: str, effort: str, policy):
        self.client, self.model, self.effort = client, model, effort
        self.tools = function_specs(SHADOW_TOOLS, policy=policy)
        self.instructions = render_backend(policy) + (
            "\n이 요청은 그림자 비교다. 현재 고객 발화에서 실제로 말한 값만 기존 기록 도구로 추출한다. "
            "서버의 판단과 상태를 읽고 추측으로 다른 업무를 실행하지 않는다. 조회·이관·취소·마무리와 "
            "음성 안내는 실행하지 않는다. 새 값이 없으면 도구 없이 끝낸다."
        )

    async def run(self, ctx: ToolContext, payload: dict) -> BackendTurnResult:
        history = [{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]
        calls = 0
        address_unverified = False
        status = "ok"
        for attempt in range(MAX_RESPONSES):
            response = await self.client.responses.create(
                model=self.model, instructions=self.instructions, input=history, tools=self.tools,
                reasoning={"effort": self.effort}, parallel_tool_calls=False, max_output_tokens=2500,
                store=False, include=["reasoning.encrypted_content"],
            )
            if response.status != "completed":
                return BackendTurnResult("response_incomplete", calls, address_unverified)
            requested = [item for item in response.output if item.type == "function_call"]
            if not requested:
                return BackendTurnResult(status, calls, address_unverified)
            if attempt == MAX_RESPONSES - 1:
                break
            history.extend(item.model_dump(mode="json", exclude_none=True) for item in response.output)
            for item in requested:
                out = await run_tool(ctx, item.name, item.arguments, item.call_id, allowed=SHADOW_TOOLS)
                calls += 1
                if item.name not in SHADOW_TOOLS:
                    status = "unsupported_tool"
                elif out["status"] == "unavailable" and status == "ok":
                    status = "tool_unavailable"
                recorded = (out.get("facts") or {}).get("recorded") or ()
                address_unverified |= any(name in recorded for name in ("sender_address", "receiver_address"))
                history.append({"type": "function_call_output", "call_id": item.call_id,
                                "output": json.dumps(out, ensure_ascii=False)})
        return BackendTurnResult("tool_loop_limit", calls, address_unverified)
