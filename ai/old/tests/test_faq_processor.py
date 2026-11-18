"""영속 FAQ 소비자는 가짜 원문·임베딩·로컬 Qdrant만 사용한다."""

import asyncio
import threading
import time
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import load_server_config
from app.main import create_app
from app.mock_backend import MockBackend
from app.rag.faq_events import FaqChange
from app.rag.faq_processor import FaqProcessor
from conftest import FakeClient
from test_faq_index import prepare, refresh, setup


def change(operation, *ids):
    return FaqChange.model_validate({'eventId': str(uuid4()), 'operation': operation,
                                     'faqEntrySeqs': list(ids)})


def processor(env, backend=None, *, now=None, **settings):
    cfg = load_server_config().faq_sync.model_copy(update={
        'collection': env.state.collection, 'retry_base_sec': 5.,
        'retry_max_sec': 300., 'poll_sec': .01, 'reconcile_sec': .02, **settings})
    rag_cfg = SimpleNamespace(embedding_model=env.state.model, dimensions=env.state.dimensions)
    backend = backend or MockBackend()
    clock = lambda: now['value'] if now is not None else 100.
    return FaqProcessor(env.events, backend, env.index, cfg, rag_cfg, clock=clock), backend


def row(env, event):
    return env.events.get(event.event_id)


def test_insert_update_delete_pipeline(setup):
    env = setup
    worker, backend = processor(env)
    original = prepare()
    backend.faqs = {123: original.source.model_dump(by_alias=True)}
    insert = change('INSERT', 123)
    env.events.enqueue(insert)
    assert asyncio.run(worker.process_one())
    assert row(env, insert)['status'] == 'APPLIED'
    assert len(env.index.current().faqs) == 1
    assert len(env.embeddings.calls) == 1

    edited = prepare(answer='변경된 접수 안내입니다.')
    backend.faqs[123] = edited.source.model_dump(by_alias=True)
    update = change('UPDATE', 123)
    env.events.enqueue(update)
    assert asyncio.run(worker.process_one())
    assert row(env, update)['status'] == 'APPLIED'
    assert env.index.current().faqs[0].source.answer == edited.source.answer
    assert len(env.embeddings.calls) == 2

    delete = change('DELETE', 123)
    env.events.enqueue(delete)
    assert asyncio.run(worker.process_one())
    assert row(env, delete)['status'] == 'APPLIED'
    assert not env.index.current().faqs
    assert env.client.count('faq-managed-test', exact=True).count == 0


def test_fetch_failure_waits_and_preserves_fifo(setup):
    env = setup
    now = {'value': 100.}
    worker, backend = processor(env, now=now)
    first, second = change('INSERT', 123), change('INSERT', 124)
    env.events.enqueue(first)
    env.events.enqueue(second)
    assert asyncio.run(worker.process_one())
    assert row(env, first)['status'] == 'RETRY'
    assert row(env, first)['last_error'] == 'FETCH_FAILED'
    assert row(env, first)['retry_at'] == 105.
    assert not asyncio.run(worker.process_one())
    assert row(env, second)['status'] == 'QUEUED'
    backend.faqs = {123: prepare().source.model_dump(by_alias=True),
                    124: prepare(124).source.model_dump(by_alias=True)}
    now['value'] = 105.
    assert asyncio.run(worker.process_one())
    assert asyncio.run(worker.process_one())
    assert row(env, first)['status'] == row(env, second)['status'] == 'APPLIED'


def test_exponential_retry_is_persistent_and_capped(setup):
    env = setup
    now = {'value': 100.}
    worker, _ = processor(env, now=now)
    event = change('INSERT', 123)
    env.events.enqueue(event)
    for attempt, delay in enumerate((5, 10, 20, 40, 80, 160, 300, 300), start=1):
        assert asyncio.run(worker.process_one())
        state = row(env, event)
        assert state['attempts'] == attempt
        assert state['retry_at'] == now['value'] + delay
        now['value'] = state['retry_at']


