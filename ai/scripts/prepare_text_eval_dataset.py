"""검토 완료 질문과 현재 원문으로 고정 평가 데이터셋 사본을 만든다. API/DB 호출 없음."""

import argparse
import hashlib
import json
from pathlib import Path

from scripts.evaluate_bm25 import faq_documents
from scripts.evaluate_retrieval import load_cases


AI_DIR = Path(__file__).resolve().parent.parent
EVAL_DIR = AI_DIR / 'evaluation'


def prepare(source: Path, dataset: Path, target: Path):
    cases, selection = load_cases(dataset)
    raw = source.read_bytes()
    documents = faq_documents(raw.decode('utf-8'), source)
    by_title = {doc.metadata['header_3']: doc for doc in documents}
    output = []
    for case in cases:
        if not case.get('reference_answer') or not case.get('required_facts'):
            raise ValueError('기준 답변과 필수 사실이 필요합니다.')
        evidence = []
        for title in case['expected_faq_titles']:
            doc = by_title[title]
            evidence.append({'chunk_id': doc.metadata['chunk_id'], 'source_id': 'delivery_faq',
                             'title': title, 'content': doc.page_content})
        output.append({**case, 'reference_evidence': evidence,
                       'reference_contexts': [row['content'] for row in evidence],
                       'expected_chunk_ids': [row['chunk_id'] for row in evidence]})
    manifest = {'dataset_version': target.name, 'question_count': len(output), 'split': 'dev',
                'selection': selection, 'source_sha256': hashlib.sha256(raw).hexdigest(),
                'gold_unit': 'FAQ 하나를 청크 하나로 저장하는 현재 기준선. 분할 변경 시 데이터셋 새 버전 필요.',
                'reference_evidence_review': '기존 검토 완료 정답 FAQ 제목으로 원문을 연결함. 새 독립 test 검토를 의미하지 않음.'}
    serialized = json.dumps(output, ensure_ascii=False, indent=2, allow_nan=False)
    manifest['cases_sha256'] = hashlib.sha256(serialized.encode('utf-8')).hexdigest()
    manifest['cases_sha256_kind'] = 'UTF-8 LF 기준 내용 해시'
    if target.exists():
        if (target/'cases.json').read_text(encoding='utf-8') != serialized:
            raise ValueError('기존 버전을 덮어쓰지 않습니다. 새 버전을 지정하세요.')
        manifest['cases_raw_sha256'] = hashlib.sha256((target/'cases.json').read_bytes()).hexdigest()
        return manifest
    target.mkdir(parents=True)
    (target/'cases.json').write_bytes(serialized.encode('utf-8'))
    manifest['cases_raw_sha256'] = manifest['cases_sha256']
    (target/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    (target/'README.md').write_text('# 텍스트 RAG 평가 데이터셋\n\n기존 검토 완료 dev 문항과 원문 FAQ를 연결한 고정 사본입니다.\n정답·근거·필수 사실은 채점자에게만 제공하고 답변 LLM에는 질문만 제공합니다.\n원본과 이전 결과를 이동·삭제하지 않았습니다.\n', encoding='utf-8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=AI_DIR/'manuals/delivery_faq.md')
    parser.add_argument('--dataset', type=Path, default=EVAL_DIR/'datasets/faq_retrieval_v1.json')
    parser.add_argument('--target', type=Path, default=EVAL_DIR/'datasets/faq_v1')
    args = parser.parse_args()
    result = prepare(args.source, args.dataset, args.target)
    print(f"평가 데이터셋 {result['question_count']}개 준비: {args.target}")


if __name__ == '__main__':
    main()
