"""저장된 Live 발화를 FactualCorrectness로 추가 채점하고 기존 지표를 보존한다."""

import argparse
import asyncio
import copy
import hashlib
import json
import math
import os
from contextvars import ContextVar
from importlib.metadata import version
from pathlib import Path
from statistics import fmean, median
from time import perf_counter

from scripts.run_text_rag import AI_DIR, save_report


def prepare(source, cases):
    """기존 기록은 복사해 쓰며 질문/기준 답변 불일치를 채점 전에 차단한다."""
    expected = {c['id']: c for c in cases}
    records = copy.deepcopy(source['records'])
    if len(expected) != len(cases) or len({r['id'] for r in records}) != len(records):
        raise ValueError('문항 ID가 중복됩니다.')
    if set(expected) != {r['id'] for r in records}:
        raise ValueError('기존 실행과 데이터셋 문항 목록이 다릅니다.')
    for row in records:
        case = expected[row['id']]
        if row['question'] != case['question'] or row['reference_answer'] != case['reference_answer']:
            raise ValueError('질문 또는 기준 답변이 기존 기록과 다릅니다.')
        if row['generation_status'] != 'completed' or not row.get('answer', '').strip():
            raise ValueError('완료된 실제 답변이 필요합니다.')
    return records


def diagnostics(events):
    """기준 답변 미지원은 거짓 판정과 구분하고 공식 판정의 방향을 보존한다."""
    output = {}
    for stage in ('response_against_reference', 'reference_against_response'):
        event = next((e for e in events if e['stage'] == stage), None)
        statements = event['output']['statements'] if event else []
        output[stage] = {'statement_count': len(statements),
                         'supported_count': sum(bool(s['verdict']) for s in statements),
                         'unsupported_count': sum(not s['verdict'] for s in statements)}
    return output


def summarize(records):
    metrics = [r.get('metrics', {}).get('factual_correctness', {}) for r in records]
    values = [m['value'] for m in metrics if m.get('status') == 'completed']
    return {'requested_count': len(records), 'valid_count': len(values),
            'failed_count': sum(m.get('status') == 'failed' for m in metrics),
            'pending_count': sum(m.get('status') not in ('completed','failed') for m in metrics),
            'mean': fmean(values) if values else None, 'median': median(values) if values else None,
            'min': min(values) if values else None, 'max': max(values) if values else None,
            'score_distribution': {label: sum(test(v) for v in values) for label,test in (
                ('zero', lambda v:v == 0), ('above_zero_below_0_5', lambda v:0 < v < .5),
                ('from_0_5_below_0_8', lambda v:.5 <= v < .8), ('from_0_8_below_1', lambda v:.8 <= v < 1),
                ('one', lambda v:v == 1))},
            'note': '점수 구간은 검토 편의용이며 합격선이나 정답률이 아님'}


def review_markdown(report):
    lines = ['# Live 발화 Factual Correctness 추가 평가', '',
             '기존 Live 실제 발화와 기준 답변을 Ragas 공식 F1 방식으로 비교했다. 검색과 발화를 다시 생성하지 않았다.',
             '원래 네 지표·검색·시간은 그대로 복사했다. 원본 evaluation.json은 변경하지 않는다.',
             '기준 답변에 없는 설명이 검색 근거에는 있을 수 있으므로 낮은 점수를 곧 환각/오답으로 확정하지 않는다.', '',
             '```json', json.dumps(report['factual_summary'], ensure_ascii=False, indent=2), '```', '',
             '## 문항별 판정', '']
    ordered = sorted(report['records'], key=lambda r:(r['metrics'].get('factual_correctness',{}).get('value',2),r['id']))
    for row in ordered:
        lines.extend([f"### {row['id']}", '', '고객 질문: '+row['question'], '', '실제 발화: '+row['answer'], '',
                      '기준 답변: '+row['reference_answer'], '', '필수 사실: '+' / '.join(row['required_facts']), '',
                      '```json', json.dumps(row['metrics'].get('factual_correctness',{}), ensure_ascii=False, indent=2),
                      '```', '', '전달된 근거:', ''])
        for context in row['retrieved_contexts']:
            lines.extend([context, ''])
    return '\n'.join(lines)


