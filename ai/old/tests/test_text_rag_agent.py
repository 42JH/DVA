import asyncio
import json
from types import SimpleNamespace

import pytest

from app.rag.text_agent import SEARCH_TOOL, answer_question


class FakeResponses:
    def __init__(self, outputs):
        self.outputs = iter(outputs)
        self.inputs = []

    async def create(self, **kwargs):
        self.inputs.append({**kwargs, 'input': list(kwargs['input'])})
        return next(self.outputs)


def response(output=(), text='안내 답변'):
    return SimpleNamespace(id='fake', model='fake-model', status='completed', usage=None,
                           output=list(output), output_text=text)


def invoke(outputs, search):
    api = FakeResponses(outputs)
    result = asyncio.run(answer_question(SimpleNamespace(responses=api), '고객 질문', search,
                                         instructions='합성 지침', model='fake-model'))
    return result, api


def call(arguments='{"question":"검색 질문"}', name='search_manual'):
    return SimpleNamespace(type='function_call', name=name, call_id='call_1', arguments=arguments)


def test_real_tool_loop_passes_only_question_and_tool_result_and_keeps_reasoning():
    asked = []
    reasoning = SimpleNamespace(type='reasoning', id='reasoning_1')
    async def search(question):
        asked.append(question)
        return {'tool_output': {'ok': True, 'context_text': '원문 Top3'}, 'evidence': [{'content': '원문'}]}
    result, api = invoke([response([reasoning, call()], ''), response(text='근거 기반 답변')], search)
    assert asked == ['검색 질문']
    assert result['answer'] == '근거 기반 답변'
    assert len(result['tool_calls']) == 1
    history = api.inputs[1]['input']
    assert reasoning in history
    assert json.loads(history[-1]['output']) == {'ok': True, 'context_text': '원문 Top3'}
    assert api.inputs[0]['tool_choice'] == 'auto'
    assert api.inputs[0]['store'] is False
    assert SEARCH_TOOL['parameters']['additionalProperties'] is False


@pytest.mark.parametrize('tool_request', [call('{"question":3}'), call('{"question":" "}'), call(name='cancel_order')])
def test_invalid_tool_cannot_execute_search_or_business_action(tool_request):
    async def search(question):
        raise AssertionError('실행되면 안 됩니다.')
    result, api = invoke([response([tool_request], ''), response()], search)
    assert result['tool_calls'][0]['error_type'] in {'ValidationError', 'ValueError'}
    assert json.loads(api.inputs[1]['input'][-1]['output'])['ok'] is False


def test_search_error_does_not_leak_exception_secrets():
    async def search(question):
        raise RuntimeError('가짜 비밀 문자열')
    result, api = invoke([response([call()], ''), response()], search)
    assert '가짜 비밀 문자열' not in json.dumps(result, ensure_ascii=False)
    assert '가짜 비밀 문자열' not in api.inputs[1]['input'][-1]['output']


def test_no_tool_and_round_limit_are_visible():
    async def search(question):
        return {'tool_output': {'ok': True}}
    result, _ = invoke([response()], search)
    assert result['tool_calls'] == []
    with pytest.raises(RuntimeError, match='왕복 상한'):
        invoke([response([call()], '') for _ in range(3)], search)


def test_generation_error_keeps_completed_search_trace_without_leaking_error_text():
    async def search(question):
        return {'tool_output': {'ok': True}, 'evidence': [{'content': '검색된 원문'}]}
    broken = response()
    broken.status = 'incomplete'
    with pytest.raises(RuntimeError) as captured:
        invoke([response([call()], ''), broken], search)
    assert captured.value.partial['tool_calls'][0]['evidence'] == [{'content': '검색된 원문'}]
