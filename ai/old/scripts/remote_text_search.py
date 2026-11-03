"""운영 검색을 같은 형태의 평가 기록으로 연결한다. 추가 LLM 호출 없음."""
import os
from pathlib import Path

from app.config import load_server_config
from app.rag.service import RagService
from app.rag.prompts import RagContextRenderer
from app.rag.schemas import SearchContext, Evidence
from app.rag.qwen import MODEL, REVISION


class RemoteTextSearch:
    def __init__(self):
        cfg = load_server_config().rag
        self.service = RagService(cfg)
        self.service._prepare()
        self.renderer = RagContextRenderer()
        self.info = {'collection': cfg.collection, 'embedding_model': cfg.embedding_model,
            'bm25_weight': cfg.bm25_weight, 'dense_weight': 1-cfg.bm25_weight, 'c': cfg.rrf_c,
            'candidate_k': cfg.candidate_k, 'context_k': cfg.context_k,
            'reranker': {'model': MODEL, 'revision': REVISION, 'transport': 'remote_http'}}

    async def __call__(self, question):
        result = await self.service(question)
        payload = result.pop('context')
        context = SearchContext(question=payload['question'], status=payload['status'], evidence=tuple(
            Evidence(**{key: row[key] for key in ('chunk_id', 'source_id', 'title', 'content')}) for row in payload['evidence']))
        return {**result, 'evidence': payload['evidence'], 'tool_output': {'ok': True, 'context_text': self.renderer.render(context)}}

    def close(self):
        # 실험 서버는 요청 작업을 모두 닫은 뒤 호출한다.
        self.service.closed = True
        if self.service.client is not None:
            self.service.client.close()
        if self.service.reranker is not None:
            self.service.reranker.close()


class ManagedRemoteTextSearch(RemoteTextSearch):
    def __init__(self, state_directory, collection):
        from app.rag.faq_events import FaqEventStore
        from app.rag.faq_runtime import create_faq_runtime
        if not collection.startswith('manuals_validation_faq_') or not (state_directory/'events.sqlite3').is_file():
            raise ValueError('기존 검증 전용 색인과 상태 DB가 필요합니다.')
        cfg = load_server_config()
        events = FaqEventStore(state_directory/'events.sqlite3', max_pending=1000, busy_timeout_sec=.1)
        self.runtime = create_faq_runtime(events, cfg.faq_sync.model_copy(update={'collection':collection}), cfg.rag)
        self.service = RagService(cfg.rag, faq_index=self.runtime.index, reranker=self.runtime.reranker)
        self.renderer = RagContextRenderer()
        self.info = {'collection':collection,'mode':'managed_faq','candidate_k':5,'context_k':3,
                     'versions':{faq.faq_id:faq.version for faq in self.runtime.index.current().faqs}}

    def close(self):
        self.service.closed = True
        self.runtime.close()


def create_search(cfg):
    if cfg.search_backend == 'remote':
        return RemoteTextSearch()
    from scripts.local_text_search import LocalTextSearch
    python = cfg.qwen_python or os.getenv('QWEN_PYTHON')
    if not python:
        raise ValueError('로컬 재현 모드는 QWEN_PYTHON 또는 qwen_python이 필요합니다.')
    return LocalTextSearch(Path(python))
