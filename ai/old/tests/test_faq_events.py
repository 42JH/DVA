"""FAQ 수신 경계: 실제 백엔드·OpenAI·Qdrant 없이 디스크 큐를 검증한다."""

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.rag.faq_events import FaqChange, FaqEventStore, QueueFull
from conftest import FakeBackend, FakeClient

TOKEN = 'faq-test-token-'+'x'*32
HEADERS = {'Authorization': 'Bearer '+TOKEN}
URL = '/internal/faqs/refresh'


def body(operation='INSERT', ids=None, event_id=None):
    return {'eventId': event_id or str(uuid4()), 'operation': operation,
            'faqEntrySeqs': ids if ids is not None else [123]}


def event(**kwargs):
    return FaqChange.model_validate(body(**kwargs))


def store(tmp_path, *, max_pending=1000):
    return FaqEventStore(tmp_path/'faq-events.sqlite3', max_pending=max_pending, busy_timeout_sec=.1)


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv('AI_FAQ_TOKEN', TOKEN)
    events = store(tmp_path)
    with TestClient(create_app(client=FakeClient(), backend=FakeBackend(), faq_events=events)) as http:
        yield http, events


@pytest.mark.parametrize('operation,ids', [('INSERT', [1]), ('INSERT', list(range(1,101))),
    ('UPDATE', [5]), ('DELETE', [1]), ('DELETE', list(range(1,101)))])
def test_valid_operations_are_durable_before_202(api, operation, ids):
    http, events = api
    payload = body(operation, ids)
    response = http.post(URL, json=payload, headers=HEADERS)
    assert response.status_code == 202 and response.content == b''
    saved = events.get(payload['eventId'])
    assert saved['status'] == 'QUEUED'
    assert FaqChange.model_validate_json(saved['payload']).faq_ids == sorted(ids)


@pytest.mark.parametrize('change', [
    {'eventId':'not-a-uuid'}, {'eventId':None}, {'operation':'UPSERT'},
    {'faqEntrySeqs':[]}, {'faqEntrySeqs':[1,1]}, {'faqEntrySeqs':[True]},
    {'faqEntrySeqs':['1']}, {'faqEntrySeqs':[0]}, {'faqEntrySeqs':[-1]},
    {'faqEntrySeqs':[2147483648]}, {'faqEntrySeqs':[1.0]},
    {'faqEntrySeqs':list(range(1,102))}, {'operation':'UPDATE','faqEntrySeqs':[1,2]},
    {'question':'알림 본문에는 원문이 없음'}, {'revision':7},
])
def test_malformed_notifications_rejected_without_saving(api, change):
    http, events = api
    payload = {**body(), **change}
    assert http.post(URL, json=payload, headers=HEADERS).status_code == 400
    assert events.claim_next() is None


def test_auth_and_disabled_receiver(api, monkeypatch):
    http, _ = api
    assert http.post(URL, json=body()).status_code == 401
    assert http.post(URL, json=body(), headers={'Authorization':'Bearer wrong'}).status_code == 401
    monkeypatch.delenv('AI_FAQ_TOKEN')
    assert http.post(URL, json=body(), headers=HEADERS).status_code == 503
    for token in ['short', 'x'*32+' ', '가'*40]:
        monkeypatch.setenv('AI_FAQ_TOKEN',token)
        assert http.post(URL, json=body(), headers=HEADERS).status_code == 503


def test_default_does_not_ack_without_durable_inbox(monkeypatch):
    monkeypatch.setenv('AI_FAQ_TOKEN',TOKEN)
    with TestClient(create_app(client=FakeClient(), backend=FakeBackend())) as http:
        assert http.post(URL, json=body(), headers=HEADERS).status_code == 503


def test_invalid_and_oversized_json(api):
    http, events = api
    assert http.post(URL, content='{', headers=HEADERS).status_code == 400
    assert http.post(URL, content=b' '*17000, headers=HEADERS).status_code == 413
    assert events.claim_next() is None


def test_duplicate_is_accepted_but_changed_payload_conflicts(api):
    http, events = api
    payload = body(ids=[2,1])
    assert http.post(URL, json=payload, headers=HEADERS).status_code == 202
    payload['faqEntrySeqs'] = [1,2]
    assert http.post(URL, json=payload, headers=HEADERS).status_code == 202
    payload['operation'] = 'DELETE'
    assert http.post(URL, json=payload, headers=HEADERS).status_code == 409
    claimed = events.claim_next()
    assert claimed.operation == 'INSERT'
    events.applied(claimed.event_id)
    assert events.claim_next() is None


def test_storage_failure_never_acknowledges(api, monkeypatch):
    http, events = api
    def fail(_):
        raise sqlite3.OperationalError('test-only database failure')
    monkeypatch.setattr(events,'enqueue',fail)
    assert http.post(URL, json=body(), headers=HEADERS).status_code == 503


def test_queue_capacity_preserves_existing_retry(tmp_path):
    events = store(tmp_path, max_pending=1)
    first = event()
    assert events.enqueue(first)
    assert events.enqueue(first) is False
    with pytest.raises(QueueFull):
        events.enqueue(event())
    assert events.claim_next() == first
    events.applied(first.event_id)
    assert events.enqueue(event())


