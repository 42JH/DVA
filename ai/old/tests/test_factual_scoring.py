import copy

import pytest

from scripts.score_factual_correctness import prepare, diagnostics, summarize


def test_additional_evaluation_preserves_original_answer_and_all_existing_metrics():
    cases = [{'id':'a','question':'질문','reference_answer':'기준'}]
    source = {'records':[{'id':'a','question':'질문','reference_answer':'기준','answer':'실제 발화',
                          'generation_status':'completed','metrics':{'faithfulness':{'value':.8}}}]}
    original = copy.deepcopy(source)
    rows = prepare(source,cases)
    rows[0]['metrics']['factual_correctness'] = {'value':.6}
    assert source == original
    assert rows[0]['metrics']['faithfulness'] == source['records'][0]['metrics']['faithfulness']
    assert rows[0]['answer'] == '실제 발화'
    with pytest.raises(ValueError):
        prepare(source,[{'id':'a','question':'질문','reference_answer':'바뀐 기준'}])


def test_diagnostics_separate_response_support_from_reference_omissions_and_pending():
    events = [
        {'stage':'response_against_reference','output':{'statements':[{'verdict':1},{'verdict':0}]}},
        {'stage':'reference_against_response','output':{'statements':[{'verdict':1},{'verdict':1},{'verdict':0}]}}
    ]
    result = diagnostics(events)
    assert result['response_against_reference'] == {'statement_count':2,'supported_count':1,'unsupported_count':1}
    assert result['reference_against_response']['unsupported_count'] == 1
    rows = [{'metrics':{'factual_correctness':{'status':'completed','value':.8}}},
            {'metrics':{'factual_correctness':{'status':'failed'}}}, {'metrics':{}}]
    summary = summarize(rows)
    assert summary['valid_count'] == summary['failed_count'] == summary['pending_count'] == 1
    assert summary['mean'] == .8
    assert sum(summary['score_distribution'].values()) == 1
