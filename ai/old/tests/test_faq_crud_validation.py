import asyncio
import json
from types import SimpleNamespace

from qdrant_client import QdrantClient, models

from app.config import load_server_config
from app.rag.faq_index import FaqIndex
from app.rag.faq_index_state import FaqIndexState
from app.rag.faq_vectors import QdrantFaqVectors
from scripts import validate_faq_crud as validation
from test_faq_index import Embeddings


def test_crud_harness_with_fake_external_services(tmp_path, monkeypatch):
    cfg = load_server_config()
    monkeypatch.setattr(validation,'load_server_config',lambda:cfg.model_copy(update={
        'rag':cfg.rag.model_copy(update={'embedding_model':'test-embedding','dimensions':4})}))
    def create(events, sync, rag):
        client = QdrantClient(':memory:')
        client.create_collection(sync.collection,vectors_config=models.VectorParams(size=4,distance=models.Distance.COSINE))
        index = FaqIndex(FaqIndexState(events,collection=sync.collection,model=rag.embedding_model,dimensions=4),
            QdrantFaqVectors(client,collection=sync.collection,dimensions=4),Embeddings(4),
            validate_chunks=lambda chunks:None,embedding_batch_size=32,bm25_weight=.4,rrf_c=60)
        class Reranker:
            def rerank(self, question, rows):
                return [{**row,'reranker_score':1.} for row in rows]
        return SimpleNamespace(index=index,client=client,reranker=Reranker(),close=client.close)
    monkeypatch.setattr(validation,'create_faq_runtime',create)
    asyncio.run(validation.run(tmp_path,'manuals_validation_crud_test'))
    report = json.loads((tmp_path/'report.json').read_text(encoding='utf-8'))
    assert report['status'] == 'completed'
    assert any(row['name']=='모든 버전 실제 벡터 삭제' for row in report['checks'])
