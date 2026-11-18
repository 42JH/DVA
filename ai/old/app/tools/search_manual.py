"""FAQ 검색은 주문·접수 정보를 바꾸지 않는 읽기 전용 도구다. 결과(답할 근거가 있는지)가 RAG Yes/No 분기다(§6.1)."""

import logging

from pydantic import Field
from app.rag.schemas import SearchContext, Evidence
from app.tools._base import Args, Result, ToolError, tool

log = logging.getLogger(__name__)


class ManualQuery(Args):
    question: str = Field(min_length=1, max_length=500, description='고객 질문의 조건·부정·규격을 유지한 검색 질문')


@tool('search_manual', 'FAQ·이용 정책·포장·요금·배송·취소 조건을 검색. 실제 주문 조회나 취소 실행에는 쓰지 않음.', ManualQuery)
async def search_manual(ctx, args):
    if ctx.rag is None:
        raise ToolError('매뉴얼 검색 미연결', '추측하지 말고 확인 후 안내하겠다고 말한 뒤 현재 접수 계속하기', ['rag.failed'])
    try:
        result = await ctx.rag(args.question)
    except Exception:
        log.exception('매뉴얼 검색 실패 %s', ctx.session_id)
        raise ToolError('매뉴얼 검색 실패', '추측하지 말고 확인이 필요하다고 안내하기', ['rag.failed']) from None
    payload = result['context']
    context = SearchContext(question=payload['question'], status=payload['status'], evidence=tuple(
        Evidence(**{key: doc[key] for key in ('chunk_id', 'source_id', 'title', 'content')})
        for doc in payload['evidence']))
    return Result(data={'context': context.llm_payload(), 'timings': result.get('timings', {})},
                  events=['rag.found' if answerable(ctx, context, result) else 'rag.none'])


def answerable(ctx, context: SearchContext, result: dict) -> bool:
    """RAG Yes: 근거가 있고, 임계값을 두었으면 1등 근거의 리랭커 점수가 그 이상(§9)."""
    if context.status != 'found':
        return False
    floor = ctx.cfg.rag.min_score
    scores = [row.get('reranker_score') for row in result.get('reranked') or []]
    return floor is None or not scores or scores[0] is None or scores[0] >= floor