def test_prepare_error_never_stages_or_acks(setup):
    env = setup
    worker, backend = processor(env)
    too_large = prepare(answer='가' * 1000)
    # 질문 자체가 청크에 반복되어 길이 상한을 넘는다.
    backend.faqs = {123: {**too_large.source.model_dump(by_alias=True), 'question': '가' * 1000}}
    event = change('INSERT', 123)
    env.events.enqueue(event)
    assert asyncio.run(worker.process_one())
    assert row(env, event)['last_error'] == 'PREPARE_FAILED'
    assert env.embeddings.calls == []
    assert not env.index.current().faqs


def test_index_failure_retries_without_reembedding(setup, monkeypatch):
    env = setup
    now = {'value': 100.}
    worker, backend = processor(env, now=now)
    backend.faqs = {123: prepare().source.model_dump(by_alias=True)}
    event = change('INSERT', 123)
    env.events.enqueue(event)
    actual = env.index.apply
    attempts = 0
    def after_commit(refresh):
        nonlocal attempts
        attempts += 1
        result = actual(refresh)
        if attempts == 1:
            raise RuntimeError('색인 완료 응답 유실')
        return result
    monkeypatch.setattr(env.index, 'apply', after_commit)
    assert asyncio.run(worker.process_one())
    assert row(env, event)['last_error'] == 'INDEX_FAILED'
    assert len(env.embeddings.calls) == 1
    now['value'] = 105.
    assert asyncio.run(worker.process_one())
    assert row(env, event)['status'] == 'APPLIED'
    assert len(env.embeddings.calls) == 1


def test_ack_commit_then_response_loss_stays_applied(setup, monkeypatch):
    env = setup
    worker, backend = processor(env)
    backend.faqs = {123: prepare().source.model_dump(by_alias=True)}
    event = change('INSERT', 123)
    env.events.enqueue(event)
    actual = env.events.applied
    def committed_then_lost(event_id):
        actual(event_id)
        raise RuntimeError('완료 응답 유실')
    monkeypatch.setattr(env.events, 'applied', committed_then_lost)
    assert asyncio.run(worker.process_one())
    assert row(env, event)['status'] == 'APPLIED'
    assert row(env, event)['last_error'] is None


def test_retry_write_failure_does_not_leave_job_stuck(setup, monkeypatch):
    env = setup
    worker, backend = processor(env)
    first, second = change('INSERT', 123), change('INSERT', 124)
    env.events.enqueue(first)
    env.events.enqueue(second)
    actual = env.events.retry
    calls = 0
    def once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError('SQLite busy')
        return actual(*args, **kwargs)
    monkeypatch.setattr(env.events, 'retry', once)
    with pytest.raises(OSError):
        asyncio.run(worker.process_one())
    assert row(env, first)['status'] == 'PROCESSING'
    assert not asyncio.run(worker.process_one())
    assert row(env, first)['status'] == 'RETRY'
    assert row(env, second)['status'] == 'QUEUED'


def test_cancellation_drains_inflight_embedding_before_retry(setup, monkeypatch):
    env = setup
    worker, backend = processor(env)
    backend.faqs = {123: prepare().source.model_dump(by_alias=True)}
    event = change('INSERT', 123)
    env.events.enqueue(event)
    started, release = threading.Event(), threading.Event()
    actual = env.embeddings.embed_documents
    def blocking(texts):
        started.set()
        assert release.wait(5)
        return actual(texts)
    monkeypatch.setattr(env.embeddings, 'embed_documents', blocking)
    async def scenario():
        task = asyncio.create_task(worker.process_one())
        try:
            assert await asyncio.to_thread(started.wait, 5)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
            assert row(env, event)['status'] == 'PROCESSING'
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(scenario())
    assert row(env, event)['status'] == 'RETRY'
    assert row(env, event)['last_error'] == 'INTERRUPTED'
    assert len(env.embeddings.calls) == 1
    assert asyncio.run(worker.process_one())
    assert row(env, event)['status'] == 'APPLIED'
    assert len(env.embeddings.calls) == 1


