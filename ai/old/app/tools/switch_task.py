from typing import Literal

from pydantic import Field

from app.flow import engine
from app.tools._base import Args, Result, tool

EVENTS = {"order": "intent.order", "lookup": "intent.lookup", "agent": "intent.restricted", "end": "call.ending"}


class SwitchArgs(Args):
    task: Literal["order", "lookup", "agent", "end"] = Field(
        description="order 택배 보내기 · lookup 보낸 택배 조회·취소 · agent 상담원 연결 요청이나 AI가 처리할 수 없는 요청"
                    "(민원·보상·분실·결제 오류·지난 주문 수정) · end 통화 끝내기")


@tool("switch_task", "고객이 지금 하던 것과 다른 일을 하겠다고 할 때(어느 단계에서나) 그 업무로 바꾼다. "
      "지금 질문의 답이면 answer를 쓴다.", SwitchArgs)
async def switch_task(ctx, args: SwitchArgs) -> Result:
    stage = engine.current(ctx)
    if ctx.flow.task == args.task and not stage.subflow:
        return Result({"already": True})  # 이미 그 업무 중(처음부터 다시 하지 않는다)
    return Result({}, [EVENTS[args.task]])
