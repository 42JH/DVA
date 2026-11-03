"""Live 음성 실험의 실제 표본 수·검색·채점·시간 및 검토 대상을 요약한다."""

import argparse
import hashlib
import json
import math
from pathlib import Path
from statistics import fmean, median

from scripts.run_text_rag import save_report
from scripts.score_text_rag import prepare_records, summarize


def stats(values):
    values = sorted(values)
    return {'count': len(values), 'mean': fmean(values) if values else None,
            'median': median(values) if values else None,
            'p95': values[math.ceil(len(values)*.95)-1] if values else None}


def build(generation, cases, evaluation=None):
    records = prepare_records(generation, cases)
    if evaluation is not None:
        graded = {row['id']: row for row in evaluation['records']}
        for row in records:
            previous = graded.get(row['id'])
            if previous and previous['answer'] == row['answer'] and previous['tool_calls'] == row['tool_calls']:
                row['metrics'] = previous['metrics']
    result = {'summary': summarize(records, generation['contract']['selection']['run_count']),
              'voice_seconds': {}, 'review': [],
              'previous_attempts_count': len(generation.get('previous_attempts', [])),
              'previous_failed_attempts': [{'id': row['id'], 'error_type': row.get('error_type'),
                                            'input_audio_seconds': row.get('voice_timings', {}).get('input_audio_seconds')}
                                           for row in generation.get('previous_attempts', []) if row['status'] != 'completed'],
              'query_changed_count': sum(bool(row['tool_calls']) and row['tool_calls'][0].get('question') != row['question']
                                         for row in records),
              'no_delegation_count': sum(not row['tool_calls'] for row in records),
              'limitations': ['합성 한국어 질문·문항별 새 세션·WebSocket 실험이며 실제 마이크/WebRTC 지연과 다름',
                             '첫 음성 패킷은 재생 또는 정답 안내 시작이 아님. 과거 텍스트 완료 시간과 직접 비교 금지',
                             '전사 전체(맞장구 포함)를 채점하며 전사 자체의 인식 오류는 별도 수동 검토 필요',
                             '검색어 변경 수는 원 질문과 문자열 비교이며 음성 전사·문장 정리 차이도 포함함',
                             '침묵으로 완료 추정. 문장 완료·실제 오디오 재생을 API가 보장한 것이 아님',
                             '기존 검토된 개발 질문 재사용이며 독립 시험 데이터의 성능이 아님']}
    keys = set().union(*(r.get('voice_timings', {}).keys() for r in generation['records']))
    for key in sorted(keys):
        if key.endswith('_seconds'):
            result['voice_seconds'][key] = stats([r['voice_timings'][key] for r in generation['records']
                if r['status'] == 'completed' and isinstance(r.get('voice_timings', {}).get(key), (int, float))])
    for row, raw in zip(records, generation['records']):
        flags = []
        if row['generation_status'] != 'completed':
            flags.append('실행 실패/시간 제한')
        if not row['tool_calls']:
            flags.append('검색 위임 없음')
        if row['retrieval_metrics']['reranked']['hit_at_3'] != 1:
            flags.append('첫 검색 Top3 정답 ID 누락')
        elif row['retrieval_metrics']['reranked']['hit_at_1'] != 1:
            flags.append('정답 근거가1위 아님(Top3 전달의 실패를 뜻하지 않음)')
        if len(row['tool_calls']) > 1:
            flags.append('위임 여러 번')
        for name, metric in row['metrics'].items():
            if metric.get('status') == 'completed' and metric['value'] < .8:
                flags.append(f'{name} 0.8 미만(검토용, 실패 판정 기준 아님)')
        if flags:
            result['review'].append({'id': row['id'], 'question': row['question'], 'answer': row['answer'],
                                     'reference_answer': row['reference_answer'], 'flags': flags,
                                     'expected_reranked_rank': row['retrieval_metrics']['reranked']['expected_rank'],
                                     'voice_timings': raw.get('voice_timings', {})})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generation', type=Path, required=True)
    parser.add_argument('--dataset', type=Path, default=Path(__file__).resolve().parent.parent/
                        'evaluation/datasets/faq_v1/cases.json')
    args = parser.parse_args()
    raw = args.generation.read_bytes()
    generation = json.loads(raw)
    dataset_raw = args.dataset.read_bytes()
    if hashlib.sha256(dataset_raw).hexdigest() != generation['contract']['selection']['dataset_sha256']:
        raise ValueError('실행과 분석 데이터셋의 해시가 다릅니다.')
    cases = json.loads(dataset_raw)
    target = args.generation.parent
    graded = target/'evaluation.json'
    evaluation = json.loads(graded.read_text(encoding='utf-8')) if graded.exists() else None
    if evaluation is not None and evaluation['contract']['generation_sha256'] != hashlib.sha256(raw).hexdigest():
        raise ValueError('채점 후 생성 결과가 변경되었습니다. 최신 결과를 다시 채점하세요.')
    result = build(generation, cases, evaluation)
    save_report(target/'analysis.json', result)
    lines = ['# Live-1 RAG 음성 평가 분석', '', *['- '+v for v in result['limitations']], '',
             '## 전체 결과', '', '```json', json.dumps({k:v for k,v in result.items() if k not in ('review','limitations')},
                                                    ensure_ascii=False, indent=2), '```', '', '## 검토 대상', '']
    for row in result['review']:
        lines.extend([f"### {row['id']}", '', row['question'], '', '확인 항목: '+', '.join(row['flags']), '',
                      f"정답 근거 순위: {row['expected_reranked_rank']}", '',
                      '실제 발화: '+(row['answer'] or '(없음)'), '', '기준 답변: '+row['reference_answer'], ''])
    (target/'analysis.md').write_text('\n'.join(lines), encoding='utf-8')
    print(f'분석 저장: {target}')


if __name__ == '__main__':
    main()
