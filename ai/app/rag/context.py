"""리랭킹 순서를 유지한 고유 Top3를 기존 LLM 전달용으로 묶는다."""

from collections.abc import Sequence

from app.rag.schemas import Evidence, SearchContext


def build_search_context(question: str, reranked: Sequence[Evidence]) -> SearchContext:
    unique: dict[str, Evidence] = {}
    for item in reranked:
        previous = unique.get(item.chunk_id)
        if previous is not None:
            if (previous.source_id, previous.title, previous.content) != (item.source_id, item.title, item.content):
                raise ValueError('같은 청크 ID의 출처 또는 본문이 다릅니다.')
            continue
        unique[item.chunk_id] = item
    evidence = tuple(list(unique.values())[:3])
    return SearchContext(question=question, status='found' if evidence else 'no_evidence', evidence=evidence)
