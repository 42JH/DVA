import asyncio

import httpx2
import pytest

from app.backend_api import BackendAPI, BackendError
from app.rag.faq_bootstrap import initial_event
from app.rag.faq_source import parse_initial_faqs
from test_faq_index import prepare, setup


def payload():
    return {'data':[prepare().source.model_dump(by_alias=True)], 'hasNext':False}


def test_initial_list_uses_bare_request_and_no_id_filter():
    def handler(request):
        assert dict(request.url.params) == {'limit':'100','offset':'0'}
        assert request.url.path == '/api/ai/faqs'
        assert 'authorization' not in request.headers and 'cookie' not in request.headers
        return httpx2.Response(200, json=payload())
    async def scenario():
        backend = BackendAPI('https://backend.example', 1, transport=httpx2.MockTransport(handler))
        backend.http.headers['Authorization'] = 'private'
        backend.http.cookies.set('admin', 'private')
        try:
            assert len(await backend.initial_faq_entries()) == 1
        finally:
            await backend.close()
    asyncio.run(scenario())


@pytest.mark.parametrize('body', [
    {'data':[], 'hasNext':True},
    {'data':payload()['data']*2, 'hasNext':False},
    {'data':[{'faqEntrySeq':1}], 'hasNext':False},
])
def test_invalid_or_partial_initial_list_is_not_enqueued(body):
    async def scenario():
        backend = BackendAPI('https://backend.example', 1,
            transport=httpx2.MockTransport(lambda request:httpx2.Response(200,json=body)))
        try:
            with pytest.raises(BackendError):
                await backend.initial_faq_entries()
        finally:
            await backend.close()
    asyncio.run(scenario())


def test_initial_event_is_idempotent_and_preserves_existing_queue_order(setup):
    env = setup
    entries = parse_initial_faqs(payload())
    event = initial_event(entries)
    assert event == initial_event(entries)
    assert initial_event(()) is None
    assert env.events.enqueue(event)
    assert not env.events.enqueue(initial_event(entries))
    assert env.events.claim_next() == event
    assert env.embeddings.calls == []
