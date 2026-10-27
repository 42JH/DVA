import json

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient

from app.rag.remote import RemoteReranker
from app.rag.gpu import create_gpu_app
from app.rag.qwen import MODEL, REVISION


def response(results, **kwargs):
    return {'model': MODEL, 'revision': REVISION, 'results': results, **kwargs}


def test_remote_validates_version_ids_and_keeps_original_bodies():
    def handler(request):
        assert request.url.path == '/rerank'
        assert request.headers['Authorization'] == 'Bearer test'
        assert json.loads(request.content)['documents'][0]['content'] == '원문 표'
        return httpx.Response(200, json=response([{'chunk_id': 'b', 'score': 2}, {'chunk_id': 'a', 'score': 1}]))
    client = RemoteReranker('https://pod.example', 'test', 1, transport=httpx.MockTransport(handler))
    docs = [{'chunk_id': 'a', 'context': '원문 표'}, {'chunk_id': 'b', 'context': '원문 조건'}]
    try:
        ranked = client.rerank('질문', docs)
        assert [doc['chunk_id'] for doc in ranked] == ['b', 'a']
        assert ranked[0]['context'] == '원문 조건'
    finally:
        client.close()


@pytest.mark.parametrize('payload', [response([]), response([{'chunk_id': 'a', 'score': True}]),
    response([{'chunk_id': 'other', 'score': 1}]), response([{'chunk_id': 'a', 'score': 1}], revision='other'),
    response([{'chunk_id': 'a', 'score': 1}, {'chunk_id': 'a', 'score': 2}])])
def test_bad_rerank_response_rejected(payload):
    client = RemoteReranker('https://pod.example', 'test', 1,
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload)))
    try:
        with pytest.raises(ValueError):
            client.rerank('질문', [{'chunk_id': 'a', 'context': '원문'}])
    finally:
        client.close()


def test_gpu_api_auth_unique_ids_and_pinned_response(monkeypatch):
    monkeypatch.setenv('RAG_RERANKER_API_KEY', 'test-only')
    seen = []
    class Model:
        def predict(self, pairs):
            seen.extend(pairs)
            return [1.5]*len(pairs)
    with TestClient(create_gpu_app(Model())) as client:
        body = {'question': '질문', 'documents': [{'chunk_id': 'a', 'content': '원문'}]}
        assert client.post('/rerank', json=body).status_code == 401
        headers = {'Authorization': 'Bearer test-only'}
        result = client.post('/rerank', json=body, headers=headers)
        assert result.status_code == 200 and result.json()['revision'] == REVISION
        assert seen == [('질문', '원문')]
        body['documents'] *= 2
        assert client.post('/rerank', json=body, headers=headers).status_code == 422


def test_gpu_rejects_overlong_model_input_without_silent_truncation(monkeypatch):
    monkeypatch.setenv('RAG_RERANKER_API_KEY', 'test-only')
    class Model:
        def predict(self, pairs):
            raise ValueError('too long')
    with TestClient(create_gpu_app(Model())) as client:
        result = client.post('/rerank', headers={'Authorization': 'Bearer test-only'},
            json={'question': 'q', 'documents': [{'chunk_id': 'a', 'content': 'doc'}]})
        assert result.status_code == 422
