"""원문 조회의 오류/정상 누락 구분과 이벤트 입력 준비. 실제 외부 API 호출 없음."""

from uuid import uuid4

import httpx2
import pytest

from app.backend_api import BackendAPI, BackendError
from app.rag.faq_events import FaqChange, FaqEventStore
from app.rag.faq_source import parse_faq_lookup, prepare_faq_refresh
from conftest import run


def entry(faq_id=123, **changes):
    return {'faqEntrySeq':faq_id, 'question':'소형 요금은 얼마인가요?',
            'answer':' 유인 기준입니다.\n\n| 규격 | 요금 |\n| --- | --- |\n| 소형 | 4,950원 |\n',
            'updatedAt':'2026-10-30T01:00:00.000Z', **changes}


def page(*entries, **changes):
    return {'data':list(entries),'hasNext':False, **changes}


async def fetch(payload, ids=None, *, status=200):
    client = BackendAPI('http://backend',3,transport=httpx2.MockTransport(
        lambda req:httpx2.Response(status,json=payload)))
    try:
        return await client.faq_entries(ids if ids is not None else [123])
    finally:
        await client.close()


def change(operation='INSERT', ids=None):
    return FaqChange.model_validate({'eventId':str(uuid4()),'operation':operation,
                                    'faqEntrySeqs':ids if ids is not None else [123]})


def test_filtered_request_does_not_forward_cookies_or_unrelated_headers():
    seen=[]
    def handler(request):
        seen.append(request)
        return httpx2.Response(200,json=page(entry(),entry(124)))
    async def scenario():
        client = BackendAPI('http://backend',3,transport=httpx2.MockTransport(handler),persona_token='persona-secret')
        client.http.headers.update({'Authorization':'Bearer unrelated', 'call_session_seq':'77','X-Private':'private'})
        client.http.cookies.set('dva_session','admin-session')
        try:
            return await client.faq_entries([124,123])
        finally:
            await client.close()
    found=run(scenario())
    req=seen[0]
    assert req.method=='GET' and req.url.path=='/api/ai/faqs'
    assert dict(req.url.params)=={'faqEntrySeqs':'123,124','limit':'100','offset':'0'}
    assert all(name not in req.headers for name in ('cookie','authorization','call_session_seq','x-private'))
    assert req.extensions['timeout']['read']==3
    assert [row.faq_id for row in found.entries]==[123,124] and found.missing_ids==()


def test_original_markdown_preserved_exactly():
    original=entry()
    found=run(fetch(page(original)))
    assert found.entries[0].question==original['question']
    assert found.entries[0].answer==original['answer']
    assert found.entries[0].updated_at==original['updatedAt']


def test_normal_missing_ids_and_empty_page_are_explicit():
    found=run(fetch(page(entry(124)),[123,124]))
    assert found.missing_ids==(123,)
    assert run(fetch(page(),[123,124])).missing_ids==(123,124)


def test_one_hundred_items_in_one_filtered_page():
    found=run(fetch(page(*(entry(i) for i in range(1,101))),list(range(1,101))))
    assert len(found.entries)==100 and found.missing_ids==()


@pytest.mark.parametrize('payload', [
    None, [], {}, {'data':[]}, {'hasNext':False}, page(hasNext=True),
    page(hasNext='false'), page(hasNext=0), page(hasNext=None), page(data=None),
    page(entry(999)), page(entry(),entry()), page(entry(124),entry(123)),
    page(entry(faqEntrySeq=True)), page(entry(faqEntrySeq='123')), page(entry(faqEntrySeq=0)),
    page(entry(faqEntrySeq=2147483648)), page(entry(question=' ')), page(entry(answer='\t\n')),
    page(entry(question=None)), page(entry(answer=42)), page(entry(answer='a\x00b')),
    page(entry(question='a'*1001)), page(entry(answer='a'*20001)),
    page(entry(updatedAt='2026-10-30')), page(entry(updatedAt='2026-10-30T10:00:00')),
    page(entry(updatedAt='2026-10-30T10:00:00+09:00')), page(entry(updatedAt='bad')),
    page(entry(updatedAt=123)), page(entry(unexpected='value')),
    page(extra='value'), page(*(entry(i) for i in range(1,102))),
])
def test_invalid_or_partial_response_never_becomes_deletion(payload):
    with pytest.raises(BackendError,match='FAQ_INVALID_RESPONSE'):
        run(fetch(payload,[123,124]))


