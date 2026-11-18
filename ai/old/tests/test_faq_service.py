"""관리 FAQ 검색의 Top5→원격 리랭킹→삭제 필터→Live Top3 경계."""

from app.config import load_server_config
from app.rag.service import RagService
from test_faq_index import prepare, refresh, setup


class Reranker:
    def __init__(self, on_call=None):
        self.calls = []
        self.on_call = on_call

    def rerank(self, question, documents):
        self.calls.append((question, list(documents)))
        if self.on_call:
            self.on_call()
        return [{**doc, 'reranker_score': 1. / rank}
                for rank, doc in enumerate(documents, 1)]


def test_managed_service_returns_backend_faq_top3(setup):
    env = setup
    env.index.apply(refresh(*(prepare(i, answer=f'{i}번 접수 안내') for i in range(123, 129))))
    cfg = load_server_config().rag
    reranker = Reranker()
    service = RagService(cfg, faq_index=env.index, reranker=reranker)
    result = service._search('접수 안내')
    assert len(reranker.calls[0][1]) == 5
    assert len(result['context']['evidence']) == 3
    assert all(item['source_id'].startswith('backend-faq:') for item in result['context']['evidence'])
    assert all(item['content'].startswith('### Q.') for item in result['context']['evidence'])
    assert result['context']['status'] == 'found'


def test_delete_arriving_during_rerank_cannot_reach_live(setup):
    env = setup
    env.index.apply(refresh(prepare(123), prepare(124)))
    def delete_first():
        env.events.block_deletes((123,), 'test-concurrent-delete')
    service = RagService(load_server_config().rag, faq_index=env.index,
                         reranker=Reranker(delete_first))
    result = service._search('접수 안내')
    assert all(item['source_id'] != 'backend-faq:123' for item in result['context']['evidence'])
    assert result['context']['status'] == 'found'
    assert all(row['chunk_id'] != prepare(123).chunks[0].point_id
               for group in ('rrf_candidates','bm25_results','dense_results','reranked')
               for row in result[group])


def test_empty_managed_index_returns_no_evidence_without_rerank(setup):
    env = setup
    reranker = Reranker()
    service = RagService(load_server_config().rag, faq_index=env.index, reranker=reranker)
    result = service._search('모르는 질문')
    assert result['context'] == {'status':'no_evidence','question':'모르는 질문','evidence':[]}
    assert reranker.calls == []