def summary_markdown(report):
    s = report['factual_summary']
    lines = ['# 기존 Live 답변의 사실 정확성 추가 평가', '',
             '실제 Live 발화와 기존 기준 답변95쌍을 비교한다. 과거 결과는 보존하고 새 지표만 추가했다.', '',
             '| 지표 | 평균 | 유효 표본 |', '| --- | --- | --- |']
    names = [('factual_correctness','Factual Correctness F1'),('faithfulness','Faithfulness'),
             ('context_precision','Context Precision'),('context_recall','Context Recall'),
             ('answer_relevancy','기존 Answer Relevancy(참고)')]
    for key,label in names:
        metric = report['summary']['metric_summary'][key]
        value = f"{metric['mean']:.5f}" if metric['mean'] is not None else '-'
        lines.append(f"| {label} | {value} | {metric['valid_count']} |")
    lines.extend(['', '## 사실 정확성 분포', '', '```json', json.dumps(s,ensure_ascii=False,indent=2),'```', '',
                  '## 해석', '',
                  '- 새 지표는 기준 답변과 실제 발화의 사실 일치를 Ragas F1 방식으로 계산한다. 정답 문항 비율이 아니다.',
                  '- 기준 답변에 없는 내용이 검색 근거에는 있을 수 있다. 기준 답변 미지원과 환각을 구분한다.',
                  '- 맞장구/표현을 삭제하거나 기준 답변에 검색 문서를 추가하지 않았다.',
                  '- 기본 설정 atomicity=low, coverage=low, beta=1.0, judge=gpt-4.1, Ragas0.4.3이다.',
                  '- 기존 검색 지표와 시간은 그대로이며 추가 채점 시간은 서비스 응답 지연에 포함하지 않는다.',
                  '- 과거 Relevancy는 참고 기록으로 보존한다. 다른 지표들과 한 개의 합격 점수로 평균내지 않는다.', '',
                  '## 우선 검토할 문항', '', '| 문항 | F1 | 질문 |', '| --- | --- | --- |'])
    low = sorted([r for r in report['records'] if r['metrics'].get('factual_correctness',{}).get('status')=='completed'],
                 key=lambda r:r['metrics']['factual_correctness']['value'])[:15]
    for row in low:
        lines.append(f"| {row['id']} | {row['metrics']['factual_correctness']['value']} | {row['question']} |")
    lines.extend(['', '세부 사실 분해·지원/누락 판정과 실제 근거는 factual_review.md를 확인한다.',
                  '공식 정의: https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/factual_correctness/', ''])
    return '\n'.join(lines)


