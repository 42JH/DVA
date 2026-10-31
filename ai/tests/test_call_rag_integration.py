"""실제 API 대신 가짜 백엔드·검색·Live로 전화 통합 경계를 검증한다."""
import asyncio
import json
from types import SimpleNamespace as NS

import pytest

from app import client_backend
from app.dispatcher import dispatch
from app.live_session import build_backend, load_live_toml
from app.rag.schemas import Evidence
from app.rag.context import build_search_context
from app.sideband import handle_event
from conftest import make_call, run


BODY = '| 상태 | 취소 |\n| --- | --- |\n| 발송완료 | 불가 |\n{context}는 원문입니다.'


class FakeSearch:
    def __init__(self):
        self.questions = []

    async def __call__(self, question):
        self.questions.append(question)
        context = build_search_context(question, [Evidence(chunk_id=str(i), source_id='delivery_faq',
            title=f'FAQ {i}', content=BODY+str(i)) for i in range(3)])
        return {'context': context.llm_payload(), 'timings': {'embedding_seconds': .1}}


class Connection:
    def __init__(self, call, ack=True):
        self.call, self.ack = call, ack
        self.sent, self.spoken = [], []
        self.session = NS(thinking=NS(append=self.append), commentary=NS(append=self.speak))
        # response.item/create를 제공하지 않는다. 직접 전달 경로가 이를 사용하면 실패한다.

    async def append(self, **value):
        self.sent.append(value)
        if self.ack:
            client_backend.acknowledge(self.call, {'client_event_id': value['event_id']})

    async def speak(self, **value):
        self.spoken.append(value)


def setup():
    call = make_call()
    call.rag = FakeSearch()
    call.delegation_mode = 'client'
    call.backend_settings = build_backend(load_live_toml())
    call.add_transcript('customer', '발송완료인데 취소가 되나요?')
    call.input_ready.set()
    return call


def client_for(name='search_manual', args=None, *, status='completed'):
    requests = []
    async def create(**kwargs):
        requests.append(kwargs)
        return NS(status=status, output=[NS(type='function_call', name=name, call_id='fn1',
            arguments=json.dumps(args or {'question': '발송완료 취소 가능 여부'}, ensure_ascii=False))])
    return NS(responses=NS(create=create)), requests


def test_actual_tool_preserves_top3_raw_tables_and_order_state():
    call = setup()
    before = call.order.model_dump(), call.flow.stage
    output = run(dispatch(call, 'search_manual', '{"question":"발송완료 취소"}', 'search1'))
    assert output['ok']
    assert len(output['context']['evidence']) == 3
    assert output['context']['evidence'][0]['content'] == BODY+'0'
    # 주문 값은 그대로, 검색 결과(RAG Yes)는 QnA로 들어가 답한 뒤 들어오기 전 단계로 돌아갈 수 있게 기억한다
    assert call.order.model_dump() == before[0] and call.flow.stage == 'D_AFTER_ANSWER'
    assert call.flow.resume == {'task': 'new_order', 'stage': before[1]}
    assert not call.refer_requested.is_set() and not call.hangup_requested.is_set()


def test_backend_once_dispatch_then_raw_top3_to_live_no_second_model():
    call = setup()
    client, requests = client_for()
    conn = Connection(call)
    async def scenario():
        tasks = set()
        client_backend.start_delegation(call, conn, {'id': 'd1', 'target': 'client'}, tasks, client)
        await asyncio.gather(*tasks)
        # 중복 이벤트는 다시 임베딩/도구 실행하지 않는다.
        client_backend.start_delegation(call, conn, {'id': 'd1', 'target': 'client'}, tasks, client)
    run(scenario())
    assert len(requests) == 1 and len(call.rag.questions) == 1
    assert requests[0]['store'] is False
    assert call.delegations['d1']['status'] == 'delivered_to_live'
    assert not call.pending_context
    assert len(conn.spoken) == 1
    parts = [row['content'].split('\n', 1)[1] for row in conn.sent if row['content']]
    material = json.loads(''.join(parts))
    assert [doc['content'] for doc in material['context']['evidence']] == [BODY+str(i) for i in range(3)]
    assert all(row['delegation_id'] == 'd1' for row in conn.sent)
    assert 'reference_answer' not in str(requests)


@pytest.mark.parametrize('name,args', [('launch_rocket', {}), ('modify_order', {'customer_confirmed': False}),
                                      ('search_manual', {'question': 'a', 'extra': True})])
def test_invalid_tool_is_not_executed(name, args):
    call = setup()
    client, _ = client_for(name, args)
    conn = Connection(call)
    async def scenario():
        jobs = set()
        client_backend.start_delegation(call, conn, {'id': 'd1', 'target': 'client'}, jobs, client)
        await asyncio.gather(*jobs)
    run(scenario())
    assert not call.rag.questions
    assert not call.backend.orders


def test_new_delegation_cancels_old_search_and_suppresses_late_context():
    call = setup()
    client, _ = client_for()
    conn = Connection(call)
    async def scenario():
        started = asyncio.Event()
        search = call.rag
        async def slow(question):
            started.set()
            await asyncio.sleep(1)
            return await search(question)
        call.rag = slow
        jobs = set()
        client_backend.start_delegation(call, conn, {'id': 'old', 'target': 'client'}, jobs, client)
        await started.wait()
        call.rag = search
        client_backend.start_delegation(call, conn, {'id': 'new', 'target': 'client'}, jobs, client)
        await asyncio.gather(*jobs, return_exceptions=True)
    run(scenario())
    assert call.delegations['old']['status'] == 'cancelled'
    assert call.delegations['new']['status'] == 'delivered_to_live'
    assert not [row for row in conn.sent if row['delegation_id'] == 'old' and row['content']]


