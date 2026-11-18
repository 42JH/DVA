import json

import pytest

from scripts.prepare_text_eval_dataset import prepare
from scripts.score_text_rag import prepare_records, summarize, review_markdown, latency_breakdown
from scripts.run_text_rag import save_report


def case():
    return {'id': 'faq_1', 'question': '취소 가능한가요?', 'reference_answer': '발송 뒤 취소 불가',
            'required_facts': ['발송 뒤 불가'], 'expected_chunk_ids': ['gold'],
            'reference_evidence': [{'chunk_id': 'gold', 'content': '기준 원문'}]}


def test_only_actual_tool_evidence_becomes_ragas_context_and_errors_are_counted():
    rows = prepare_records({'records': [{'id': 'faq_1', 'question': '취소 가능한가요?', 'status': 'completed',
                            'answer': '확인이 필요합니다.', 'tool_calls': [], 'total_seconds': .5}]}, [case()])
    assert rows[0]['retrieved_contexts'] == []
    assert rows[0]['reference_evidence'][0]['content'] == '기준 원문'
    assert rows[0]['retrieval_metrics']['rrf']['recall_at_5'] == 0
    summary = summarize(rows, 2)
    assert summary['missing_generation_count'] == 1
    assert summary['metric_summary']['faithfulness'] == {'valid_count': 0, 'mean': None, 'unscored_count': 2}
    text = review_markdown({'summary': summary, 'records': rows})
    assert '확인이 필요합니다.' in text and '기준 답변' in text


def test_question_mismatch_is_rejected_before_scoring():
    with pytest.raises(ValueError):
        prepare_records({'records': [{'id': 'faq_1', 'question': '다른 질문', 'status': 'completed'}]}, [case()])


def test_latency_separates_api_calls_search_and_queue_without_counting_startup():
    row = {'responses': [{'seconds': 2}, {'seconds': 1}], 'total_seconds': 5,
           'tool_calls': [{'seconds': 1.9, 'retrieval_seconds': 1.5, 'reranking_seconds': .2,
                           'search_timings': {'embedding_seconds': 1.2}}]}
    result = latency_breakdown(row)
    assert result['initial_llm_seconds'] == 2
    assert result['followup_llm_seconds'] == 1
    assert result['embedding_seconds'] == 1.2
    assert result['tool_queue_and_other_seconds'] == pytest.approx(.4)
    assert sum(result.values()) == pytest.approx(5)


def test_dataset_preparation_preserves_reference_and_refuses_changed_version(tmp_path):
    source = tmp_path / 'faq.md'
    source.write_text('# 매뉴얼\n\n### Q. 취소 가능한가요?\n발송 뒤 취소 불가\n', encoding='utf-8')
    data = tmp_path / 'old.json'
    entry = {**case(), 'expected_faq_titles': ['Q. 취소 가능한가요?'], 'split': 'dev',
             'review_status': 'reviewed', 'answerable': True}
    data.write_text(json.dumps([entry]), encoding='utf-8')
    target = tmp_path / 'datasets/v1'
    manifest = prepare(source, data, target)
    assert manifest['question_count'] == 1
    result = json.loads((target/'cases.json').read_text(encoding='utf-8'))[0]
    assert result['reference_answer'] == entry['reference_answer']
    assert '발송 뒤 취소 불가' in result['reference_contexts'][0]
    assert result['expected_chunk_ids'] == [result['reference_evidence'][0]['chunk_id']]
    assert prepare(source, data, target)['question_count'] == 1
    source.write_text(source.read_text(encoding='utf-8')+'변경\n', encoding='utf-8')
    with pytest.raises(ValueError, match='덮어쓰지'):
        prepare(source, data, target)


def test_checkpoint_retries_only_windows_temporary_file_lock(tmp_path, monkeypatch):
    from pathlib import Path
    from scripts import run_text_rag
    original = Path.replace
    calls, delays = [], []
    def replace(path, target):
        calls.append(target)
        if len(calls) < 3:
            error = PermissionError('가짜 Windows 공유 잠금')
            error.winerror = 32
            raise error
        return original(path, target)
    monkeypatch.setattr(Path, 'replace', replace)
    monkeypatch.setattr(run_text_rag.time, 'sleep', delays.append)
    output = tmp_path/'result.json'
    save_report(output, {'value': '완료'})
    assert json.loads(output.read_text(encoding='utf-8')) == {'value': '완료'}
    assert len(calls) == 3 and delays == [.02, .04]
    def forbidden(*args):
        raise PermissionError('영구 권한 오류')
    monkeypatch.setattr(Path, 'replace', forbidden)
    with pytest.raises(PermissionError):
        save_report(output, {'value': '덮어쓰면 안 됨'})
    assert json.loads(output.read_text(encoding='utf-8')) == {'value': '완료'}
