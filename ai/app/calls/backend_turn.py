"""Responses tool loop for the isolated turn comparison."""

import json
from dataclasses import dataclass, field

from app.policy.render import render_backend
from app.tools import function_specs, run_tool
from app.tools.context import ToolContext

SHADOW_TOOLS = ("record_fields", "get_state")
SERVER_TOOLS = (*SHADOW_TOOLS, "find_destination", "lookup_orders", "search_manual")
MAX_RESPONSES = 3


@dataclass(frozen=True)
class BackendTurnResult:
    status: str
    tool_calls: int
    address_unverified: bool
    facts: dict = field(default_factory=dict)


class BackendTurn:
    def __init__(self, client, model: str, effort: str, policy, *, server: bool = False):
        self.client, self.model, self.effort = client, model, effort
        self.allowed = SERVER_TOOLS if server else SHADOW_TOOLS
        self.tools = function_specs(self.allowed, policy=policy)
        self.instructions = render_backend(policy) + (
            "\n현재 고객 발화에서 실제로 말한 값만 기존 기록 도구로 추출한다. "
            "서버의 판단과 상태를 읽고 추측으로 다른 업무를 실행하지 않는다. "
            "음성 안내와 업무 확정은 서버가 담당한다. "
        )
        self.instructions += ("고객이 조회·문의한 경우 해당 읽기 도구를 사용한다." if server else
                              "이 요청은 그림자 비교다. 조회나 문의 도구는 실행하지 않는다.")

    async def run(self, ctx: ToolContext, payload: dict, *, before_lookup=None) -> BackendTurnResult:
        history = [{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]
        calls = 0
        address_unverified = False
        status = "ok"
        facts = {}
        for attempt in range(MAX_RESPONSES):
            response = await self.client.responses.create(
                model=self.model, instructions=self.instructions, input=history, tools=self.tools,
                reasoning={"effort": self.effort}, parallel_tool_calls=False, max_output_tokens=2500,
                store=False, include=["reasoning.encrypted_content"],
            )
            if response.status != "completed":
                return BackendTurnResult("response_incomplete", calls, address_unverified, facts)
            requested = [item for item in response.output if item.type == "function_call"]
            if not requested:
                return BackendTurnResult(status, calls, address_unverified, facts)
            if attempt == MAX_RESPONSES - 1:
                break
            history.extend(item.model_dump(mode="json", exclude_none=True) for item in response.output)
            for item in requested:
                if self.allowed == SERVER_TOOLS and ctx.state.intent is None:
                    ctx.state.intent = {"record_fields": "order", "find_destination": "order",
                                        "lookup_orders": "lookup", "search_manual": "inquiry"}.get(item.name)
                if item.name == "lookup_orders" and before_lookup and item.name in self.allowed:
                    await before_lookup()
                out = await run_tool(ctx, item.name, item.arguments, item.call_id, allowed=self.allowed)
                calls += 1
                if item.name not in self.allowed:
                    status = "unsupported_tool"
                elif out["status"] == "unavailable" and status == "ok":
                    status = "tool_unavailable"
                recorded = (out.get("facts") or {}).get("recorded") or ()
                address_unverified |= ctx.address is None and any(
                    name in recorded for name in ("sender_address", "receiver_address"))
                if self.allowed == SERVER_TOOLS:
                    facts = dict(out.get("facts") or {})
                    if out.get("needs"):
                        facts["needs"] = out["needs"]
                    if out.get("code"):
                        facts["tool_code"] = out["code"]
                history.append({"type": "function_call_output", "call_id": item.call_id,
                                "output": json.dumps(out, ensure_ascii=False)})
        return BackendTurnResult("tool_loop_limit", calls, address_unverified, facts)
