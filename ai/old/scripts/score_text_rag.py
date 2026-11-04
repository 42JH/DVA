"""실제 텍스트 답변 기록을 ID 검색 지표와 공식 Ragas 네 지표로 채점한다."""

import argparse
import asyncio
import hashlib
import json
import math
import os
from contextvars import ContextVar
from importlib.metadata import version
from pathlib import Path
from statistics import fmean
from time import perf_counter

from scripts.run_text_rag import save_report
from scripts.text_eval_metrics import score_search_call


AI_DIR = Path(__file__).resolve().parent.parent
METRICS = ('faithfulness', 'answer_relevancy', 'context_precision', 'context_recall')


def latency_breakdown(row):
    """완료까지 걸린 벽시계 시간을 분해한다. API 서버 내부 추론 시간은 별도 알 수 없다."""
    if 'voice_timings' in row:
        traces = row.get('live_trace', {}).get('traces', [])
        values = {name: row['voice_timings'].get(name) for name in (
            'input_end_to_first_audio_packet_seconds', 'input_end_to_first_transcript_seconds',
            'input_end_to_last_output_seconds', 'input_end_to_observation_end_seconds',
            'input_end_to_post_handoff_audio_seconds')}
        values.update({name: sum(t.get(name) or 0 for t in traces) for name in (
            'backend_seconds', 'search_seconds', 'context_delivery_seconds')})
        for name in ('embedding_seconds', 'dense_search_seconds', 'tokenization_and_bm25_seconds', 'fusion_seconds'):
            values[name] = sum(t.get('search_timings', {}).get(name, 0) for t in traces)
        values['reranking_seconds'] = sum(t.get('reranking_seconds') or 0 for t in traces)
        return values
    responses, calls = row.get('responses', []), row.get('tool_calls', [])
    values = {'initial_llm_seconds': responses[0]['seconds'] if responses else 0.0,
              'followup_llm_seconds': sum(item['seconds'] for item in responses[1:])}
    for name in ('tokenization_and_bm25_seconds', 'embedding_seconds', 'dense_search_seconds', 'fusion_seconds'):
        values[name] = sum(call.get('search_timings', {}).get(name, 0.0) for call in calls)
    values['reranking_seconds'] = sum(call.get('reranking_seconds', 0.0) for call in calls)
    search_components = sum(values[name] for name in ('tokenization_and_bm25_seconds', 'embedding_seconds',
                                                     'dense_search_seconds', 'fusion_seconds', 'reranking_seconds'))
    retrieval = sum(call.get('retrieval_seconds', 0.0) for call in calls)
    tool_seconds = sum(call.get('seconds', 0.0) for call in calls)
    values['retrieval_other_seconds'] = max(0.0, retrieval-search_components)
    values['tool_queue_and_other_seconds'] = max(0.0, tool_seconds-retrieval)
    total = row.get('total_seconds')
    values['request_other_seconds'] = max(0.0, total-sum(values.values())) if total is not None else None
    return values


def prepare_records(generation, cases):
    """생성 완료 뒤에만 정답을 연결하고, 실제 전달 근거에서 문맥을 만든다."""
    by_id = {case['id']: case for case in cases}
    if len(by_id) != len(cases):
        raise ValueError('데이터셋 ID가 중복됩니다.')
    seen, prepared = set(), []
    for row in generation['records']:
        key = row['id']
        if key in seen or key not in by_id or row['question'] != by_id[key]['question']:
            raise ValueError('실행 결과의 문항 ID·질문이 데이터셋과 다릅니다.')
        seen.add(key)
        case = by_id[key]
        gold = case['expected_chunk_ids']
        calls = row.get('tool_calls', [])
        contexts = [f"{doc['title']}\n{doc['content']}" for call in calls for doc in call.get('evidence', [])]
        prepared.append({'id': key, 'question': row['question'], 'generation_status': row['status'],
                         'reference_answer': case['reference_answer'], 'required_facts': case['required_facts'],
                         'reference_evidence': case['reference_evidence'], 'answer': row.get('answer'),
                         'retrieved_contexts': contexts, 'tool_calls': calls,
                         'retrieval_metrics': score_search_call(calls[0] if calls else {}, gold),
                         'per_call_retrieval_metrics': [score_search_call(call, gold) for call in calls],
                         'total_seconds': row.get('total_seconds'), 'latency_breakdown': latency_breakdown(row), 'metrics': {}})
        if 'voice_timings' in row:
            prepared[-1]['voice_timings'] = row['voice_timings']
    return prepared


