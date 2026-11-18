import asyncio
import base64
from types import SimpleNamespace

from scripts.run_live_rag_eval import generation_row, settled, one_question, valid_input_audio
from scripts.score_text_rag import prepare_records, summarize
from app.live_lab.bridge import LabSession
from app.live_lab.config import load_lab_config
from app.live_lab.bridge import DirectRagBridge


def test_completion_waits_for_input_jobs_output_and_virtual_playback():
    assert not settled(20, None, 1, 1, [], True, 6)
    assert not settled(20, 1, 1, 1, [object()], True, 6)
    assert not settled(20, 1, 1, 1, [], False, 6)
    assert not settled(20, 1, 16, 16, [], True, 6)
    assert not settled(20, 1, 2, 17, [], True, 6)
    assert settled(25, 1, 2, 17, [], True, 6)


def test_invalid_synthetic_audio_is_not_sent_to_live():
    assert not valid_input_audio(b'\x01\x00'*7200)  # 발견한0.3초 입력
    assert not valid_input_audio(b'\0'*48000)
    assert not valid_input_audio(b'\x01'*48001)
    assert valid_input_audio(b'\x01\x00'*48000)


def test_live_grading_keeps_real_speech_and_actual_delivered_evidence():
    lab = LabSession('x', 'owner', load_lab_config())
    lab.emit('transcript', role='assistant', delta='확인할게요. ')
    lab.emit('transcript', role='assistant', delta='착불은 불가합니다.')
    lab.traces = [{'query': '착불?', 'status': 'delivered_to_live', 'backend_seconds': .5,
                   'evidence': [{'chunk_id': 'a', 'title': '착불', 'content': '불가'}],
                   'search_call': {'rrf_candidates': [{'chunk_id': 'a'}], 'reranked': [{'chunk_id': 'a'}]}},
                  {'status': 'failed', 'evidence': [{'title': '실패한 근거', 'content': '쓰면 안 됨'}]}]
    row = generation_row({'id': 'c', 'question': '착불?'}, lab, 'completed',
                         {'input_end_to_first_audio_packet_seconds': 2})
    assert row['answer'] == '확인할게요. 착불은 불가합니다.'
    assert row['total_seconds'] is None
    assert not row['tool_calls'][1]['evidence']
    case = {'id': 'c', 'question': '착불?', 'expected_chunk_ids': ['a'], 'reference_answer': '불가',
            'required_facts': ['불가'], 'reference_evidence': []}
    prepared = prepare_records({'records': [row]}, [case])
    assert prepared[0]['retrieved_contexts'] == ['착불\n불가']
    assert prepared[0]['retrieval_metrics']['rrf']['hit_at_5'] == 1
    assert summarize(prepared, 1)['latency_components']['input_end_to_first_audio_packet_seconds']['mean'] == 2
    assert summarize(prepared, 1)['generation_seconds']['count'] == 0


def test_primary_audio_harness_runs_one_backend_and_collects_live_speech_only():
    class Primary:
        def __init__(self):
            self.events = asyncio.Queue()
            self.asked = False
            self.session = SimpleNamespace(start=self.start, close=self.close,
                input_audio=SimpleNamespace(append=self.audio),
                thinking=SimpleNamespace(append=self.thinking), commentary=SimpleNamespace(append=self.commentary))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        def __aiter__(self):
            return self

        async def __anext__(self):
            return await self.events.get()

        async def start(self, **kwargs):
            assert kwargs['session']['delegation']['type'] == 'client'
            assert '기준 답변' not in str(kwargs['session'])
            await self.events.put({'type': 'session.started', 'session': {'id': 'fake'}})

        async def audio(self, audio):
            if any(base64.b64decode(audio)) and not self.asked:
                self.asked = True
                await self.events.put({'type': 'session.input_transcript.delta', 'delta': '착불 되나요?',
                                       'start_ms': 500, 'end_ms': 600})
                await self.events.put({'type': 'session.delegation.created', 'delegation': {'target': 'client', 'id': 'd'}})

        async def thinking(self, **kwargs):
            await self.events.put({'type': 'session.thinking.appended', 'client_event_id': kwargs['event_id']})

        async def commentary(self, **kwargs):
            await self.events.put({'type': 'session.output_transcript.delta', 'delta': '착불은 불가합니다.',
                                   'start_ms': 700, 'end_ms': 800})
            await self.events.put({'type': 'session.output_audio.delta', 'delta': base64.b64encode(b'\x01\x00').decode()})

        async def close(self):
            pass

    async def scenario():
        primary = Primary()
        requests = []
        async def backend(**kwargs):
            requests.append(kwargs)
            return SimpleNamespace(status='completed', id='r', usage=None, output=[SimpleNamespace(
                type='function_call', name='search_manual', arguments='{"question":"착불 되나요?"}')])
        async def search(question):
            assert question == '착불 되나요?'
            return {'evidence': [{'chunk_id': 'a', 'source_id': 's', 'title': '착불', 'content': '불가'}],
                    'rrf_candidates': [{'chunk_id': 'a'}], 'reranked': [{'chunk_id': 'a'}]}
        client = SimpleNamespace(live=SimpleNamespace(connect=lambda **kw: primary),
                                 responses=SimpleNamespace(create=backend))
        cfg = load_lab_config()
        bridge = DirectRagBridge(client, search, cfg, '검색만 선택')
        row = await one_question(client, bridge, cfg, {'id': 'c', 'question': '착불 되나요?'},
                                 b'\x01\x00'*1000, quiet=.01, timeout=3)
        assert row['status'] == 'completed'
        assert row['answer'] == '착불은 불가합니다.'
        assert len(requests) == 1
        assert row['tool_calls'][0]['rrf_candidates'] == [{'chunk_id': 'a'}]
        assert row['tool_calls'][0]['evidence'][0]['content'] == '불가'
        assert row['live_trace']['closed'] is True
        assert not row['live_trace'].get('audio')
    asyncio.run(scenario())
