import pytest

from scripts.calibrate_relevancy import make_panel, analyze


def cases():
    return [{'id': f'c{i}', 'question': f'질문{i}', 'reference_answer': f'답변{i}',
             'expected_chunk_ids': [f'faq{i//2}'], 'expected_faq_titles': [f'제목{i//2}']} for i in range(6)]


def test_controls_preserve_gold_and_choose_different_faq_without_human_label_claim():
    data = cases()
    panel = make_panel(data)
    assert len(panel) == 12 and len({r['id'] for r in panel}) == 12
    by_id = {c['id']: c for c in data}
    for row in panel:
        source = by_id[row['source_case_id']]
        original = by_id[row['case_id']]
        assert row['response'] == source['reference_answer']
        if row['kind'] == 'reference':
            assert source == original
            assert row['label_status'] == 'reviewed_reference'
        else:
            assert set(source['expected_chunk_ids']).isdisjoint(original['expected_chunk_ids'])
            assert row['label_status'] == 'synthetic_unreviewed'
    assert make_panel(data) == panel
    with pytest.raises(ValueError):
        make_panel(data[:2])


def test_thresholds_auc_and_paired_live_keep_missing_or_failed_out_of_denominator():
    rows = [
        {'case_id': 'a', 'kind': 'reference', 'metric': {'status': 'completed', 'value': .6}},
        {'case_id': 'a', 'kind': 'off_topic', 'metric': {'status': 'completed', 'value': .2}},
        {'case_id': 'b', 'kind': 'reference', 'metric': {'status': 'completed', 'value': .3}},
        {'case_id': 'b', 'kind': 'off_topic', 'metric': {'status': 'completed', 'value': .3}},
        {'case_id': 'c', 'kind': 'reference', 'metric': {'status': 'failed'}},
    ]
    live = {'records': [{'id':'a', 'metrics': {'answer_relevancy': {'status':'completed', 'value':.4}}}]}
    result = analyze(rows, live)
    assert result['scored_count'] == 4 and result['failed_or_pending_count'] == 1
    assert result['paired_controls'] == {'count':2, 'reference_higher_count':1, 'tie_count':1}
    assert result['exploratory_auc'] == .875
    assert result['paired_with_previous_live']['mean_reference_minus_live'] == pytest.approx(.2)
    assert result['threshold_diagnostics'][-1]['reference_pass_count'] == 0
    assert result['threshold_diagnostics'][-1]['reference_count'] == 2
