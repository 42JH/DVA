"""FAQ 검색은 주문·접수·상태를 바꾸지 않는 읽기 전용 도구다."""

from pydantic import Field
from app.rag.schemas import SearchContext, Evidence
from app.tools._base import Args, Result, ToolError, tool


class ManualQuery(Args):
    question: str = Field(min_length=1, max_length=500, description='고객 질문의 조건·부정·규격을 유지한 검색 질문')


@tool('search_manual', 'FAQ·이용 정책·포장·요금·배송·취소 조건을 검색. 실제 주문 조회나 취소 실행에는 쓰지 않음.', ManualQuery)
async def search_manual(ctx, args):
    if ctx.rag is None:
        raise ToolError('매뉴얼 검색 미연결', '추측하지 말고 확인 후 안내하겠다고 말한 뒤 현재 접수 계속하기')
    result = await ctx.rag(args.question)
    payload = result['context']
    context = SearchContext(question=payload['question'], status=payload['status'], evidence=tuple(
        Evidence(**{key: doc[key] for key in ('chunk_id', 'source_id', 'title', 'content')})
        for doc in payload['evidence']))
    return Result(data={'context': context.llm_payload(), 'timings': result.get('timings', {})})
