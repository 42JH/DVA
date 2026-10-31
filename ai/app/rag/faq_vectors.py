"""FAQ 관리 전용 Qdrant 컬렉션의 준비 포인트 쓰기·검증·판본별 검색."""

import math

from qdrant_client import models

from app.rag.faq_index_state import checked_vector
from app.rag.faq_events import deletion_keys


class QdrantFaqVectors:
    def __init__(self, client, *, collection, dimensions):
        self.client, self.collection, self.dimensions = client, collection, dimensions
        vector = client.get_collection(collection).config.params.vectors
        if not isinstance(vector, models.VectorParams) or vector.size != dimensions or vector.distance != models.Distance.COSINE:
            raise ValueError('FAQ 관리 전용 unnamed Cosine 컬렉션의 차원을 확인하세요.')

    def stage(self, pairs):
        pairs = list(pairs)
        if not pairs:
            return
        points = [models.PointStruct(id=chunk.point_id, vector=list(checked_vector(vector, self.dimensions)),
            payload={'page_content': chunk.content, 'metadata': chunk.document().metadata}) for chunk, vector in pairs]
        result = self.client.upsert(collection_name=self.collection, points=points, wait=True,
                                    ordering=models.WriteOrdering.STRONG)
        if result.status != models.UpdateStatus.COMPLETED:
            raise RuntimeError('FAQ 포인트 쓰기가 완료되지 않았습니다.')
        self.verify(pairs)

    def verify(self, pairs):
        expected = {chunk.point_id: (chunk, checked_vector(vector, self.dimensions)) for chunk, vector in pairs}
        if not expected:
            return
        points = self.client.retrieve(collection_name=self.collection, ids=list(expected), with_payload=True, with_vectors=True)
        if len(points) != len(expected) or {str(point.id) for point in points} != set(expected):
            raise RuntimeError('준비한 FAQ 포인트가 모두 저장되지 않았습니다.')
        for point in points:
            chunk, vector = expected[str(point.id)]
            if point.payload != {'page_content': chunk.content, 'metadata': chunk.document().metadata}:
                raise ValueError('Qdrant FAQ 원문/메타데이터가 다릅니다.')
            actual = checked_vector(point.vector, self.dimensions)
            # Cosine 저장 시 정규화/float32 변환을 고려해 방향을 비교한다.
            actual_norm, expected_norm = math.hypot(*actual), math.hypot(*vector)
            cosine = sum(a/actual_norm * b/expected_norm for a, b in zip(actual, vector, strict=True))
            if not math.isclose(cosine, 1.0, abs_tol=1e-6):
                raise ValueError('Qdrant FAQ 벡터 방향이 다릅니다.')

    def search(self, vector, chunks):
        if not chunks:
            return []
        originals = {chunk.point_id: chunk for chunk in chunks}
        points = self.client.query_points(collection_name=self.collection,
            query=list(checked_vector(vector, self.dimensions)),
            query_filter=models.Filter(must=[models.HasIdCondition(has_id=list(originals))]),
            limit=len(originals), with_payload=True).points
        if len(points) != len(originals) or {str(point.id) for point in points} != set(originals):
            raise RuntimeError('현재 판본의 FAQ 검색 포인트가 누락/중복됐습니다.')
        results = []
        for point in points:
            chunk = originals[str(point.id)]
            if point.payload != {'page_content': chunk.content, 'metadata': chunk.document().metadata}:
                raise ValueError('검색 중 FAQ 원문/메타데이터가 달라졌습니다.')
            results.append((chunk.document(), point.score))
        return results

    def delete_faqs(self, ids):
        keys = deletion_keys(ids)
        # 활성 ID뿐 아니라 모든 옛 버전/실패한 준비 버전을 FAQ 번호로 지운다.
        condition = models.Filter(must=[models.FieldCondition(key='metadata.faq_id',
            match=models.MatchAny(any=list(keys)))])
        result = self.client.delete(collection_name=self.collection,
            points_selector=models.FilterSelector(filter=condition), wait=True,
            ordering=models.WriteOrdering.STRONG)
        if result.status != models.UpdateStatus.COMPLETED:
            raise RuntimeError('FAQ 벡터 삭제가 완료되지 않았습니다.')
        remaining = self.client.count(collection_name=self.collection, count_filter=condition, exact=True).count
        if remaining != 0:
            raise RuntimeError('삭제한 FAQ 벡터가 남아 있습니다.')
