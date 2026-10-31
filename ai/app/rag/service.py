"""전화 서버용 검색 서비스. 준비는 한 번, 요청별 질문 임베딩은 한 번만 한다."""

import asyncio
import logging
import os
import threading
import time
from pathlib import Path

from app.config import ROOT, config_dir
from app.rag.algorithms import faq_documents
from app.rag.context import build_search_context
from app.rag.descriptions import load_descriptions
from app.rag.hybrid import HybridSearchExperiment, load_faq_documents
from app.rag.remote import RemoteReranker
from app.rag.schemas import Evidence


class RagService:
    def __init__(self, cfg, *, faq_index=None, reranker=None):
        self.cfg = cfg
        self.client = self.search = None
        self.reranker = reranker
        self.faq_index = faq_index
        if faq_index is not None and reranker is None:
            raise ValueError('관리 FAQ 검색에는 리랭커가 필요합니다.')
        self.lock = threading.Lock()
        self.retry_after = 0.0
        self.closed = False

    async def warmup(self):
        try:
            await asyncio.to_thread(self._prepare)
        except Exception as error:
            logging.getLogger(__name__).warning('RAG 준비 미완료: %s. 주문 통화는 계속 허용합니다.', type(error).__name__)

    def _prepare(self):
        if self.faq_index is not None:
            if self.closed:
                raise RuntimeError('검색 서비스가 종료됐습니다.')
            return
        # 취소된 asyncio 작업의 준비 스레드도 끝까지 잠금을 지킨다.
        with self.lock:
            if self.closed:
                raise RuntimeError('검색 서비스가 종료됐습니다.')
            if self.search is not None:
                return
            if time.monotonic() < self.retry_after:
                raise RuntimeError('검색 서비스 재연결 대기 중')
            client = reranker = None
            try:
                from qdrant_client import QdrantClient, models
                from langchain_openai import OpenAIEmbeddings
                from langchain_qdrant import QdrantVectorStore

                cfg = self.cfg
                reranker = RemoteReranker(os.getenv('RAG_RERANKER_URL'), os.getenv('RAG_RERANKER_API_KEY'), cfg.http_timeout_sec)
                client = QdrantClient(url=os.getenv('QDRANT_URL') or 'http://127.0.0.1:6333',
                                      api_key=os.environ['QDRANT_API_KEY'], timeout=cfg.http_timeout_sec)
                vectors = client.get_collection(cfg.collection).config.params.vectors
                if not isinstance(vectors, models.VectorParams) or vectors.size != cfg.dimensions or vectors.distance != models.Distance.COSINE:
                    raise ValueError('large 3072차원 Cosine 컬렉션이 필요합니다.')
                documents = load_faq_documents(client, cfg.collection)
                raw = (ROOT / 'manuals/delivery_faq.md').read_bytes()
                originals = faq_documents(raw.decode('utf-8'), Path('delivery_faq.md'))
                if {d.metadata['chunk_id']: d.page_content for d in originals} != {d.metadata['chunk_id']: d.page_content for d in documents}:
                    raise ValueError('검토한 원문과 DB가 다릅니다. 명시적으로 새 컬렉션을 색인하세요.')
                descriptions = load_descriptions(config_dir() / 'rag-search-descriptions.json', raw, documents)
                embedding = OpenAIEmbeddings(model=cfg.embedding_model, request_timeout=cfg.http_timeout_sec, max_retries=0)
                store = QdrantVectorStore(client=client, collection_name=cfg.collection, embedding=embedding, validate_collection_config=False)
                condition = models.Filter(must=[models.HasIdCondition(has_id=[d.metadata['_id'] for d in documents])])
                search = HybridSearchExperiment(documents, embedding.embed_query,
                    lambda vector: store.similarity_search_with_score_by_vector(vector, k=len(documents), filter=condition),
                    bm25_weight=cfg.bm25_weight, c=cfg.rrf_c, descriptions=descriptions, expected_dimensions=cfg.dimensions)
                self.client, self.reranker, self.search = client, reranker, search
            except BaseException:
                if client is not None:
                    client.close()
                if reranker is not None:
                    reranker.close()
                self.retry_after = time.monotonic()+self.cfg.retry_cooldown_sec
                raise

    def _search(self, question):
        self._prepare()
        started = time.monotonic()
        if self.faq_index is None:
            found = self.search.search(question, top_k=self.cfg.candidate_k)
        else:
            snapshot = self.faq_index.current()
            if snapshot.search is None:
                found = {'results': [], 'all_results': [], 'bm25_results': [], 'timings': {}}
            else:
                found = snapshot.search.search(question, top_k=self.cfg.candidate_k)
        start_rerank = time.monotonic()
        ranked = self.reranker.rerank(question, found['results']) if found['results'] else []
        reranking_seconds = time.monotonic()-start_rerank
        if self.faq_index is not None:
            ranked = self.faq_index.filter_rows(ranked)
            found['all_results'] = self.faq_index.filter_rows(found['all_results'])
            allowed_ids = {row['chunk_id'] for row in found['all_results']}
            found['results'] = [row for row in found['results'] if row['chunk_id'] in allowed_ids]
            found['bm25_results'] = [row for row in found['bm25_results'] if row['chunk_id'] in allowed_ids]
        context = build_search_context(question, [Evidence(chunk_id=doc['chunk_id'],
            source_id=doc['source'] if self.faq_index is not None else 'delivery_faq',
            title=doc['title'], content=doc['context'],
            reranker_score=doc['reranker_score']) for doc in ranked])
        timings = {**found['timings'], 'reranking_seconds': reranking_seconds,
                   'retrieval_seconds': time.monotonic()-started}
        clean = lambda rows: [{k: v for k, v in row.items() if k != 'source'} for row in rows]
        return {'context': context.llm_payload(), 'timings': timings,
                'rrf_candidates': clean(found['results']), 'bm25_results': found['bm25_results'],
                'dense_results': clean(sorted(found['all_results'], key=lambda row: row['dense_rank'])),
                'reranked': clean(ranked), 'search_timings': found['timings'],
                'reranking_seconds': reranking_seconds, 'retrieval_seconds': timings['retrieval_seconds']}

    async def __call__(self, question):
        # CPU 형태소 분석과 동기 SDK/HTTP 대기를 통화 이벤트 루프 밖으로 보낸다.
        return await asyncio.wait_for(asyncio.to_thread(self._search, question), self.cfg.timeout_sec)

    async def close(self):
        def close_locked():
            with self.lock:
                self.closed = True
                if self.client is not None:
                    self.client.close()
                if self.reranker is not None and self.faq_index is None:
                    self.reranker.close()
        await asyncio.to_thread(close_locked)
