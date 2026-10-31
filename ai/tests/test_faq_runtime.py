"""운영 색인 팩토리는 GPU 계약 확인 후 전용 컬렉션에만 연결한다."""

from types import SimpleNamespace

import langchain_openai
import qdrant_client

from app.config import load_server_config
from app.rag import faq_runtime
from test_faq_index import setup


def test_runtime_uses_existing_dedicated_collection_and_exact_validator(setup, monkeypatch):
    env = setup
    checks = []
    class Reranker:
        def __init__(self, *args):
            pass
        def validate_chunks(self, chunks):
            checks.extend(chunk.content for chunk in chunks)
        def close(self):
            pass
    monkeypatch.setattr(faq_runtime, 'RemoteReranker', Reranker)
    monkeypatch.setattr(qdrant_client, 'QdrantClient', lambda **kwargs:env.client)
    monkeypatch.setattr(langchain_openai, 'OpenAIEmbeddings', lambda **kwargs:env.embeddings)
    monkeypatch.setenv('RAG_RERANKER_URL', 'https://test.example')
    monkeypatch.setenv('RAG_RERANKER_API_KEY', 'fake')
    monkeypatch.setenv('QDRANT_API_KEY', 'fake')
    faq_cfg = load_server_config().faq_sync.model_copy(update={'collection':env.state.collection})
    rag_cfg = SimpleNamespace(embedding_model=env.state.model, dimensions=env.state.dimensions,
                              http_timeout_sec=1., bm25_weight=.4, rrf_c=60)
    runtime = faq_runtime.create_faq_runtime(env.events, faq_cfg, rag_cfg)
    assert runtime.index.current().generation == 0
    assert checks == ['FAQ 등록 길이 확인']
    runtime.close()
