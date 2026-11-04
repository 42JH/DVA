import json

import pytest
from pydantic import ValidationError

from app.rag.context import build_search_context
from app.rag.schemas import Evidence, SearchContext


def item(key, text='원래 답변', score=.1):
    return Evidence(chunk_id=key, source_id='manual_v1', title=f'질문 {key}', content=text, reranker_score=score)


def test_top3_keeps_reranker_order_and_preserves_negative_policy_and_table():
    body = '| 상태 | 취소 |\n| --- | --- |\n| 발송완료 | 불가 |\n예외를 임의로 만들지 않습니다.'
    context = build_search_context('취소 가능한가요?', [item('b', body), item('a'), item('d'), item('c')])
    payload = context.llm_payload()
    assert context.status == 'found'
    assert [x['chunk_id'] for x in payload['evidence']] == ['b', 'a', 'd']
    assert payload['evidence'][0]['content'] == body
    assert [x['rank'] for x in payload['evidence']] == [1, 2, 3]
    assert 'reranker_score' not in json.dumps(payload)


def test_duplicate_is_removed_without_dropping_other_evidence():
    result = build_search_context('질문', [item('a'), item('a', score=.9), item('b'), item('c')])
    assert [x.chunk_id for x in result.evidence] == ['a', 'b', 'c']
    with pytest.raises(ValueError):
        build_search_context('질문', [item('a'), item('a', '다른 답변')])


def test_empty_and_short_results_are_not_filled_with_invented_documents():
    assert build_search_context('질문', []).llm_payload() == {'question': '질문', 'status': 'no_evidence', 'evidence': []}
    assert len(build_search_context('질문', [item('a')]).evidence) == 1


@pytest.mark.parametrize('field', ['chunk_id', 'source_id', 'title', 'content'])
def test_blank_evidence_fields_rejected(field):
    value = item('a').model_dump()
    value[field] = '  '
    with pytest.raises(ValidationError):
        Evidence(**value)


def test_invalid_question_and_score_rejected():
    with pytest.raises(ValidationError):
        build_search_context(' ', [])
    with pytest.raises(ValidationError):
        item('a', score=float('nan'))


def test_invalid_status_and_too_many_or_duplicate_evidence_rejected():
    with pytest.raises(ValidationError):
        SearchContext(question='질문', status='found', evidence=())
    with pytest.raises(ValidationError):
        SearchContext(question='질문', status='no_evidence', evidence=(item('a'),))
    with pytest.raises(ValidationError):
        SearchContext(question='질문', status='found', evidence=tuple(item(str(i)) for i in range(4)))
    with pytest.raises(ValidationError):
        SearchContext(question='질문', status='found', evidence=(item('a'), item('a')))


def test_inspection_does_not_leak_evaluation_labels_to_llm(tmp_path, monkeypatch, capsys):
    from scripts.inspect_rag_context import main

    path = tmp_path/'result.json'
    path.write_text(json.dumps({'status': 'completed', 'input_format': 'original_A', 'records': [
        {'id': 'case', 'question': '고객 질문', 'expected_faq_titles': ['정답 표시'], 'results': [
            {'chunk_id': 'a', 'title': '원래 제목', 'context': '원래 답변', 'reranker_score': .2}]}]}), encoding='utf-8')
    monkeypatch.setattr('sys.argv', ['inspect', '--results', str(path), '--id', 'case', '--source-id', 'manual_v1'])
    main()
    payload = json.loads(capsys.readouterr().out)
    assert payload['evidence'][0]['content'] == '원래 답변'
    assert 'expected_faq_titles' not in payload and '정답 표시' not in json.dumps(payload, ensure_ascii=False)
