"""평가에서 검증한 FAQ·BM25·RRF 알고리즘. 외부 호출이나 CLI 실행 없음."""

import hashlib
import math
from pathlib import Path
from langchain_core.documents import Document
from langchain_core.runnables import RunnableLambda
from app.rag.chunking import split_markdown

BM25_PARAMS = {"k1": 1.5, "b": 0.75, "epsilon": 0.25}


def faq_documents(source_text: str, source: Path) -> list[Document]:
    chunks = split_markdown([Document(
        page_content=source_text, metadata={"source": str(source.resolve()), "source_kind": "markdown"},
    )], chunk_size=800, chunk_overlap=50)
    documents = []
    seen = set()
    for chunk in chunks:
        title = chunk.metadata.get("header_3")
        if not title:
            continue
        # 이번 비교는 FAQ별 한 청크인 자료 계약이다. 조용히 일부만 평가하지 않는다.
        if title in seen:
            raise ValueError("동일 FAQ가 여러 청크입니다. FAQ 집계 정책을 먼저 정하세요.")
        seen.add(title)
        chunk.metadata["chunk_id"] = hashlib.sha256((title+"\n"+chunk.page_content).encode("utf-8")).hexdigest()
        documents.append(chunk)
    if not documents:
        raise ValueError("FAQ 청크가 없습니다.")
    return documents


def rank_bm25(documents, scores, query_tokens, corpus_tokens) -> list[dict]:
    if len(documents) != len(scores) or len(documents) != len(corpus_tokens):
        raise ValueError("점수/문서/토큰 수가 다릅니다.")
    results = []
    for document, score, tokens in zip(documents, scores, corpus_tokens, strict=True):
        if not math.isfinite(float(score)):
            raise ValueError("BM25 점수가 유효하지 않습니다.")
        matches = sorted(set(query_tokens).intersection(tokens))
        # get_top_n은 일치 단어가 없어도 문서를 채운다. 그런 우연 적중은 제외한다.
        if matches:
            results.append({
                "title": document.metadata["header_3"], "chunk_id": document.metadata["chunk_id"],
                "score": float(score), "matched_tokens": matches, "context": document.page_content,
            })
    return sorted(results, key=lambda row: (-row["score"], row["chunk_id"]))


def fuse(bm25_docs, dense_docs, *, bm25_weight=0.5, c=60):
    from langchain_classic.retrievers import EnsembleRetriever

    if not 0 < bm25_weight < 1 or c < 0:
        raise ValueError("가중치는 0과 1 사이, c는 0 이상이어야 합니다.")
    for docs in (bm25_docs, dense_docs):
        if len({doc.metadata["chunk_id"] for doc in docs}) != len(docs):
            raise ValueError("한 검색 목록에 같은 문서가 중복됐습니다.")
    # 저장 결과를 반환하는 검색기다. 네트워크 invoke 없이 공개 순위 융합 메서드만 실행한다.
    ensemble = EnsembleRetriever(
        retrievers=[RunnableLambda(lambda _: bm25_docs), RunnableLambda(lambda _: dense_docs)],
        weights=[bm25_weight, 1-bm25_weight], c=c, id_key="chunk_id",
    )
    fused = ensemble.weighted_reciprocal_rank([bm25_docs, dense_docs])
    positions = [
        {doc.metadata["chunk_id"]: rank for rank, doc in enumerate(docs, 1)}
        for docs in (bm25_docs, dense_docs)
    ]
    rows = []
    for doc in fused:
        key = doc.metadata["chunk_id"]
        br, dr = positions[0].get(key), positions[1].get(key)
        bc = bm25_weight/(c+br) if br else 0
        dc = (1-bm25_weight)/(c+dr) if dr else 0
        rows.append({
            "title": doc.metadata["header_3"], "chunk_id": key, "context": doc.page_content,
            "bm25_rank": br, "dense_rank": dr, "bm25_contribution": bc,
            "dense_contribution": dc, "score": bc+dc,
        })
    return rows
