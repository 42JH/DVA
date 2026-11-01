from pydantic import Field

from app.flow import engine
from app.tools._base import Args, Result, ToolError, tool


class AnswerArgs(Args):
    choice: str = Field(max_length=40, description="state.choices의 키 중 고객이 고른 것")


@tool("answer", "상담원이 물은 질문(저장된 곳 확인·받는 곳 후보·업무 고르기 등)에 고객이 답했을 때 그 답을 보고한다. "
      "state.choices의 키 하나만. 고객 말이 그 질문의 답이 아니면(다른 용건·정정·되물음) 부르지 않는다.", AnswerArgs)
async def answer(ctx, args: AnswerArgs) -> Result:
    # 이 도구는 answers_by_tool인 단계에서만 허용된다(dispatcher). 확인 단계의 답은 서버가 직접 듣는다
    choices = engine.current(ctx).choices(ctx)
    if args.choice not in choices:
        raise ToolError(f"없는 선택지: {args.choice}", "state.choices의 키 중 하나로, 답이 아니면 부르지 않기")
    return Result({}, await engine.current(ctx).on_answer(ctx, args.choice))