def summarize(records, requested_count):
    summary = {'requested_count': requested_count, 'recorded_count': len(records),
               'generation_completed': sum(row['generation_status'] == 'completed' for row in records),
               'generation_failed': sum(row['generation_status'] != 'completed' for row in records),
               'missing_generation_count': requested_count - len(records),
               'tool_called_count': sum(bool(row['tool_calls']) for row in records),
               'search_error_count': sum('error_type' in call for row in records for call in row['tool_calls']),
               'metric_summary': {}, 'retrieval_summary': {}}
    for name in METRICS:
        values = [row['metrics'][name]['value'] for row in records
                  if row['metrics'].get(name, {}).get('status') == 'completed']
        summary['metric_summary'][name] = {'valid_count': len(values), 'mean': fmean(values) if values else None,
                                         'unscored_count': requested_count-len(values)}
    for stage in ('bm25', 'dense', 'rrf', 'reranked'):
        rows = [row['retrieval_metrics'][stage] for row in records]
        summary['retrieval_summary'][stage] = {
            ('mrr' if key == 'reciprocal_rank' else key): fmean(row[key] for row in rows) if rows else None
            for key in rows[0] if key != 'expected_rank'
        } if rows else {}
        summary['retrieval_summary'][stage]['evaluated_count'] = len(rows)
    times = sorted(row['total_seconds'] for row in records if row['total_seconds'] is not None)
    summary['generation_seconds'] = {'count': len(times), 'mean': fmean(times) if times else None,
                                     'p95': times[math.ceil(len(times)*.95)-1] if times else None}
    summary['latency_components'] = {}
    for name in records[0]['latency_breakdown'] if records else []:
        values = sorted(row['latency_breakdown'][name] for row in records
                        if row['latency_breakdown'][name] is not None and row['generation_status'] == 'completed')
        summary['latency_components'][name] = {'count': len(values), 'mean': fmean(values) if values else None,
                                              'p95': values[math.ceil(len(values)*.95)-1] if values else None}
    return summary


def review_markdown(report):
    lines = ['# 텍스트 RAG 평가 결과', '', '자동 채점은 보조 판단이며 최종 정답성은 필수 사실과 함께 검토합니다.', '',
             '## 요약', '', '```json', json.dumps(report['summary'], ensure_ascii=False, indent=2), '```', '',
             '## 응답 시간 해석', '',
             '전체 시간은 첫 LLM 호출부터 최종 텍스트 응답 완료까지다. 검색 판단과 최종 답변의 LLM 왕복, 질문 임베딩 API 왕복, 로컬 검색·Qwen, 대기를 포함한다. API 구간은 네트워크·서비스 대기·연산을 합친 값이며 서버 내부 원인을 따로 단정할 수 없다.', '',
             '모델·BM25 준비와 Ragas 채점은 전체 요청 시간에서 제외한다. 이 실행은 비스트리밍이므로 첫 토큰·첫 음성 시간을 측정하지 않았다. 동시 실행에서는 로컬 단일 GPU 검색 대기도 생길 수 있다. 구간별 p95 합은 전체 p95와 같지 않다.', '']
    if any('voice_timings' in row for row in report['records']):
        lines = ['# Live-1 RAG 음성 전사 평가 결과', '',
                 '합성 질문 음성→실제 검색→Live 발화 전사를 채점한다. 맞장구를 포함한 모든 발화가 답변에 포함된다.',
                 '응답 완료 이벤트가 없어 침묵으로 관찰 종료를 추정한다. 첫 패킷 수신은 스피커 재생·정답 안내 시점이 아니다.',
                 'total_seconds는 측정하지 않으며 null이다. 음성 시간은 latency_components를 보고 기존 텍스트 완료 시간과 직접 비교하지 않는다.', '',
                 '```json', json.dumps(report['summary'], ensure_ascii=False, indent=2), '```', '']
    for row in report['records']:
        lines.extend([f"## {row['id']}", '', f"질문: {row['question']}", '',
                      f"실제 답변: {row.get('answer') or '(생성 실패 또는 무응답)'}", '',
                      f"기준 답변: {row['reference_answer']}", '',
                      '필수 사실: '+ ' / '.join(row['required_facts']), '',
                      '검색 근거: '+ ' / '.join(doc['title'] for call in row['tool_calls'] for doc in call.get('evidence', [])), '',
                      '```json', json.dumps({'retrieval': row['retrieval_metrics'], 'ragas': row['metrics'],
                                             'total_seconds': row['total_seconds'], 'latency_breakdown': row['latency_breakdown']}, ensure_ascii=False, indent=2), '```', ''])
    return '\n'.join(lines)