def test_same_source_keeps_search_description_but_changed_source_drops_it(setup):
    env = setup
    described = prepare(description='택배 접수 방법 설명')
    env.index.apply(refresh(described))
    worker, backend = processor(env)
    backend.faqs = {123: described.source.model_dump(by_alias=True)}
    first = change('UPDATE', 123)
    env.events.enqueue(first)
    assert asyncio.run(worker.process_one())
    assert env.index.current().faqs[0].chunks[0].embedding_text == described.chunks[0].embedding_text
    assert len(env.embeddings.calls) == 1
    edited = prepare(answer='새로운 원문')
    backend.faqs[123] = edited.source.model_dump(by_alias=True)
    second = change('UPDATE', 123)
    env.events.enqueue(second)
    assert asyncio.run(worker.process_one())
    chunk = env.index.current().faqs[0].chunks[0]
    assert chunk.embedding_text == chunk.content


def test_invalid_bindings_and_config_rejected(setup):
    env = setup
    cfg = load_server_config().faq_sync.model_copy(update={'collection': env.state.collection})
    rag = SimpleNamespace(embedding_model=env.state.model, dimensions=env.state.dimensions)
    with pytest.raises(ValueError):
        FaqProcessor(env.events, MockBackend(), env.index, cfg.model_copy(update={'collection':'other'}), rag)
    with pytest.raises(ValueError):
        FaqProcessor(env.events, MockBackend(), env.index, cfg, SimpleNamespace(embedding_model='other', dimensions=4))
    with pytest.raises(ValidationError):
        type(cfg).model_validate({**cfg.model_dump(), 'process_enabled': True, 'receive_enabled': False})
    with pytest.raises(ValidationError):
        type(cfg).model_validate({**cfg.model_dump(), 'retry_base_sec': 10, 'retry_max_sec': 5})


def test_run_recovers_interrupted_head_and_wake(setup):
    env = setup
    backend = MockBackend()
    backend.faqs = {123: prepare().source.model_dump(by_alias=True)}
    worker, _ = processor(env, backend, poll_sec=60.)
    event = change('INSERT', 123)
    env.events.enqueue(event)
    assert env.events.claim_next(now=100.) == event
    async def scenario():
        task = asyncio.create_task(worker.run())
        try:
            deadline = asyncio.get_running_loop().time() + 5
            while row(env, event)['status'] != 'APPLIED':
                assert asyncio.get_running_loop().time() < deadline
                worker.wake()
                await asyncio.sleep(.01)
            assert row(env, event)['attempts'] == 2
            with pytest.raises(RuntimeError):
                await worker.run()
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
    asyncio.run(scenario())
    assert not worker.running


def test_reconciliation_resweeps_late_points_without_new_generation(setup):
    env = setup
    document = prepare()
    env.index.apply(refresh(document))
    event = change('DELETE', 123)
    worker, _ = processor(env)
    env.events.enqueue(event)
    assert asyncio.run(worker.process_one())
    generation = env.index.current().generation
    vector = env.embeddings.vector(document.chunks[0].embedding_text)
    env.vectors.stage([(document.chunks[0], vector)])
    assert env.client.count('faq-managed-test', exact=True).count == 1
    asyncio.run(worker.reconcile_once())
    assert env.client.count('faq-managed-test', exact=True).count == 0
    assert env.index.current().generation == generation


def test_periodic_reconciliation_runs_even_with_long_queue_poll(setup):
    env = setup
    document = prepare()
    env.index.apply(refresh(document))
    env.index.apply(refresh(delete_ids=(123,)))
    env.vectors.stage([(document.chunks[0], env.embeddings.vector(document.chunks[0].embedding_text))])
    worker, _ = processor(env, poll_sec=60., reconcile_sec=.02)
    async def scenario():
        task = asyncio.create_task(worker.run())
        try:
            deadline = asyncio.get_running_loop().time()+5
            while env.client.count('faq-managed-test', exact=True).count:
                assert asyncio.get_running_loop().time() < deadline
                await asyncio.sleep(.01)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
    asyncio.run(scenario())


