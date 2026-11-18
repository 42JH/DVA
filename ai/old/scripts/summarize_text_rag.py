"""완료된 텍스트 실행의 시간·검색 품질·채점을 사람이 읽을 보고서로 정리한다."""

import argparse
import json
import math
from pathlib import Path
from statistics import fmean, median

from scripts.run_text_rag import save_report
from scripts.score_text_rag import prepare_records, summarize


def stats(values):
    values = sorted(values)
    if not values:
        return {'count': 0, 'mean': None, 'median': None, 'p95': None, 'min': None, 'max': None}
    return {'count': len(values), 'mean': fmean(values), 'median': median(values),
            'p95': values[math.ceil(len(values)*.95)-1], 'min': values[0], 'max': values[-1]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--smoke-dir', type=Path)
    args = parser.parse_args()
    ai = Path(__file__).resolve().parent.parent
    generation = json.loads((args.run_dir/'generation.json').read_text(encoding='utf-8'))
    cases = json.loads((ai/'evaluation/datasets/faq_v1/cases.json').read_text(encoding='utf-8'))
    rows = prepare_records(generation, cases)
    count = generation['contract']['selection']['run_count']
    overall = summarize(rows, count)
    timing = {name: stats([row['latency_breakdown'][name] for row in rows
                          if row['generation_status'] == 'completed' and row['latency_breakdown'][name] is not None])
              for name in rows[0]['latency_breakdown']} if rows else {}
    timing['total_seconds'] = stats([row['total_seconds'] for row in rows if row['total_seconds'] is not None])
    changed = [{'id': row['id'], 'question': row['question'], 'search_question': call.get('question')}
               for row in generation['records'] for call in row.get('tool_calls', [])
               if call.get('question') and call['question'] != row['question']]
    missed = [{key: row[key] for key in ['id', 'question', 'answer', 'reference_answer', 'retrieval_metrics']}
              for row in rows if not row['retrieval_metrics']['reranked']['hit_at_3']]
    evaluation_path = args.run_dir/'evaluation.json'
    evaluation = json.loads(evaluation_path.read_text(encoding='utf-8')) if evaluation_path.exists() else None
    result = {'generation_status': generation['status'], 'request_count': count,
              'search_summary': overall['retrieval_summary'], 'timings': timing,
              'changed_query_count': len(changed), 'changed_queries': changed, 'top3_id_misses': missed,
              'grading_status': evaluation['status'] if evaluation else 'not_started',
              'ragas': evaluation['summary']['metric_summary'] if evaluation else None,
              'concurrency': generation['concurrency'], 'startup_seconds': generation['search']['startup_seconds']}
    lines = ['# 텍스트 RAG 평가 분석', '', f"질문 {count}개 / 생성 {generation['status']} / Ragas 채점 {result['grading_status']}", '',
             '## 임베딩에 매번 3초가 필요한가?', '',
             '아니다. 아래 값은 실제 질문별 임베딩 API 왕복 시간이다. 로컬 전처리, 연결 준비, 네트워크, 서비스 대기, 계산, 응답 수신이 포함될 수 있으며 서버 내부 계산 시간만 분리해 측정한 값은 아니다.', '',
             '| 구간 | 평균(초) | 중앙값(초) | p95(초) | 최소(초) | 최대(초) |',
             '| --- | ---: | ---: | ---: | ---: | ---: |']
    labels = {'initial_llm_seconds': '첫 LLM 호출', 'followup_llm_seconds': '후속 LLM 호출 합계',
              'embedding_seconds': '질문 임베딩', 'dense_search_seconds': '벡터 DB 검색',
              'tokenization_and_bm25_seconds': '토큰화·BM25', 'fusion_seconds': 'RRF',
              'reranking_seconds': 'Qwen', 'tool_queue_and_other_seconds': '도구 대기·기타',
              'total_seconds': '최종 텍스트 응답까지 전체'}
    for name, label in labels.items():
        value = timing[name]
        if value['count']:
            lines.append('| '+label+' | '+' | '.join(f"{value[key]:.4f}" for key in ['mean', 'median', 'p95', 'min', 'max'])+' |')
    if args.smoke_dir:
        smoke = json.loads((args.smoke_dir/'generation.json').read_text(encoding='utf-8'))
        first = prepare_records(smoke, cases)[0]
        result['separate_smoke'] = {'total_seconds': first['total_seconds'], 'latency_breakdown': first['latency_breakdown'],
                                    'startup_seconds': smoke['search']['startup_seconds']}
        lines.extend(['', '## 앞서 관찰한 8.84초 한 건', '',
                      f"별도 단건 전체 {first['total_seconds']:.3f}초, 임베딩 {first['latency_breakdown']['embedding_seconds']:.3f}초다. 위 전체 실행 표와 다른 요청이며 결과를 섞지 않는다.", '',
                      '```json', json.dumps(result['separate_smoke'], ensure_ascii=False, indent=2), '```', '',
                      '3.76초 지연은 이번 전체 실행에서 반복되지 않았다. 초기 연결·토크나이저 준비·서비스 대기·재시도 등의 가능성을 원인으로 확정할 수는 없다. HTTP 내부 이벤트나 재시도별 계측이 없어 정확한 원인은 미확정이다.'])
    lines.extend(['', '## 응답 시간의 병목과 측정 한계', '',
                  '도구 호출 방식에는 먼저 검색 여부/검색어를 정하는 LLM 요청과 근거를 읽고 답하는 LLM 요청이 있다. 이번 평균에서 어느 구간이 큰지는 위 표로 판단한다. 준비·Ragas 채점은 요청 시간에 포함하지 않는다.', '',
                  f"실행 동시성은 {generation['concurrency']}이며 GPU 검색은 직렬 처리한다. 첫 토큰이 아닌 비스트리밍 최종 답변 완료 시간이고, 실제 음성·PBX·원격 GPU 네트워크 지연은 포함하지 않는다. p95 구간별 합은 전체 p95가 아니다.", '',
                  '## 검색 품질', '', '```json', json.dumps(result['search_summary'], ensure_ascii=False, indent=2), '```', '',
                  '## LLM 검색어와 과거 기준선의 차이', '',
                  f"원 질문과 검색어 문자열이 다른 호출은 {len(changed)}개다. 별도 질의 확장 모델을 추가한 것은 아니지만 LLM이 도구 인수를 재작성/보강했다. 과거 원 질문 고정 검색과 같은 조건이라고 간주하지 않는다. 원 질문을 그대로 검색하도록 제한하는 비교는 별도 실행으로 남긴다.", '',
                  '## 정답 근거 ID가 Top3에서 빠진 문항', ''])
    for row in missed:
        lines.extend([f"- {row['id']}: {row['question']}", f"  - 실제 답변: {row['answer']}",
                      f"  - 기준 답변: {row['reference_answer']}"])
    lines.extend(['', 'ID 미적중은 최종 답변의 모든 내용이 틀렸다는 뜻은 아니다. 필요한 정보가 다른 근거에 중복되어 있을 수 있으므로 문맥/답변 지표와 원문을 함께 확인한다.', '',
                  '## Ragas 채점', '', '```json', json.dumps(result['ragas'], ensure_ascii=False, indent=2), '```', '',
                  '채점 중이면 위 수치는 중간값이며, 완료 후 이 보고서를 다시 생성한다. Answer Relevancy는 역질문과 원 질문의 임베딩 유사도이고 사실 정확도나 정답률이 아니다. 낮은 점수의 주장·판정과 필수 사실은 review.md에서 사람이 검토한다.', '',
                  '## 자동 채점 결과를 그대로 정답률로 볼 수 없는 사례', '',
                  '- faq_07_03: 상담원 연결 의사를 묻는 문장을 Ragas가 사실 주장으로 분해해 문서에 없다고 감점했다. 회사 운영 지침에 따른 연결 동의 질문과 정책 근거의 정확성을 나눠 검토해야 한다.',
                  '- faq_10_03: 고객이 질문에서 제시한 100cm·5kg을 답변이 되풀이했는데, Ragas의 문맥 판정은 고객 질문의 수치를 검색 문서에 없다고 보아 감점했다. 검색 문서의 중박스 기준 및 질문 조건과 답변을 함께 확인해야 한다.',
                  '- faq_17_03: 원문은 도서·산간 설명에서 배송도 1~2일 더 걸릴 수 있다고 쓰지만, 판정자는 제주에만 적용된다고 읽어 감점했다. 원문 적용 범위에 대한 사람 검토가 필요하다.', '',
                  '이 사례의 원점수는 수정하지 않는다. 같은 지표의 자동 점수와 사람 검토 메모를 분리하며, 개선된 평가 프롬프트/정책 자료 포함 여부를 시험하려면 별도 버전으로 실행한다.'])
    save_report(args.run_dir/'analysis.json', result)
    (args.run_dir/'analysis.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    print(f'분석 저장: {args.run_dir / "analysis.md"}')


if __name__ == '__main__':
    main()
