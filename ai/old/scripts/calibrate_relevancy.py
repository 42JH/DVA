"""검토된 기준 답변과 다른 FAQ의 답변으로 Relevancy 지표를 점검한다."""

import argparse
import asyncio
import hashlib
import json
import math
import os
import re
from contextvars import ContextVar
from importlib.metadata import version
from pathlib import Path
from statistics import fmean, median
from time import perf_counter

from scripts.run_text_rag import AI_DIR, save_report


def make_panel(cases):
    """정답은 보존하고 FAQ 목록의 절반 떨어진 항목을 대조 답변으로 쓴다."""
    bank = {}
    for case in cases:
        key = tuple(sorted(case['expected_chunk_ids']))
        bank.setdefault(key, case)
    keys = list(bank)
    if len(keys) < 2 or len({c['id'] for c in cases}) != len(cases):
        raise ValueError('서로 다른 FAQ와 고유 문항 ID가 필요합니다.')
    panel = []
    for case in cases:
        key = tuple(sorted(case['expected_chunk_ids']))
        choices = [keys[(keys.index(key)+len(keys)//2+i) % len(keys)] for i in range(len(keys))]
        negative = next((bank[k] for k in choices if set(k).isdisjoint(key)
                         and bank[k]['reference_answer'] != case['reference_answer']), None)
        if negative is None:
            raise ValueError('겹치지 않는 FAQ의 대조 답변이 없습니다.')
        for kind, source in (('reference', case), ('off_topic', negative)):
            panel.append({'id': case['id']+'::'+kind, 'case_id': case['id'], 'kind': kind,
                          'question': case['question'], 'response': source['reference_answer'],
                          'source_case_id': source['id'], 'source_faq_titles': source['expected_faq_titles'],
                          'label_status': 'reviewed_reference' if kind == 'reference' else 'synthetic_unreviewed'})
    return panel


def distribution(values):
    values = sorted(values)
    return {'count': len(values), 'mean': fmean(values) if values else None,
            'median': median(values) if values else None, 'min': values[0] if values else None,
            'max': values[-1] if values else None,
            'p25': values[max(0, math.ceil(len(values)*.25)-1)] if values else None,
            'p75': values[max(0, math.ceil(len(values)*.75)-1)] if values else None}


def analyze(rows, live):
    completed = [r for r in rows if r.get('metric', {}).get('status') == 'completed']
    by_kind = {kind: [r['metric']['value'] for r in completed if r['kind'] == kind]
               for kind in ('reference', 'off_topic')}
    positive, negative = by_kind['reference'], by_kind['off_topic']
    pairs = {}
    for row in completed:
        pairs.setdefault(row['case_id'], {})[row['kind']] = row['metric']['value']
    both = [p for p in pairs.values() if len(p) == 2]
    live_map = {r['id']: r['metrics']['answer_relevancy']['value'] for r in live['records']
                if r['metrics'].get('answer_relevancy', {}).get('status') == 'completed'}
    paired_live = [(r, live_map[r['case_id']]) for r in completed
                   if r['kind'] == 'reference' and r['case_id'] in live_map]
    references = [r for r in completed if r['kind'] == 'reference']
    return {'scored_count': len(completed), 'failed_or_pending_count': len(rows)-len(completed),
            'reference': distribution(positive), 'off_topic': distribution(negative),
            'paired_controls': {'count': len(both),
                'reference_higher_count': sum(p['reference'] > p['off_topic'] for p in both),
                'tie_count': sum(p['reference'] == p['off_topic'] for p in both)},
            'exploratory_auc': (sum((p > n)+.5*(p == n) for p in positive for n in negative)
                                / (len(positive)*len(negative))) if positive and negative else None,
            'threshold_diagnostics': [{
                'threshold': threshold,
                'reference_pass_count': sum(v >= threshold for v in positive), 'reference_count': len(positive),
                'off_topic_pass_count': sum(v >= threshold for v in negative), 'off_topic_count': len(negative),
            } for threshold in (.3, .4, .5, .6, .7, .8)],
            'paired_with_previous_live': {'count': len(paired_live),
                'live_mean': fmean(v for _, v in paired_live) if paired_live else None,
                'reference_mean': fmean(r['metric']['value'] for r, _ in paired_live) if paired_live else None,
                'mean_reference_minus_live': fmean(r['metric']['value']-v for r,v in paired_live) if paired_live else None},
            'reference_zero_score_ids': [r['case_id'] for r in references if r['metric']['value'] == 0],
            'reference_all_noncommittal_ids': [r['case_id'] for r in references
                if r['metric'].get('judgments') and all(j['output'].get('noncommittal') == 1 for j in r['metric']['judgments'])],
            'reference_non_korean_question_ids': [r['case_id'] for r in references
                if any(j['output'].get('question') and not re.search('[가-힣]', j['output']['question'])
                       for j in r['metric'].get('judgments', []))],
            'notes': ['관련성만 검사하며 정책 정확성·정답률을 측정하지 않음',
                      '다른 FAQ 답변은 자동 구성한 미검토 대조군이며 사람의 합격/불합격 표준이 아님',
                      '95문항은32FAQ에서 파생되어 독립 표본이 아님',
                      'AUC와 임계값 표는 탐색용. 이 자료로 고른 합격선을 같은 자료에서 검증하면 안 됨',
                      'Live는 이전 실행 점수 재사용. 평가 모델 비결정성으로 작은 차이를 확정적으로 해석하지 않음']}


def review(report):
    lines = ['# Relevancy 지표 대조 평가', '', '## 조건과 해석', '',
             '기준 답변95개와 다른 FAQ에서 가져온 미검토 대조 답변95개를 같은 질문에 연결한다.',
             '정책 정답률이나 배포 합격선을 결정하는 실험이 아니다. 기존 Live 점수는 재계산하지 않는다.', '',
             '```json', json.dumps(report['summary'], ensure_ascii=False, indent=2), '```', '', '## 문항별 기록', '']
    for row in report['records']:
        lines.extend([f"### {row['id']}", '', '고객 질문: '+row['question'], '',
                      '채점 답변: '+row['response'], '', '답변 출처: '+row['source_case_id']+' / '+', '.join(row['source_faq_titles']), '',
                      '라벨 상태: '+row['label_status'], '', '```json',
                      json.dumps(row.get('metric', {}), ensure_ascii=False, indent=2), '```', ''])
    return '\n'.join(lines)


def summary_markdown(report):
    summary = report['summary']
    lines = ['# Relevancy 기준 답변 대조 결과', '',
             '기준 답변을 넣어도 점수가 낮은지, 다른 FAQ의 답변과 구분되는지 확인하는 탐색 실험이다.',
             '기존 Live 점수는 그대로 사용한다. 임계값을 정하거나 답변 정답률을 계산한 결과가 아니다.', '',
             '| 답변 종류 | 채점 수 | 평균 | 중앙값 | 최소 | 최대 |', '| --- | --- | --- | --- | --- | --- |']
    for kind, label in [('reference','검토된 기준 답변'), ('off_topic','다른 FAQ의 대조 답변')]:
        row = summary[kind]
        lines.append(f"| {label} | {row['count']} | {row['mean']} | {row['median']} | {row['min']} | {row['max']} |")
    lines.extend(['', '## 가상의 합격선을 적용하면', '',
                  '오른쪽은 질문에 답하지 않도록 다른 FAQ를 연결한 미검토 대조군이다. 자동 합성 라벨의 한계를 포함한다.', '',
                  '| 점수 이상 통과 | 기준 답변 통과 | 대조 답변도 통과 |', '| --- | --- | --- |'])
    for row in summary['threshold_diagnostics']:
        lines.append(f"| {row['threshold']} | {row['reference_pass_count']}/{row['reference_count']} | {row['off_topic_pass_count']}/{row['off_topic_count']} |")
    lines.extend(['', '## 같은 질문끼리 비교', '', '```json',
                  json.dumps({'paired_controls':summary['paired_controls'],
                              'paired_with_previous_live':summary['paired_with_previous_live'],
                              'exploratory_auc':summary['exploratory_auc'],
                              'reference_zero_score_ids':summary['reference_zero_score_ids'],
                              'reference_all_noncommittal_ids':summary['reference_all_noncommittal_ids'],
                              'reference_non_korean_question_ids':summary['reference_non_korean_question_ids']}, ensure_ascii=False, indent=2), '```', '',
                  '## 해석 제한', '', *['- '+v for v in summary['notes']], '',
                  '- 낮은 점수의 기준 답변과 높은 점수의 대조 답변을 review.md에서 먼저 검토한다.',
                  '- 좋은 답변과 나쁜 답변 분포가 겹치면 단일 합격선으로 자동 통과시키지 않는다.',
                  '- 필수 사실 충족·정책 모순·근거 없는 추가 안내는 별도 정확성 평가로 확인한다.', '',
                  '## 기준 답변 점수가 대조 답변 이하인 문항', ''])
    pairs = {}
    for row in report['records']:
        if row.get('metric', {}).get('status') == 'completed':
            pairs.setdefault(row['case_id'], {})[row['kind']] = row
    for key, pair in pairs.items():
        if len(pair) != 2 or pair['reference']['metric']['value'] > pair['off_topic']['metric']['value']:
            continue
        lines.extend([f'### {key}', '', pair['reference']['question'], '',
                      f"기준 답변 ({pair['reference']['metric']['value']}): {pair['reference']['response']}", '',
                      f"대조 답변 ({pair['off_topic']['metric']['value']}): {pair['off_topic']['response']}", ''])
    return '\n'.join(lines)


async def run(args):
    os.environ['RAGAS_DO_NOT_TRACK'] = 'true'
    os.environ['HF_HUB_OFFLINE'] = '1'
    from dotenv import load_dotenv
    from openai import AsyncOpenAI
    from ragas.llms import llm_factory
    from ragas.llms.base import InstructorBaseRagasLLM
    from ragas.embeddings.base import embedding_factory
    from ragas.metrics.collections import AnswerRelevancy

    raw, live_raw = args.dataset.read_bytes(), args.live.read_bytes()
    cases, live = json.loads(raw), json.loads(live_raw)
    dataset_hash = hashlib.sha256(raw).hexdigest()
    if live['contract']['dataset_sha256'] != dataset_hash:
        raise ValueError('기준 답변과 기존 Live 실행 데이터셋이 다릅니다.')
    expected = {'judge_model': 'gpt-4.1', 'relevancy_embedding_model': 'text-embedding-3-small',
                'ragas_version': version('ragas')}
    if any(live['contract'].get(k) != v for k,v in expected.items()):
        raise ValueError('이전 Live 실행과 평가 모델·임베딩·Ragas 버전이 다릅니다.')
    if (live['status'] != 'completed' or {c['id'] for c in cases} != {r['id'] for r in live['records']}
            or any(r['metrics'].get('answer_relevancy', {}).get('status') != 'completed' for r in live['records'])):
        raise ValueError('같은 문항의 완료된 Live 관련성 점수가 필요합니다.')
    panel = make_panel(cases)
    contract = {'dataset_sha256': dataset_hash, 'live_evaluation_sha256': hashlib.sha256(live_raw).hexdigest(),
                'panel_sha256': hashlib.sha256(json.dumps(panel, ensure_ascii=False).encode()).hexdigest(),
                'judge_model': 'gpt-4.1', 'embedding_model': 'text-embedding-3-small',
                'strictness': 3, 'ragas_version': version('ragas'), 'negative_selection': 'halfway_faq_bank_v1'}
    output = args.output/'calibration.json'
    report = {'status': 'running', 'contract': contract, 'records': panel}
    if output.exists():
        previous = json.loads(output.read_bytes())
        if previous['contract'] != contract:
            raise ValueError('기존 대조 평가와 입력/모델이 다릅니다. 새 폴더를 사용하세요.')
        cached = {r['id']: r.get('metric') for r in previous['records']}
        for row in panel:
            if cached.get(row['id']):
                row['metric'] = cached[row['id']]
    report['concurrency'] = args.concurrency
    def checkpoint():
        report['summary'] = analyze(panel, live)
        save_report(output, report)
        (args.output/'review.md').write_text(review(report), encoding='utf-8')
        (args.output/'summary.md').write_text(summary_markdown(report), encoding='utf-8')
    checkpoint()
    pending = [r for r in panel if r.get('metric', {}).get('status') != 'completed']
    if not pending:
        report['status'] = 'completed'
        checkpoint()
        print('이미 모든 채점이 완료됐습니다. 추가 API 호출 없음.')
        return
    load_dotenv(AI_DIR/'.env', override=False)
    if not os.getenv('OPENAI_API_KEY'):
        raise ValueError('OpenAI 인증 환경변수가 필요합니다.')
    active = ContextVar('relevancy_calibration_judgments', default=None)
    class ObservedJudge(InstructorBaseRagasLLM):
        def __init__(self, delegate):
            self.delegate = delegate
        def generate(self, prompt, response_model):
            return self.delegate.generate(prompt, response_model)
        async def agenerate(self, prompt, response_model):
            result = await self.delegate.agenerate(prompt, response_model)
            active.get().append({'schema': response_model.__name__, 'output': result.model_dump(mode='json')})
            return result
    async with AsyncOpenAI(timeout=60, max_retries=1) as client:
        metric = AnswerRelevancy(
            llm=ObservedJudge(llm_factory('gpt-4.1', client=client, temperature=0, max_tokens=4096, store=False)),
            embeddings=embedding_factory('openai', model='text-embedding-3-small', client=client), strictness=3)
        semaphore = asyncio.Semaphore(args.concurrency)
        async def one(row):
            async with semaphore:
                events = []
                token = active.set(events)
                started = perf_counter()
                try:
                    result = await asyncio.wait_for(metric.ascore(user_input=row['question'], response=row['response']), 180)
                    value = float(result.value)
                    if not math.isfinite(value):
                        raise ValueError('점수가 유한하지 않습니다.')
                    row['metric'] = {'status': 'completed', 'value': value, 'judgments': events,
                                     'seconds': perf_counter()-started}
                except Exception as error:
                    row['metric'] = {'status': 'failed', 'error_type': type(error).__name__, 'judgments': events}
                finally:
                    active.reset(token)
                checkpoint()
                print(f"{row['id']} | {row['metric']['status']} | 채점 {report['summary']['scored_count']}/{len(panel)}", flush=True)
                return row['metric']['status']
        first = await one(pending[0])
        if first == 'completed':
            await asyncio.gather(*(one(r) for r in pending[1:]))
        report['status'] = 'completed' if all(r.get('metric', {}).get('status') == 'completed' for r in panel) else 'partial'
        checkpoint()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, default=AI_DIR/'evaluation/datasets/faq_v1/cases.json')
    parser.add_argument('--live', type=Path, default=AI_DIR/'data/private/evaluation/runs/live_rag_full_v1/evaluation.json')
    parser.add_argument('--output', type=Path, default=AI_DIR/'data/private/evaluation/runs/relevancy_calibration_v1')
    parser.add_argument('--concurrency', type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 4:
        parser.error('동시성은1~4입니다.')
    try:
        asyncio.run(run(args))
    except Exception as error:
        raise SystemExit(f'Relevancy 대조 평가 실패: {type(error).__name__}. 외부 예외 원문은 표시하지 않습니다.') from None


if __name__ == '__main__':
    main()
