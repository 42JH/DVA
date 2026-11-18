"""검색 도구를 사용하는 텍스트 실험 루프. 전화 세션과 업무 도구는 실행하지 않는다."""

import json
from time import perf_counter
from typing import Callable, Awaitable

from pydantic import BaseModel, ConfigDict, Field


class ManualQuery(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    question: str = Field(min_length=1, max_length=2000)


SEARCH_TOOL = {
    'type': 'function', 'name': 'search_manual', 'strict': True,
    'description': '택배 FAQ와 정책을 검색해 관련 원문 근거를 최대 세 개 반환합니다. 업무를 실행하지 않습니다.',
    'parameters': ManualQuery.model_json_schema(),
}


class TextAgentError(RuntimeError):
    def __init__(self, message, partial, original=None):
        super().__init__(message)
        self.partial = partial
        self.error_type = type(original).__name__ if original else type(self).__name__
        self.status_code = getattr(original, 'status_code', None)


async def answer_question(client, question: str, search: Callable[[str], Awaitable[dict]], *,
                          instructions: str, model: str, reasoning_effort: str = 'low',
                          max_rounds: int = 3) -> dict:
    if not question.strip() or max_rounds < 1:
        raise ValueError('질문과 호출 상한을 확인하세요.')
    history = [{'role': 'user', 'content': question}]
    calls, responses = [], []
    started = perf_counter()
    def fail(message, original=None):
        return TextAgentError(message, {'tool_calls': calls, 'responses': responses,
                                       'total_seconds': perf_counter()-started}, original)
    for _ in range(max_rounds):
        step = perf_counter()
        try:
            response = await client.responses.create(
                model=model, instructions=instructions, input=history,
                tools=[SEARCH_TOOL], tool_choice='auto', parallel_tool_calls=False,
                reasoning={'effort': reasoning_effort}, text={'verbosity': 'low'},
                max_output_tokens=2048, store=False,
            )
        except Exception as error:
            raise fail('LLM 요청을 완료하지 못했습니다.', error) from None
        responses.append({'response_id': response.id, 'model': response.model,
                          'seconds': perf_counter()-step,
                          'usage': response.usage.model_dump() if response.usage else None})
        if response.status != 'completed':
            raise fail('LLM 응답이 완료되지 않았습니다.')
        # reasoning 항목을 포함한 원래 응답을 다음 호출에 전달한다. 내부 추론을 보고서에 출력하지 않는다.
        history.extend(response.output)
        requested = [item for item in response.output if item.type == 'function_call']
        if not requested:
            if not response.output_text.strip():
                raise fail('최종 답변이 비어 있습니다.')
            return {'answer': response.output_text, 'tool_calls': calls, 'responses': responses,
                    'total_seconds': perf_counter()-started}
        for item in requested:
            step = perf_counter()
            trace = {'name': item.name, 'call_id': item.call_id}
            try:
                if item.name != 'search_manual':
                    raise ValueError('허용되지 않은 도구입니다.')
                args = ManualQuery.model_validate_json(item.arguments)
                if not args.question.strip():
                    raise ValueError('검색 질문이 비어 있습니다.')
                trace['question'] = args.question
                result = await search(args.question)
                output = result['tool_output']
                trace.update({key: value for key, value in result.items() if key != 'tool_output'})
            except Exception as error:
                # 키·외부 예외 원문·스택을 모델과 보고서에 전달하지 않는다.
                trace['error_type'] = type(error).__name__
                output = {'ok': False, 'error': '검색을 완료하지 못했습니다. 정책을 추측하지 마세요.'}
            trace['seconds'] = perf_counter()-step
            calls.append(trace)
            history.append({'type': 'function_call_output', 'call_id': item.call_id,
                            'output': json.dumps(output, ensure_ascii=False, allow_nan=False)})
    raise fail('도구 호출 왕복 상한에 도달했습니다.')
