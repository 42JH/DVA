"""실제 질문의 BM25·Qdrant 검색 순위를 RRF로 결합하는 실험 CLI.

사용자 실행 시 질문을 임베딩한다. 문서는 재임베딩하지 않으며 DB는 읽기만
한다. 운영 서비스와 평가 CLI가 함께 사용하는 검색 구현이다.
"""

import argparse
import hashlib
import math
import os
from pathlib import Path
from time import perf_counter

from langchain_core.documents import Document
from qdrant_client import QdrantClient, models

from app.rag.algorithms import BM25_PARAMS, rank_bm25
from app.rag.algorithms import fuse
from app.rag.tokenization import tokenize_for_bm25

from app.rag.descriptions import search_documents


def load_faq_documents(client, collection: str) -> list[Document]:
    """DB의 Q+A 본문을 그대로 읽는다. 소개/출처는 검색 후보에서 제외한다."""
    documents, seen_ids, titles = [], set(), set()
    offset = None
    while True:
        points, offset = client.scroll(
            collection_name=collection, limit=100, offset=offset,
            with_payload=True, with_vectors=False,
        )
        for point in points:
            key = str(point.id)
            if key in seen_ids:
                raise ValueError("조회 포인트가 중복됩니다.")
            seen_ids.add(key)
            if len(seen_ids)>1000:
                raise ValueError("소규모 개발 컬렉션 1000포인트 한도를 초과했습니다.")
            payload = point.payload or {}
            metadata = payload.get("metadata") or {}
            title = metadata.get("header_3")
            if not title:
                continue
            text = payload.get("page_content")
            if not isinstance(title, str) or not isinstance(text, str) or not text.strip():
                raise ValueError("FAQ 제목/본문이 올바르지 않습니다.")
            if "context" in metadata:
                raise ValueError("질문 전용 컬렉션이 아닌 Q+A 컬렉션을 사용하세요.")
            if title in titles:
                raise ValueError("FAQ별 한 청크인 자료만 지원합니다.")
            titles.add(title)
            chunk_id = hashlib.sha256((title+"\n"+text).encode("utf-8")).hexdigest()
            documents.append(Document(page_content=text, metadata={
                **metadata, "chunk_id": chunk_id, "_id": point.id,
            }))
        if offset is None:
            break
    if not documents:
        raise ValueError("FAQ 본문이 없습니다.")
    return documents


class HybridSearchExperiment:
    """한 번 만든 BM25를 재사용하고 질문별 임베딩은 한 번만 요청한다."""

    def __init__(self, documents, embed_query, dense_search, *, bm25_weight=0.5, c=60, use_dictionary=True, descriptions=None, expected_dimensions=1536, search_inputs=None):
        from langchain_community.retrievers import BM25Retriever

        if not documents or not 0<bm25_weight<1 or c<0:
            raise ValueError("문서/가중치/c 설정이 올바르지 않습니다.")
        self.documents = documents
        self.by_id = {str(doc.metadata["_id"]): doc for doc in documents}
        if len(self.by_id)!=len(documents):
            raise ValueError("포인트 ID가 중복됩니다.")
        self.by_chunk = {doc.metadata["chunk_id"]: doc for doc in documents}
        if len(self.by_chunk)!=len(documents):
            raise ValueError("청크 ID가 중복됩니다.")
        self.preprocess = lambda text: tokenize_for_bm25(text, use_user_dictionary=use_dictionary)
        if search_inputs is None:
            bm25_documents = search_documents(documents, descriptions or {})
        else:
            if descriptions or set(search_inputs) != set(self.by_chunk):
                raise ValueError('청크별 검색 입력과 원문 목록이 다릅니다.')
            if any(not isinstance(text, str) or not text.strip() for text in search_inputs.values()):
                raise ValueError('청크별 검색 입력이 비어 있습니다.')
            bm25_documents = [Document(page_content=search_inputs[doc.metadata['chunk_id']],
                                       metadata=dict(doc.metadata)) for doc in documents]
        self.bm25 = BM25Retriever.from_documents(
            bm25_documents, preprocess_func=self.preprocess, bm25_params=BM25_PARAMS, k=len(documents),
        )
        self.corpus_tokens = [set(freqs) for freqs in self.bm25.vectorizer.doc_freqs]
        if any(not tokens for tokens in self.corpus_tokens):
            raise ValueError("토큰이 없는 FAQ가 있습니다.")
        self.embed_query, self.dense_search = embed_query, dense_search
        self.expected_dimensions = expected_dimensions
        self.weight, self.c = bm25_weight, c

    def search(self, question: str, *, top_k: int = 3) -> dict:
        if not question.strip() or top_k<1:
            raise ValueError("질문과 top_k가 올바르지 않습니다.")
        timings = {}
        start = perf_counter()
        tokens = self.preprocess(question)
        ranked_bm25 = rank_bm25(
            self.documents, self.bm25.vectorizer.get_scores(tokens), tokens, self.corpus_tokens,
        )
        timings["tokenization_and_bm25_seconds"] = perf_counter()-start
        start = perf_counter()
        query_vector = self.embed_query(question)
        vector_norm(query_vector, expected_size=self.expected_dimensions)
        timings["embedding_seconds"] = perf_counter()-start
        start = perf_counter()
        dense_results = self.dense_search(query_vector)
        seen, dense_docs, dense_scores = set(), [], {}
        for document, score in dense_results:
            key = str(document.metadata.get("_id"))
            original = self.by_id.get(key)
            if original is None or key in seen or not math.isfinite(float(score)):
                raise ValueError("벡터 검색 포인트가 누락/중복/변경됐습니다.")
            if original.page_content!=document.page_content or original.metadata["header_3"]!=document.metadata.get("header_3"):
                raise ValueError("BM25 준비 후 자료가 변경됐습니다. 다시 초기화하세요.")
            seen.add(key)
            dense_docs.append(original)
            dense_scores[original.metadata["chunk_id"]] = float(score)
        if seen!=set(self.by_id):
            raise ValueError("전체 FAQ 벡터 후보를 받지 못했습니다.")
        timings["dense_search_seconds"] = perf_counter()-start
        start = perf_counter()
        ranked = fuse(
            [self.by_chunk[row["chunk_id"]] for row in ranked_bm25], dense_docs,
            bm25_weight=self.weight, c=self.c,
        )
        for row in ranked:
            row["source"] = self.by_chunk[row["chunk_id"]].metadata.get("source")
            row["dense_score"] = dense_scores[row["chunk_id"]]
        timings["fusion_seconds"] = perf_counter()-start
        return {"question": question, "query_tokens": tokens, "timings": timings,
                "results": ranked[:top_k], "all_results": ranked, "bm25_results": ranked_bm25}



def vector_norm(vector, expected_size):
    if len(vector) != expected_size or not all(math.isfinite(float(x)) for x in vector):
        raise ValueError("벡터 차원 또는 값 오류")
    norm = math.sqrt(sum(float(x)**2 for x in vector))
    if norm == 0:
        raise ValueError("영벡터는 검색할 수 없습니다.")
    return norm