async def run(args):
    os.environ['RAGAS_DO_NOT_TRACK'] = 'true'
    os.environ['HF_HUB_OFFLINE'] = '1'
    from dotenv import load_dotenv
    from openai import AsyncOpenAI
    from ragas.llms import llm_factory
    from ragas.llms.base import InstructorBaseRagasLLM
    from ragas.metrics.collections import FactualCorrectness

    raw, dataset_raw = args.evaluation.read_bytes(), args.dataset.read_bytes()
    source, cases = json.loads(raw), json.loads(dataset_raw)
    if source['contract']['dataset_sha256'] != hashlib.sha256(dataset_raw).hexdigest():
        raise ValueError('기존 평가와 데이터셋 해시가 다릅니다.')
    records = prepare(source, cases)
    contract = {'source_evaluation_sha256':hashlib.sha256(raw).hexdigest(),
                'dataset_sha256':hashlib.sha256(dataset_raw).hexdigest(),
                'judge_model':'gpt-4.1', 'ragas_version':version('ragas'), 'mode':'f1',
                'beta':1.0, 'atomicity':'low', 'coverage':'low',
                'scoring_input':'실제 발화 원문과 기존 기준 답변; 맞장구 제거/문서 추가 없음'}
    output = args.evaluation.parent/'evaluation_with_factual.json'
    if output.exists():
        previous = json.loads(output.read_bytes())
        if previous['factual_contract'] != contract:
            raise ValueError('기존 추가 평가와 입력/모델/설정이 다릅니다.')
        cached = {r['id']:r['metrics'].get('factual_correctness') for r in previous['records']}
        for row in records:
            if cached.get(row['id']):
                row['metrics']['factual_correctness'] = cached[row['id']]
    report = {**copy.deepcopy(source), 'status':'running', 'records':records,
              'factual_contract':contract, 'factual_grading_concurrency':args.concurrency}
    def checkpoint():
        report['factual_summary'] = summarize(records)
        s = report['factual_summary']
        report['summary']['metric_summary']['factual_correctness'] = {
            'valid_count':s['valid_count'], 'mean':s['mean'], 'unscored_count':len(records)-s['valid_count']}
        save_report(output, report)
        (output.parent/'factual_review.md').write_text(review_markdown(report),encoding='utf-8')
        (output.parent/'factual_summary.md').write_text(summary_markdown(report),encoding='utf-8')
    checkpoint()
    pending = [r for r in records if r['metrics'].get('factual_correctness',{}).get('status') != 'completed']
    if not pending:
        report['status'] = 'completed'
        checkpoint()
        print('추가 평가가 모두 완료됐습니다. 새 API 호출 없음.')
        return
    load_dotenv(AI_DIR/'.env',override=False)
    if not os.getenv('OPENAI_API_KEY'):
        raise ValueError('OpenAI 인증 환경변수가 필요합니다.')
    active = ContextVar('factual_judgments',default=None)
    class ObservedJudge(InstructorBaseRagasLLM):
        def __init__(self,delegate):
            self.delegate = delegate
        def generate(self,prompt,response_model):
            return self.delegate.generate(prompt,response_model)
        async def agenerate(self,prompt,response_model):
            result = await self.delegate.agenerate(prompt,response_model)
            events = active.get()
            decompositions = sum(e['schema']=='ClaimDecompositionOutput' for e in events)
            if response_model.__name__ == 'ClaimDecompositionOutput':
                stage = 'response_decomposition' if decompositions==0 else 'reference_decomposition'
            else:
                stage = 'response_against_reference' if decompositions==1 else 'reference_against_response'
            events.append({'schema':response_model.__name__, 'stage':stage, 'output':result.model_dump(mode='json')})
            return result
    async with AsyncOpenAI(timeout=60,max_retries=1) as client:
        metric = FactualCorrectness(llm=ObservedJudge(llm_factory('gpt-4.1',client=client,temperature=0,
                                                                max_tokens=4096,store=False)),
                                   mode='f1',beta=1.0,atomicity='low',coverage='low')
        semaphore = asyncio.Semaphore(args.concurrency)
        async def one(row):
            async with semaphore:
                events = []
                token = active.set(events)
                started = perf_counter()
                try:
                    result = await asyncio.wait_for(metric.ascore(response=row['answer'],reference=row['reference_answer']),180)
                    value = float(result.value)
                    if not math.isfinite(value):
                        raise ValueError('점수가 유한하지 않습니다.')
                    row['metrics']['factual_correctness'] = {
                        'status':'completed','value':value,'reason':result.reason,
                        'diagnostics':diagnostics(events),'judgments':events,'seconds':perf_counter()-started}
                except Exception as error:
                    row['metrics']['factual_correctness'] = {'status':'failed','error_type':type(error).__name__,
                                                              'judgments':events}
                finally:
                    active.reset(token)
                checkpoint()
                print(f"{row['id']} | {row['metrics']['factual_correctness']['status']} | {report['factual_summary']['valid_count']}/{len(records)}",flush=True)
                return row['metrics']['factual_correctness']['status']
        first = await one(pending[0])
        if first == 'completed':
            await asyncio.gather(*(one(r) for r in pending[1:]))
        report['status'] = 'completed' if all(r['metrics'].get('factual_correctness',{}).get('status')=='completed' for r in records) else 'partial'
        checkpoint()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evaluation',type=Path,default=AI_DIR/'data/private/evaluation/runs/live_rag_full_v1/evaluation.json')
    parser.add_argument('--dataset',type=Path,default=AI_DIR/'evaluation/datasets/faq_v1/cases.json')
    parser.add_argument('--concurrency',type=int,default=4)
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 4:
        parser.error('동시성은1~4입니다.')
    try:
        asyncio.run(run(args))
    except Exception as error:
        raise SystemExit(f'사실 정확성 평가 실패: {type(error).__name__}. 외부 예외 원문은 표시하지 않습니다.') from None


if __name__=='__main__':
    main()