@pytest.mark.parametrize('status',[204,301,302,400,401,403,404,429,500,503])
def test_http_error_is_not_an_empty_success(status):
    with pytest.raises(BackendError,match=f'FAQ_HTTP_ERROR:{status}'):
        run(fetch(page(),status=status))


@pytest.mark.parametrize('error',[httpx2.ConnectError,httpx2.ReadTimeout,httpx2.RemoteProtocolError])
def test_network_errors_are_sanitized(error):
    async def scenario():
        def handler(req):
            raise error('must-not-leak-secret',request=req)
        client=BackendAPI('http://backend',3,transport=httpx2.MockTransport(handler))
        try:
            with pytest.raises(BackendError) as raised:
                await client.faq_entries([123])
            assert str(raised.value)=='FAQ_FETCH_FAILED'
            assert raised.value.__suppress_context__
        finally:
            await client.close()
    run(scenario())


def test_invalid_json_is_not_deletion():
    async def scenario():
        client=BackendAPI('http://backend',3,transport=httpx2.MockTransport(
            lambda req:httpx2.Response(200,content=b'not json')))
        try:
            with pytest.raises(BackendError,match='FAQ_INVALID_RESPONSE'):
                await client.faq_entries([123])
        finally:
            await client.close()
    run(scenario())


def test_redirect_cannot_forward_request_to_another_host():
    seen=[]
    async def scenario():
        def handler(request):
            seen.append(request)
            return httpx2.Response(302,headers={'Location':'http://unexpected-host/anything'})
        client=BackendAPI('http://backend',3,transport=httpx2.MockTransport(handler))
        client.http.follow_redirects=True  # 호출자의 기본값과 무관하게 원문 조회는 따르지 않는다.
        try:
            with pytest.raises(BackendError,match='FAQ_HTTP_ERROR:302'):
                await client.faq_entries([123])
        finally:
            await client.close()
    run(scenario())
    assert len(seen)==1 and seen[0].url.host=='backend'


@pytest.mark.parametrize('ids',[[],[1,1],[True],['1'],[1.0],[0],[-1],[2147483648],list(range(1,102))])
def test_invalid_filter_rejected_before_http(ids):
    seen=[]
    async def scenario():
        client=BackendAPI('http://backend',3,transport=httpx2.MockTransport(lambda req:seen.append(req)))
        try:
            with pytest.raises(ValueError):
                await client.faq_entries(ids)
        finally:
            await client.close()
    run(scenario())
    assert seen==[]


def test_delete_never_fetches_missing_original():
    class NeverFetch:
        async def faq_entries(self, ids):
            pytest.fail('DELETE에서는 백엔드 원문을 조회하지 않아야 한다.')
    event=change('DELETE',[124,123])
    prepared=run(prepare_faq_refresh(event,NeverFetch()))
    assert prepared.event_id==event.event_id and prepared.upserts==() and prepared.delete_ids==(123,124)


@pytest.mark.parametrize('operation',['INSERT','UPDATE'])
def test_prepare_preserves_queue_until_index_really_applies(tmp_path,operation):
    events=FaqEventStore(tmp_path/'events.sqlite3',max_pending=10,busy_timeout_sec=.1)
    event=change(operation)
    events.enqueue(event)
    claimed=events.claim_next()
    class Source:
        async def faq_entries(self, ids):
            return parse_faq_lookup(page(entry()),ids)
    prepared=run(prepare_faq_refresh(claimed,Source()))
    assert prepared.upserts[0].faq_id==123 and prepared.delete_ids==()
    assert events.get(event.event_id)['status']=='PROCESSING'


def test_prepare_missing_and_failure_are_different(tmp_path):
    events=FaqEventStore(tmp_path/'events.sqlite3',max_pending=10,busy_timeout_sec=.1)
    first,second=change(),change('DELETE')
    events.enqueue(first)
    events.enqueue(second)
    claimed=events.claim_next()
    class Source:
        async def faq_entries(self, ids):
            return await fetch(page(),ids,status=503)
    with pytest.raises(BackendError):
        run(prepare_faq_refresh(claimed,Source()))
    assert events.get(first.event_id)['status']=='PROCESSING'
    events.retry(first.event_id,error_code='APPLY_FAILED',retry_at=20)
    assert events.claim_next(now=19) is None
    claimed=events.claim_next(now=20)
    class Missing:
        async def faq_entries(self, ids):
            return parse_faq_lookup(page(),ids)
    prepared=run(prepare_faq_refresh(claimed,Missing()))
    assert prepared.upserts==() and prepared.delete_ids==(123,)
    assert events.get(first.event_id)['status']=='PROCESSING'
