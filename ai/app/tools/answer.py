from pydantic import Field

from app.flow import engine
from app.listener import consent
from app.tools._base import Args, Result, ToolError, tool


class AnswerArgs(Args):
    choice: str = Field(max_length=40, description="state.choices의 키 중 고객이 고른 것")


@tool("answer", "상담원이 물은 질문(저장된 곳 확인·받는 곳 후보·업무 고르기, 접수·결제·취소·상담원 연결 확인)에 고객이 "
      "답했을 때 그 답을 보고한다. state.choices의 키 하나만. 고객 말이 그 질문의 답이 아니면(다른 용건·정정·되물음, "
      "상담원이 그 뒤에 한 다른 질문의 답) 부르지 않는다.", AnswerArgs)
async def answer(ctx, args: AnswerArgs) -> Result:
    # 이 도구는 answers_by_tool인 단계에서만 허용된다(dispatcher)
    stage = engine.current(ctx)
    if args.choice not in stage.choices(ctx):
        raise ToolError(f"없는 선택지: {args.choice}", "state.choices의 키 중 하나로, 답이 아니면 부르지 않기")
    if not stage.confirm:
        return Result({}, await stage.on_answer(ctx, args.choice))
    # 확인 단계: 되돌릴 수 없는 답은 두 열쇠의 한쪽(서버 판별과 같아야 처리), 그 밖의 답은 서버 판별이 처리한다
    return Result({}, await consent(ctx, "live", args.choice) if args.choice in stage.consent else [])