def test_capacity_returns_503_but_duplicate_still_202(api):
    http, events = api
    events.max_pending = 1
    payload = body()
    assert http.post(URL, json=payload, headers=HEADERS).status_code == 202
    assert http.post(URL, json=body(), headers=HEADERS).status_code == 503
    assert http.post(URL, json=payload, headers=HEADERS).status_code == 202


def test_configured_startup_restores_inbox_after_process_restart(tmp_path, monkeypatch):
    import app.main as main
    from app.config import load_server_config
    cfg = load_server_config()
    configured = cfg.model_copy(update={'faq_sync': cfg.faq_sync.model_copy(update={
        'receive_enabled':True, 'db_path':str(tmp_path/'faq-events.sqlite3')})})
    monkeypatch.setattr(main,'load_server_config',lambda:configured)
    monkeypatch.setenv('AI_FAQ_TOKEN',TOKEN)
    payload = body()
    with TestClient(create_app(client=FakeClient(), backend=FakeBackend())) as http:
        assert http.post(URL, json=payload, headers=HEADERS).status_code == 202
        http.app.state.svc.faq_events.claim_next()
    with TestClient(create_app(client=FakeClient(), backend=FakeBackend())) as http:
        events = http.app.state.svc.faq_events
        assert events.get(payload['eventId'])['status'] == 'RETRY'
        assert http.post(URL, json=payload, headers=HEADERS).status_code == 202
        assert events.claim_next().event_id == payload['eventId']


def test_database_lock_returns_503_instead_of_false_success(api):
    http, events = api
    with events.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        assert http.post(URL, json=body(), headers=HEADERS).status_code == 503
        db.rollback()
    assert events.claim_next() is None


def test_failed_delete_block_rolls_back_event_in_same_transaction(api,monkeypatch):
    http,events=api
    payload=body('DELETE',[123])
    def fail(db,keys,event_id):
        raise sqlite3.OperationalError('차단 저장 실패')
    monkeypatch.setattr(events,'_block',fail)
    assert http.post(URL,json=payload,headers=HEADERS).status_code==503
    assert events.get(payload['eventId']) is None and events.blocked_ids()==frozenset()


def test_delete_202_already_contains_durable_return_block(api,tmp_path):
    http,events=api
    payload=body('DELETE',[123,124])
    assert http.post(URL,json=payload,headers=HEADERS).status_code==202
    assert events.blocked_ids()==frozenset({'backend-faq:123','backend-faq:124'})
    assert store(tmp_path).blocked_ids()==events.blocked_ids()
    assert http.post(URL,json=payload,headers=HEADERS).status_code==202
    assert events.deletion_status()=={'backend-faq:123':'PENDING','backend-faq:124':'PENDING'}


def test_restart_recovery_and_failed_head_cannot_be_overtaken(tmp_path):
    events = store(tmp_path)
    first, second = event(operation='UPDATE'), event(operation='DELETE')
    events.enqueue(first)
    events.enqueue(second)
    assert events.claim_next() == first
    # 처리 중 프로세스가 종료됐다고 가정하고 같은 파일을 다시 연다.
    reopened = store(tmp_path)
    assert reopened.claim_next() is None
    assert reopened.recover_interrupted() == 1
    assert reopened.get(first.event_id)['last_error'] == 'INTERRUPTED'
    assert reopened.claim_next(now=10) == first
    reopened.retry(first.event_id, error_code='APPLY_FAILED', retry_at=20)
    assert reopened.claim_next(now=19) is None
    assert reopened.claim_next(now=20) == first
    reopened.applied(first.event_id)
    assert reopened.claim_next() == second
    assert reopened.get(first.event_id)['attempts'] == 3
    # 이미 적용한 알림도 재시작/재전송에 다시 실행하지 않는다.
    assert reopened.enqueue(first) is False


def test_concurrent_retransmission_creates_one_job(tmp_path):
    events = store(tmp_path)
    first = event()
    with ThreadPoolExecutor(max_workers=4) as pool:
        outcomes = list(pool.map(lambda _:events.enqueue(first),range(12)))
    assert outcomes.count(True) == 1
    assert events.claim_next() == first
    events.applied(first.event_id)
    assert events.claim_next() is None


def test_slow_save_times_out_without_blocking_event_loop(api, monkeypatch):
    http, events = api
    cfg = http.app.state.svc.cfg
    http.app.state.svc.cfg = cfg.model_copy(update={'faq_sync':cfg.faq_sync.model_copy(update={'accept_timeout_sec':.05})})
    original = events.enqueue
    payload = body()
    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    def slow(value):
        started.set()
        try:
            assert release.wait(5)
            return original(value)
        finally:
            finished.set()
    monkeypatch.setattr(events,'enqueue',slow)
    try:
        assert http.post(URL, json=payload, headers=HEADERS).status_code == 503
        assert started.wait(5)
        assert http.get('/health').status_code == 200
    finally:
        release.set()
    assert finished.wait(5)
    http.app.state.svc.cfg = cfg
    monkeypatch.setattr(events,'enqueue',original)
    assert http.post(URL, json=payload, headers=HEADERS).status_code == 202
    assert events.claim_next().event_id == payload['eventId']