async def run(args):
    # 실제 실행 시에만 평가 라이브러리와 인증 환경을 준비한다.
    os.environ['RAGAS_DO_NOT_TRACK'] = 'true'
    os.environ['HF_HUB_OFFLINE'] = '1'
    from dotenv import load_dotenv
    from openai import AsyncOpenAI
    from ragas.llms import llm_factory
    from ragas.llms.base import InstructorBaseRagasLLM
    from ragas.embeddings.base import embedding_factory
    from ragas.metrics.collections import Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall

    raw = args.generation.read_bytes()
    generation = json.loads(raw)
    dataset_raw = args.dataset.read_bytes()
    cases = json.loads(dataset_raw)
    if generation['contract']['selection'].get('dataset_sha256') != hashlib.sha256(dataset_raw).hexdigest():
        raise ValueError('생성 실행과 채점 데이터셋의 해시가 다릅니다.')
    prepared = prepare_records(generation, cases)
    contract = {'generation_sha256': hashlib.sha256(raw).hexdigest(),
                'dataset_sha256': hashlib.sha256(dataset_raw).hexdigest(), 'judge_model': args.judge_model,
                'relevancy_embedding_model': 'text-embedding-3-small', 'ragas_version': version('ragas')}
    output = args.generation.parent / 'evaluation.json'
    if output.exists():
        report = json.loads(output.read_text(encoding='utf-8'))
        if report['contract'] != contract:
            raise ValueError('기존 채점 실행과 입력/모델이 다릅니다. 별도 실행 폴더를 사용하세요.')
        cached = {row['id']: row['metrics'] for row in report['records']}
        for row in prepared:
            row['metrics'] = cached.get(row['id'], {})
    report = {'status': 'running', 'contract': contract, 'records': prepared, 'grading_concurrency': args.concurrency,
              'note': '첫 검색 호출의 단계별 ID 지표와 전체 실제 전달 문맥의 공식 Ragas 평가. 필수 사실은 수동 정답성 검토용.'}
    requested = generation['contract']['selection']['run_count']
    def checkpoint():
        report['summary'] = summarize(prepared, requested)
        save_report(output, report)
        (output.parent/'review.md').write_text(review_markdown(report), encoding='utf-8')
    checkpoint()
    load_dotenv(AI_DIR / '.env', override=False)
    if not os.getenv('OPENAI_API_KEY'):
        raise ValueError('OpenAI 인증 환경변수가 필요합니다.')
    active_judgments = ContextVar('active_judgments', default=None)
    class ObservedJudge(InstructorBaseRagasLLM):
        """공식 지표 계산은 유지하고 구조화된 주장·판정 결과만 기록한다."""
        def __init__(self, delegate):
            self.delegate = delegate

        def generate(self, prompt, response_model):
            return self.delegate.generate(prompt, response_model)

        async def agenerate(self, prompt, response_model):
            result = await self.delegate.agenerate(prompt, response_model)
            events = active_judgments.get()
            if events is not None:
                events.append({'schema': response_model.__name__, 'output': result.model_dump(mode='json')})
            return result
    async with AsyncOpenAI(timeout=60, max_retries=1) as client:
        llm = ObservedJudge(llm_factory(args.judge_model, client=client, temperature=0, max_tokens=4096, store=False))
        embeddings = embedding_factory('openai', model='text-embedding-3-small', client=client)
        scorers = {'faithfulness': Faithfulness(llm=llm), 'answer_relevancy': AnswerRelevancy(llm=llm, embeddings=embeddings),
                   'context_precision': ContextPrecision(llm=llm), 'context_recall': ContextRecall(llm=llm)}
        semaphore = asyncio.Semaphore(args.concurrency)
        async def one(row):
            async with semaphore:
                for name, scorer in scorers.items():
                    if row['metrics'].get(name, {}).get('status') == 'completed':
                        continue
                    if row['generation_status'] != 'completed' or (name != 'answer_relevancy' and not row['retrieved_contexts']):
                        row['metrics'][name] = {'status': 'not_scored', 'value': None, 'reason': '생성 실패 또는 필요한 실제 문맥 없음'}
                        checkpoint()
                        continue
                    params = {'user_input': row['question']}
                    if name in ('faithfulness', 'answer_relevancy'):
                        params['response'] = row['answer']
                    if name != 'answer_relevancy':
                        params['retrieved_contexts'] = row['retrieved_contexts']
                    if name in ('context_precision', 'context_recall'):
                        params['reference'] = row['reference_answer']
                    started = perf_counter()
                    judgments = []
                    token = active_judgments.set(judgments)
                    try:
                        result = await asyncio.wait_for(scorer.ascore(**params), timeout=180)
                        value = float(result.value)
                        if not math.isfinite(value):
                            raise ValueError('점수가 유한하지 않습니다.')
                        row['metrics'][name] = {'status': 'completed', 'value': value, 'reason': result.reason,
                                                'judgments': judgments, 'seconds': perf_counter()-started}
                    except Exception as error:
                        row['metrics'][name] = {'status': 'failed', 'value': None, 'error_type': type(error).__name__,
                                                'judgments': judgments, 'seconds': perf_counter()-started}
                    finally:
                        active_judgments.reset(token)
                    checkpoint()
                print(f"채점 기록: {row['id']}", flush=True)
        await asyncio.gather(*(one(row) for row in prepared))
    report['status'] = 'completed' if all(row['metrics'][name]['status'] == 'completed' for row in prepared for name in METRICS) else 'partial'
    checkpoint()
    print(f'평가 저장: {output}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generation', type=Path, required=True)
    parser.add_argument('--dataset', type=Path, default=AI_DIR/'evaluation/datasets/faq_v1/cases.json')
    parser.add_argument('--judge-model', default='gpt-4.1')
    parser.add_argument('--concurrency', type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 4:
        parser.error('동시성은 1~4입니다.')
    try:
        asyncio.run(run(args))
    except Exception as error:
        raise SystemExit(f'Ragas 평가 실패: {type(error).__name__}. 외부 예외 원문은 출력하지 않습니다.') from None


if __name__ == '__main__':
    main()
