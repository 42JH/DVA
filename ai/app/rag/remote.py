"""리랭킹 전용 HTTP 계약. 반환된 본문을 신뢰하지 않고 원래 후보만 재정렬한다."""

import math
import httpx2 as httpx

from app.rag.qwen import MODEL, REVISION


class RemoteReranker:
    def __init__(self, url, api_key, timeout, *, transport=None):
        if not url or not api_key:
            raise ValueError('RAG_RERANKER_URL과 RAG_RERANKER_API_KEY가 필요합니다.')
        parsed = httpx.URL(url)
        if parsed.scheme not in ('http', 'https') or parsed.userinfo or parsed.query or parsed.fragment:
            raise ValueError('리랭커 주소 형식을 확인하세요.')
        if parsed.scheme != 'https' and parsed.host not in ('127.0.0.1', 'localhost', 'reranker'):
            raise ValueError('외부 리랭커는 HTTPS로 연결하세요.')
        self.client = httpx.Client(base_url=url.rstrip('/')+'/', timeout=timeout,
                                  headers={'Authorization': 'Bearer '+api_key}, transport=transport)

    def rerank(self, question, documents):
        response = self.client.post('rerank', json={'question': question, 'documents': [
            {'chunk_id': doc['chunk_id'], 'content': doc['context']} for doc in documents]})
        response.raise_for_status()
        data = response.json()
        if data.get('model') != MODEL or data.get('revision') != REVISION:
            raise ValueError('평가한 리랭킹 모델/버전과 다릅니다.')
        scores = {}
        for row in data.get('results', []):
            key, score = row.get('chunk_id'), row.get('score')
            if not isinstance(key, str) or key in scores or isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
                raise ValueError('리랭킹 ID 또는 점수가 올바르지 않습니다.')
            scores[key] = float(score)
        if set(scores) != {doc['chunk_id'] for doc in documents} or len(scores) != len(documents):
            raise ValueError('리랭킹 후보가 누락되거나 추가됐습니다.')
        rows = [{**doc, 'reranker_score': scores[doc['chunk_id']], 'input_rank': rank}
                for rank, doc in enumerate(documents, 1)]
        return sorted(rows, key=lambda doc: (-doc['reranker_score'], doc['input_rank']))

    def close(self):
        self.client.close()
