"""저장된 Qwen A 결과의 Top3를 확인한다. 검색/API/모델 추론은 없다."""

import argparse
import json
from pathlib import Path

from app.rag.context import build_search_context
from app.rag.schemas import Evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--id', required=True, help='저장된 평가 문항 ID')
    parser.add_argument('--source-id', required=True, help='자료의 안정적인 식별자. 로컬 경로 대신 사용')
    parser.add_argument('--format', choices=['json', 'text'], default='json', help='JSON 또는 Markdown 템플릿 미리보기')
    args = parser.parse_args()
    report = json.loads(args.results.read_text(encoding='utf-8'))
    if report.get('status') != 'completed' or report.get('input_format') != 'original_A':
        raise ValueError('완료된 Qwen A 결과를 지정하세요.')
    rows = [row for row in report['records'] if row['id'] == args.id]
    if len(rows) != 1:
        raise ValueError('요청 문항이 없거나 중복됐습니다.')
    row = rows[0]
    evidence = [Evidence(chunk_id=doc['chunk_id'], source_id=args.source_id, title=doc['title'],
                         content=doc['context'], reranker_score=doc['reranker_score']) for doc in row['results']]
    context = build_search_context(row['question'], evidence)
    # 평가 정답·필수 사실은 LLM 근거에 포함하지 않는다.
    if args.format == 'text':
        from app.rag.prompts import RagContextRenderer
        print(RagContextRenderer().render(context))
    else:
        print(json.dumps(context.llm_payload(), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
