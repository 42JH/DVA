import json

import pytest

from app.rag.context import build_search_context
from app.rag.prompts import RagContextRenderer
from app.rag.schemas import Evidence


def test_renderer_preserves_order_table_ids_and_literal_braces_without_scores():
    body = '| 상태 | 취소 |\n| --- | --- |\n| 발송완료 | 불가 |\n{question} {context}는 자료의 문자입니다.'
    rows = [Evidence(chunk_id=key, source_id='manual_v1', title=key, content=body,
                     reranker_score=float(i)) for i, key in enumerate(['b', 'a', 'c', 'd'])]
    context = build_search_context('취소 {가능} 여부?', rows)
    text = RagContextRenderer().render(context)
    assert '취소 {가능} 여부?' in text
    evidence = json.loads(text.split('Context:\n', 1)[1])
    assert [row['chunk_id'] for row in evidence] == ['b', 'a', 'c']
    assert evidence[0]['content'] == body
    assert evidence[0]['source_id'] == 'manual_v1'
    assert 'reranker_score' not in text
    assert 'expected_faq_titles' not in text


def test_no_evidence_is_explicit_without_invented_context():
    text = RagContextRenderer().render(build_search_context('질문', []))
    assert 'no_evidence' in text
    assert json.loads(text.split('Context:\n', 1)[1]) == []


@pytest.mark.parametrize('text', [
    '{question} {context}', '{question} {status} {context} {answer}',
])
def test_template_variable_contract_rejects_missing_or_extra_variables(tmp_path, text):
    path = tmp_path / 'template.md'
    path.write_text(text, encoding='utf-8')
    with pytest.raises(ValueError, match='템플릿 변수'):
        RagContextRenderer(path)


def test_prepared_renderer_reuses_loaded_template_and_missing_file_fails(tmp_path):
    path = tmp_path / 'template.md'
    path.write_text('{question}\n{status}\n{context}', encoding='utf-8')
    renderer = RagContextRenderer(path)
    path.unlink()
    assert 'no_evidence' in renderer.render(build_search_context('질문', []))
    with pytest.raises(FileNotFoundError):
        RagContextRenderer(path)
