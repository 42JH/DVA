"""운영 색인 팩토리는 전용 컬렉션에만 연결하고, 기동 때 GPU를 부르지 않는다(GPU가 꺼져 있어도 서버가 뜬다)."""

from types import SimpleNamespace

import langchain_openai
import qdrant_client

from app.config import load_server_config
from app.rag import faq_runtime
from test_faq_index import setup


def test_runtime_starts_without_gpu_and_validates_on_registration(setup, monkeypatch):
    env = setup
    checks = []
    class Reranker:
        def __init__(self, *args):
            pass
        def validate_chunks(self, chunks):  # GPU가 꺼져 있음(2026-11-02 Jenkins #52 기동 실패)
            checks.extend(chunk.content for chunk in chunks)
            raise TimeoutError('GPU 꺼짐')
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
    assert checks == []  # 기동 때는 GPU를 부르지 않는다
    assert isinstance(runtime.index.validate_chunks.__self__, Reranker)  # 등록할 때는 GPU 검증을 쓴다
    runtime.close()
