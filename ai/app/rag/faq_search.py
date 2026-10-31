"""캡처한 검색 판본에도 최신 FAQ 삭제 차단을 적용한다."""

from copy import copy
from time import perf_counter

from app.rag.hybrid import HybridSearchExperiment


class FaqSnapshotSearch:
    def __init__(self, chunks, embeddings, vectors, events, *, dimensions, bm25_weight, rrf_c, bm25_inputs=None):
        self.chunks, self.embeddings, self.vectors, self.events = tuple(chunks), embeddings, vectors, events
        self.dimensions, self.bm25_weight, self.rrf_c = dimensions, bm25_weight, rrf_c
        self.by_id = {chunk.point_id: chunk for chunk in chunks}
        self.bm25_inputs = bm25_inputs or {chunk.point_id: chunk.embedding_text for chunk in chunks}
        self.base = self._make(self.chunks)

    def _make(self, chunks):
        return HybridSearchExperiment([chunk.document() for chunk in chunks], self.embeddings.embed_query,
            lambda vector: self.vectors.search(vector, chunks), bm25_weight=self.bm25_weight,
            c=self.rrf_c, expected_dimensions=self.dimensions,
            search_inputs={chunk.point_id: self.bm25_inputs[chunk.point_id] for chunk in chunks})

    def _allowed(self):
        blocked = self.events.blocked_ids()
        return tuple(chunk for chunk in self.chunks if chunk.faq_id not in blocked)

    def _filtered(self, rows, blocked):
        if any(row['chunk_id'] not in self.by_id for row in rows):
            raise ValueError('검색 판본 밖의 근거입니다.')
        return [row for row in rows if self.by_id[row['chunk_id']].faq_id not in blocked]

    def search(self, question, *, top_k=3):
        if not question.strip() or top_k < 1:
            raise ValueError('질문과 top_k가 올바르지 않습니다.')
        vector, embedding_seconds, retries, retry_seconds = None, 0., 0, 0.

        def embed_once(text):
            nonlocal vector, embedding_seconds
            if vector is None:
                started = perf_counter()
                vector = self.embeddings.embed_query(text)
                embedding_seconds += perf_counter()-started
            return vector

        while True:
            allowed = self._allowed()
            if not allowed:
                return {'question': question, 'query_tokens': [], 'results': [], 'all_results': [], 'deletion_retries': retries,
                    'bm25_results': [], 'timings': {'tokenization_and_bm25_seconds': 0.,
                    'embedding_seconds': embedding_seconds, 'dense_search_seconds': 0.,
                    'fusion_seconds': 0., 'deletion_retry_seconds': retry_seconds}}
            started = perf_counter()
            # 요청별 얕은 복사로 임베딩 콜백만 교체한다. 공유 BM25/문서는 읽기만 한다.
            hybrid = copy(self.base if allowed == self.chunks else self._make(allowed))
            hybrid.embed_query = embed_once
            try:
                found = hybrid.search(question, top_k=top_k)
            except Exception:
                # 삭제와 겹쳐 포인트가 사라졌다면 더 작은 허용 목록으로 재검색한다.
                # 목록이 줄지 않았으면 네트워크/자료 오류를 그대로 올린다.
                if self._allowed() == allowed:
                    raise
                retries += 1
                retry_seconds += perf_counter()-started
                continue
            blocked = self.events.blocked_ids()
            found['all_results'] = self._filtered(found['all_results'], blocked)
            found['results'] = found['all_results'][:top_k]
            found['bm25_results'] = self._filtered(found['bm25_results'], blocked)
            found['timings']['embedding_seconds'] = embedding_seconds
            found['timings']['deletion_retry_seconds'] = retry_seconds
            found['deletion_retries'] = retries
            return found
