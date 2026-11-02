"""변경분 임베딩 → 준비 포인트 검증 → 영속 판본과 BM25 전환. 단일 소비자용."""

import threading
from dataclasses import dataclass

from app.rag.faq_documents import FaqDocumentRefresh, FaqDocuments, FaqSearchDescription, faq_source_hash
from app.rag.faq_events import FaqDeletionChanged, deletion_keys
from app.rag.faq_index_state import checked_vector
from app.rag.faq_search import FaqSnapshotSearch


@dataclass(frozen=True)
class FaqIndexSnapshot:
    generation: int
    faqs: tuple[FaqDocuments, ...]
    point_ids: tuple[str, ...]
    search: FaqSnapshotSearch | None


class FaqIndex:
    def __init__(self, state, vectors, embeddings, *, validate_chunks, embedding_batch_size,
                 bm25_weight, rrf_c, bm25_descriptions=None):
        if embedding_batch_size < 1 or not callable(validate_chunks):
            raise ValueError('임베딩 묶음 크기와 등록 길이 검증기가 필요합니다.')
        if (state.collection, state.dimensions) != (vectors.collection, vectors.dimensions):
            raise ValueError('원문 판본과 벡터 컬렉션 설정이 다릅니다.')
        self.state, self.vectors, self.embeddings = state, vectors, embeddings
        self.validate_chunks, self.batch_size = validate_chunks, embedding_batch_size
        self.bm25_weight, self.rrf_c = bm25_weight, rrf_c
        self.bm25_descriptions = dict(bm25_descriptions or {})
        self.writer_lock, self.snapshot_lock = threading.Lock(), threading.Lock()
        generation, faqs = state.read(exclude_blocked=True)
        chunks = tuple(chunk for faq in faqs for chunk in faq.chunks)
        # 재시작은 캐시/기존 포인트를 검증하며 문서를 재임베딩하지 않는다. 등록 때 이미 통과한 길이 검증(GPU)은 다시 하지
        # 않는다: GPU VM은 30분 뒤 자동 중지라 기동 때 부르면 전화 서버가 뜨지 못한다(2026-11-02 Jenkins #52·#53)
        if chunks:
            for start in range(0, len(chunks), self.batch_size):
                batch = chunks[start:start+self.batch_size]
                pairs = [(chunk, self._required_cache(chunk)) for chunk in batch]
                vectors.verify(pairs)
        self._snapshot = self._build(generation, faqs)
        # 실제 삭제 응답/SQLite 커밋 사이에서 중단됐거나 늦은 쓰기가 남았어도 재정리한다.
        self.reconcile_deletions()

    def _required_cache(self, chunk):
        vector = self.state.cached(chunk)
        if vector is None:
            raise ValueError('활성 FAQ의 임베딩 캐시가 없습니다.')
        return vector

    def _build(self, generation, faqs):
        chunks = tuple(chunk for faq in faqs for chunk in faq.chunks)
        if len({chunk.point_id for chunk in chunks}) != len(chunks):
            raise ValueError('활성 포인트 ID가 중복됩니다.')
        search = None
        if chunks:
            inputs = {chunk.point_id: chunk.embedding_text for chunk in chunks}
            for chunk in chunks:
                description = self.bm25_descriptions.get(chunk.faq_id)
                if description is not None and description.source_sha256 == chunk.source_sha256:
                    if description.faq_id != chunk.faq_id or not description.text.strip():
                        raise ValueError('BM25 설명의 FAQ 연결이 올바르지 않습니다.')
                    inputs[chunk.point_id] = chunk.content+'\n\n검색용 설명: '+description.text
            search = FaqSnapshotSearch(chunks, self.embeddings, self.vectors, self.state.events,
                dimensions=self.state.dimensions, bm25_weight=self.bm25_weight, rrf_c=self.rrf_c,
                bm25_inputs=inputs)
        return FaqIndexSnapshot(generation, tuple(faqs), tuple(chunk.point_id for chunk in chunks), search)

    def current(self):
        with self.snapshot_lock:
            return self._snapshot

    def apply(self, refresh: FaqDocumentRefresh) -> FaqIndexSnapshot:
        keys = deletion_keys(refresh.delete_ids) if refresh.delete_ids else ()
        if set(keys).intersection(faq.faq_id for faq in refresh.upserts):
            raise ValueError('같은 FAQ를 갱신하고 삭제할 수 없습니다.')
        if refresh.delete_ids:
            # 긴 쓰기 작업의 잠금을 기다리는 동안에도 반환을 금지한다.
            self.state.events.block_deletes(refresh.delete_ids, refresh.event_id)
        with self.writer_lock:
            while True:
                try:
                    return self._apply_locked(refresh)
                except FaqDeletionChanged:
                    # 차단은 영속적이라 후보는 엄격히 줄어든다. 새 본문을 되살리지 않는다.
                    continue

    def _apply_locked(self, refresh):
        generation, faqs = self.state.read(exclude_blocked=True)
        if generation != self.current().generation:
            raise RuntimeError('다른 프로세스가 판본을 변경했습니다. 단일 소비자를 사용하세요.')
        blocked = self.state.events.blocked_ids()
        upserts = tuple(faq for faq in refresh.upserts if faq.faq_id not in blocked)
        target = {faq.faq_id: faq for faq in faqs if faq.faq_id not in blocked}
        target.update({faq.faq_id: faq for faq in upserts})
        candidate_faqs = tuple(target[key] for key in sorted(target))
        if candidate_faqs == faqs and not refresh.delete_ids:
            return self.current()
        incoming = tuple(chunk for faq in upserts for chunk in faq.chunks)
        if incoming:
            self.validate_chunks(incoming)
        for chunk in incoming:
            self.state.check_chunk(chunk)
        candidate = self._build(generation+1, candidate_faqs)
        cached, missing = {}, {}
        for chunk in incoming:
            vector = self.state.cached(chunk)
            if vector is None:
                missing.setdefault(chunk.embedding_sha256, chunk)
            else:
                cached[chunk.embedding_sha256] = vector
        missing = list(missing.values())
        for start in range(0, len(missing), self.batch_size):
            batch = missing[start:start+self.batch_size]
            output = self.embeddings.embed_documents([chunk.embedding_text for chunk in batch])
            if not isinstance(output, (list, tuple)) or len(output) != len(batch):
                raise ValueError('문서 임베딩 반환 개수가 다릅니다.')
            pairs = [(chunk, checked_vector(vector, self.state.dimensions))
                     for chunk, vector in zip(batch, output, strict=True)]
            self.state.cache(pairs)
            cached.update({chunk.embedding_sha256: vector for chunk, vector in pairs})
        if set(faq.faq_id for faq in candidate_faqs) & self.state.events.blocked_ids():
            raise FaqDeletionChanged()
        self.state.reference_cached(incoming)
        existing = set(self.current().point_ids)
        pairs = [(chunk, cached[chunk.embedding_sha256]) for chunk in incoming if chunk.point_id not in existing]
        for start in range(0, len(pairs), self.batch_size):
            self.vectors.stage(pairs[start:start+self.batch_size])
        if set(faq.faq_id for faq in candidate_faqs) & self.state.events.blocked_ids():
            raise FaqDeletionChanged()
        if refresh.delete_ids:
            self.vectors.delete_faqs(refresh.delete_ids)
        all_chunks = tuple(chunk for faq in candidate_faqs for chunk in faq.chunks)
        for start in range(0, len(all_chunks), self.batch_size):
            batch = all_chunks[start:start+self.batch_size]
            self.vectors.verify([(chunk, self._required_cache(chunk)) for chunk in batch])
        options = {'delete_ids': refresh.delete_ids} if refresh.delete_ids else {}
        published = self.state.commit(candidate_faqs, expected_generation=generation, **options)
        if published != candidate.generation:
            raise RuntimeError('커밋한 FAQ 세대가 다릅니다.')
        with self.snapshot_lock:
            self._snapshot = candidate
        return candidate

    def filter_rows(self, rows):
        """리랭킹 후에도 Live 전달 직전에 다시 호출할 반환 경계다."""
        blocked = self.state.events.blocked_ids()
        if any(not isinstance(row.get('source'), str) or not row['source'].startswith('backend-faq:') for row in rows):
            raise ValueError('FAQ 근거에 원본 관리번호가 없습니다.')
        return [row for row in rows if row['source'] not in blocked]

    def descriptions_for(self, entries):
        """같은 원문에 검증돼 저장된 검색 설명만 다음 알림에서도 유지한다."""
        _, faqs = self.state.read(exclude_blocked=True)
        by_id = {faq.faq_id: faq for faq in faqs}
        result = {}
        for entry in entries:
            key = f'backend-faq:{entry.faq_id}'
            old = by_id.get(key)
            if old is None or old.source_sha256 != faq_source_hash(entry):
                continue
            descriptions = set()
            for chunk in old.chunks:
                if chunk.embedding_text == chunk.content:
                    descriptions.add(None)
                else:
                    prefix = chunk.content+'\n\n검색용 설명: '
                    if not chunk.embedding_text.startswith(prefix):
                        raise ValueError('저장된 검색 입력 형식이 다릅니다.')
                    descriptions.add(chunk.embedding_text[len(prefix):])
            if len(descriptions) != 1:
                raise ValueError('동일 FAQ 자식의 검색 설명이 다릅니다.')
            text = descriptions.pop()
            if text is not None:
                result[key] = FaqSearchDescription(key, old.source_sha256, text)
        return result

    def reconcile_deletions(self):
        """단일 소비자가 기동/점검 시 모든 삭제 이력을 다시 정리한다."""
        statuses = self.state.events.deletion_status()
        pending = sorted(int(key.removeprefix('backend-faq:')) for key, status in statuses.items() if status == 'PENDING')
        cleaned = sorted(int(key.removeprefix('backend-faq:')) for key, status in statuses.items() if status == 'CLEANED')
        size = min(self.batch_size, 100)
        for start in range(0, len(pending), size):
            self.apply(FaqDocumentRefresh('delete-reconciliation', (), tuple(pending[start:start+size])))
        # 이미 CLEANED인 번호는 새 세대를 만들 필요가 없다. 늦게 생긴 포인트만 재삭제한다.
        with self.writer_lock:
            for start in range(0, len(cleaned), size):
                self.vectors.delete_faqs(cleaned[start:start+size])