def test_ack_timeout_never_claims_delivery_complete():
    call = setup()
    call.cfg = call.cfg.model_copy(update={'client_backend': call.cfg.client_backend.model_copy(update={'append_timeout_sec': .01})})
    conn = Connection(call, ack=False)
    client, _ = client_for()
    async def scenario():
        jobs = set()
        client_backend.start_delegation(call, conn, {'id': 'd1', 'target': 'client'}, jobs, client)
        await asyncio.gather(*jobs)
    run(scenario())
    assert call.delegations['d1']['status'] == 'failed'
    assert not call.pending_context
    assert '완료하지 못했습니다' in conn.spoken[-1]['content']


def test_missing_rag_is_failure_without_order_or_transfer_change():
    call = setup()
    call.rag = None
    output = run(dispatch(call, 'search_manual', '{"question":"배송은?"}', 'x'))
    assert output['ok'] is False and call.flow.stage == 'D_AGENT_OFFER'  # 검색 실패 = RAG No(상담원 제안은 3번째부터)
    assert not call.refer_requested.is_set() and not call.agent_offered


def test_sideband_client_ignores_responses_function_event():
    call = setup()
    event = NS(type='response.event', event={'type': 'response.output_item.done',
        'item': {'type': 'function_call', 'name': 'search_manual', 'call_id': 'x', 'arguments': '{}'}})
    assert handle_event(call, Connection(call), event, set()) is None
    assert not call.tool_calls


def test_separate_calls_do_not_share_acknowledgments_or_results():
    first, second = setup(), setup()
    async def scenario():
        jobs = set()
        for call in (first, second):
            client, _ = client_for()
            client_backend.start_delegation(call, Connection(call), {'id': 'same', 'target': 'client'}, jobs, client)
        await asyncio.gather(*jobs)
    run(scenario())
    assert first.delegations is not second.delegations
    assert len(first.rag.questions) == len(second.rag.questions) == 1
    assert not first.pending_context and not second.pending_context


def test_incoming_call_attaches_service_and_sends_only_live_session(monkeypatch):
    from app.call import Registry
    from app.services import Services
    from app.webhooks import openai as webhook
    from conftest import CFG, TEXTS, FakeBackend, FakeClient
    client, backend, search = FakeClient(), FakeBackend(), FakeSearch()
    svc = Services(CFG, TEXTS, client, backend, Registry(CFG), rag=search)
    captured = []
    async def sideband(call, actual_client):
        captured.append(call)
    monkeypatch.setattr(webhook, 'run_call', sideband)
    async def scenario():
        await webhook.handle_incoming(svc, NS(session_id='incoming', sip_headers=[]))
        await svc.registry.get('incoming').task
    run(scenario())
    assert captured[0].rag is search and captured[0].delegation_mode == 'responses'
    accepted = client.live.sessions.of('accept')[0][2]
    assert accepted['delegation']['type'] == 'responses' and 'backend' not in accepted
    assert 'search_manual' in {t['name'] for t in accepted['delegation']['responses']['tools']}
    assert 'search_manual' in {t['name'] for t in captured[0].backend_settings['tools']}


def test_new_delegation_does_not_cancel_already_started_mutation(monkeypatch):
    from app.address import kakao
    call = setup()
    conn = Connection(call)

    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()
        writes = []

        async def slow(address_, timeout_sec, transport=None):  # 기록 중 주소 좌표 찾기가 오래 걸린다
            started.set()
            await release.wait()
            writes.append(address_)
            return None
        monkeypatch.setattr(kakao, 'geocode', slow)
        client, _ = client_for('record_order', {'sender_address': '서울 강남구 테헤란로 212'})
        tasks = set()
        client_backend.start_delegation(call, conn, {'id': 'write', 'target': 'client'}, tasks, client)
        await started.wait()
        read_client, _ = client_for('get_state', {})
        client_backend.start_delegation(call, conn, {'id': 'new', 'target': 'client'}, tasks, read_client)
        release.set()
        await asyncio.gather(*tasks)
        assert len(writes) == 1
    run(scenario())
    assert call.order.sender_address == '서울 강남구 테헤란로 212'
    assert call.delegations['write']['status'] == 'stale'
    assert not [row for row in conn.sent if row['delegation_id'] == 'write' and row['content']]


def test_client_backend_records_cannot_include_rag_in_next_model_request():
    call = setup()
    client, requests = client_for()
    conn = Connection(call)
    async def scenario():
        for key in ('first', 'second'):
            tasks = set()
            client_backend.start_delegation(call, conn, {'id': key, 'target': 'client'}, tasks, client)
            await asyncio.gather(*tasks)
    run(scenario())
    assert len(requests) == 2
    assert BODY not in str(requests[1]['input'])


def test_output_timing_excludes_pre_handoff_and_older_context_audio():
    import time
    call = setup()
    call.latest_delegation = 'd1'
    record = {'status': 'running', 'last_input_received_at': call.last_input_at}
    call.delegations['d1'] = record
    client_backend.observe_output(call, 'audio', 10)
    assert 'first_audio_after_handoff_seconds' not in record
    record.update(status='delivered_to_live', handoff_at=time.monotonic(), last_context_timeline_end_ms=100)
    client_backend.observe_output(call, 'audio', 50)
    assert 'first_audio_after_handoff_seconds' not in record
    client_backend.observe_output(call, 'audio', 120)
    assert record['first_audio_after_handoff_seconds'] >= 0
    assert record['last_input_received_to_audio_seconds'] >= record['first_audio_after_handoff_seconds']