def test_app_worker_accepts_then_processes_without_blocking_http(setup, monkeypatch):
    import app.main as main

    env = setup
    backend = MockBackend()
    backend.faqs = {123: prepare().source.model_dump(by_alias=True)}
    config = load_server_config()
    faq_cfg = config.faq_sync.model_copy(update={
        'receive_enabled': True, 'process_enabled': True,
        'collection': env.state.collection, 'poll_sec': .01})
    rag_cfg = config.rag.model_copy(update={'embedding_model': env.state.model,
                                             'dimensions': env.state.dimensions})
    monkeypatch.setattr(main, 'load_server_config', lambda: config.model_copy(update={
        'faq_sync': faq_cfg, 'rag': rag_cfg}))
    token = 'faq-test-token-' + 'x'*32
    monkeypatch.setenv('AI_FAQ_TOKEN', token)
    started, release = threading.Event(), threading.Event()
    original = env.embeddings.embed_documents
    def slow(texts):
        started.set()
        assert release.wait(5)
        return original(texts)
    monkeypatch.setattr(env.embeddings, 'embed_documents', slow)
    payload = {'eventId': str(uuid4()), 'operation': 'INSERT', 'faqEntrySeqs': [123]}
    with TestClient(create_app(client=FakeClient(), backend=backend,
                               faq_events=env.events, faq_index=env.index)) as http:
        assert http.post('/internal/faqs/refresh', json=payload,
                         headers={'Authorization':'Bearer '+token}).status_code == 202
        try:
            assert started.wait(5)
            assert row(env, FaqChange.model_validate(payload))['status'] == 'PROCESSING'
            assert http.get('/health').status_code == 200
        finally:
            release.set()
        deadline = time.monotonic()+5
        while row(env, FaqChange.model_validate(payload))['status'] != 'APPLIED':
            assert time.monotonic() < deadline
            time.sleep(.01)
        assert http.app.state.svc.faq_processor.running
    assert not http.app.state.svc.faq_processor.running


def test_app_fails_closed_without_managed_index(monkeypatch):
    import app.main as main
    import app.rag.faq_runtime as runtime
    config = load_server_config()
    faq_cfg = config.faq_sync.model_copy(update={'receive_enabled':True,'process_enabled':True})
    monkeypatch.setattr(main, 'load_server_config', lambda:config.model_copy(update={'faq_sync':faq_cfg}))
    monkeypatch.setenv('AI_FAQ_TOKEN', 'faq-test-token-'+'x'*32)
    def unavailable(*args):
        raise RuntimeError('GPU 검증기 준비 실패')
    monkeypatch.setattr(runtime, 'create_faq_runtime', unavailable)
    with pytest.raises(RuntimeError, match='GPU 검증기 준비 실패'):
        with TestClient(create_app(client=FakeClient(), backend=MockBackend())):
            pass


def test_app_factory_connects_managed_search_and_worker(setup, monkeypatch):
    import app.main as main
    import app.rag.faq_runtime as runtime_module

    env = setup
    config = load_server_config()
    faq_cfg = config.faq_sync.model_copy(update={
        'receive_enabled':True, 'process_enabled':True, 'collection':env.state.collection})
    rag_cfg = config.rag.model_copy(update={'embedding_model':env.state.model,
                                             'dimensions':env.state.dimensions})
    monkeypatch.setattr(main, 'load_server_config', lambda:config.model_copy(update={
        'faq_sync':faq_cfg, 'rag':rag_cfg}))
    monkeypatch.setenv('AI_FAQ_TOKEN', 'faq-test-token-'+'x'*32)
    closed = []
    class Reranker:
        def rerank(self, question, documents):
            return [{**row, 'reranker_score':1.} for row in documents]
    fake = SimpleNamespace(index=env.index, reranker=Reranker(), close=lambda:closed.append(True))
    monkeypatch.setattr(runtime_module, 'create_faq_runtime', lambda *args:fake)
    with TestClient(create_app(client=FakeClient(), backend=MockBackend(), faq_events=env.events)) as http:
        svc = http.app.state.svc
        assert svc.faq_processor.index is env.index
        assert svc.rag.faq_index is env.index
    assert closed == [True]
