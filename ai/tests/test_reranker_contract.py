import json

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient

from app.rag.remote import RemoteReranker
from app.rag.gpu import create_gpu_app
from app.rag.qwen import MODEL, REVISION, QwenReranker


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


def test_gpu_document_validation_uses_pinned_token_budget(monkeypatch):
    monkeypatch.setenv('RAG_RERANKER_API_KEY', 'test-only')
    class Model:
        max_length = 1024
        def validate_documents(self, documents):
            assert documents == ['원문 표']
            return [100]
    with TestClient(create_gpu_app(Model())) as client:
        body = {'documents': [{'chunk_id': 'a', 'content': '원문 표'}]}
        assert client.post('/validate-documents', json=body).status_code == 401
        result = client.post('/validate-documents', json=body,
                             headers={'Authorization':'Bearer test-only'})
        assert result.status_code == 200
        assert result.json()['results'] == [{'chunk_id':'a', 'tokens_without_query':100}]


def test_remote_document_validation_rejects_wrong_revision_and_missing_ids():
    class Chunk:
        point_id, content = 'a', '원문 표'
    good = {'model': MODEL, 'revision': REVISION, 'max_length':1024,
            'query_reserve_tokens':256, 'token_margin':32,
            'results':[{'chunk_id':'a','tokens_without_query':100}]}
    seen = []
    def handler(request):
        seen.append(json.loads(request.content))
        assert request.url.path == '/validate-documents'
        assert request.headers['Authorization'] == 'Bearer test'
        return httpx.Response(200, json=good)
    client = RemoteReranker('https://pod.example', 'test', 1, transport=httpx.MockTransport(handler))
    try:
        client.validate_chunks((Chunk(),))
        assert seen == [{'documents':[{'chunk_id':'a','content':'원문 표'}]}]
    finally:
        client.close()
    for bad in ({**good, 'revision':'other'}, {**good,'results':[]},
                {**good,'results':[{'chunk_id':'a','tokens_without_query':900}]}):
        client = RemoteReranker('https://pod.example', 'test', 1,
            transport=httpx.MockTransport(lambda request:httpx.Response(200,json=bad)))
        try:
            with pytest.raises(ValueError):
                client.validate_chunks((Chunk(),))
        finally:
            client.close()


def test_qwen_registration_budget_checks_actual_tokenizer_without_truncation():
    class Tokenizer:
        def encode(self, text, add_special_tokens=False):
            return list(text.encode('utf-8'))
    reranker = object.__new__(QwenReranker)
    reranker.tokenizer = Tokenizer()
    reranker.max_length = 1024
    reranker.instruction = '검색'
    assert reranker.validate_documents(['짧은 답변'])[0] > 0
    with pytest.raises(ValueError):
        reranker.validate_documents(['가' * 400])
