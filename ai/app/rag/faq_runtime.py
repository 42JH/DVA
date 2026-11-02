"""운영 관리 FAQ 색인의 자원 생성. 기존 MD 컬렉션과 상태 파일을 섞지 않는다."""

import os
import json
from dataclasses import dataclass

from app.rag.faq_index import FaqIndex
from app.rag.faq_index_state import FaqIndexState
from app.rag.faq_vectors import QdrantFaqVectors
from app.rag.remote import RemoteReranker
from app.config import config_dir
from app.rag.faq_documents import FaqSearchDescription


def load_bm25_descriptions():
    path = config_dir() / 'faq-bm25-descriptions.json'
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding='utf-8'))
    descriptions = {}
    for item in data['entries']:
        description = FaqSearchDescription(**item)
        if description.faq_id in descriptions or not description.text.strip():
            raise ValueError('BM25 설명이 중복되거나 비어 있습니다.')
        descriptions[description.faq_id] = description
    return descriptions


@dataclass
class FaqRuntime:
    index: FaqIndex
    client: object
    reranker: RemoteReranker

    def close(self):
        self.reranker.close()
        self.client.close()


def create_faq_runtime(events, faq_cfg, rag_cfg):
    from langchain_openai import OpenAIEmbeddings
    from qdrant_client import QdrantClient, models

    client = reranker = None
    try:
        reranker = RemoteReranker(os.getenv('RAG_RERANKER_URL'), os.getenv('RAG_RERANKER_API_KEY'),
                                  rag_cfg.http_timeout_sec)
        # 기동 때 GPU(길이 검증 API)를 확인하지 않는다. GPU VM은 30분 뒤 자동 중지라, 확인하면 GPU가 꺼진 동안 전화 서버가
        # 뜨지 못했다(2026-11-02 Jenkins #52 배포·복구 모두 실패). 등록할 때마다 FaqIndex가 같은 검증을 하고, 실패하면
        # 처리기가 다시 시도한다(오래된 GPU 이미지도 그때 걸린다)
        client = QdrantClient(url=os.getenv('QDRANT_URL') or 'http://127.0.0.1:6333',
                              api_key=os.environ['QDRANT_API_KEY'], timeout=rag_cfg.http_timeout_sec)
        if not client.collection_exists(faq_cfg.collection):
            client.create_collection(faq_cfg.collection, vectors_config=models.VectorParams(
                size=rag_cfg.dimensions, distance=models.Distance.COSINE))
        vectors = QdrantFaqVectors(client, collection=faq_cfg.collection, dimensions=rag_cfg.dimensions)
        embedding = OpenAIEmbeddings(model=rag_cfg.embedding_model,
                                    request_timeout=rag_cfg.http_timeout_sec, max_retries=0)
        state = FaqIndexState(events, collection=faq_cfg.collection,
                              model=rag_cfg.embedding_model, dimensions=rag_cfg.dimensions)
        index = FaqIndex(state, vectors, embedding, validate_chunks=reranker.validate_chunks,
                         embedding_batch_size=faq_cfg.embedding_batch_size,
                         bm25_weight=rag_cfg.bm25_weight, rrf_c=rag_cfg.rrf_c,
                         bm25_descriptions=load_bm25_descriptions())
        return FaqRuntime(index, client, reranker)
    except BaseException:
        if client is not None:
            client.close()
        if reranker is not None:
            reranker.close()
        raise
