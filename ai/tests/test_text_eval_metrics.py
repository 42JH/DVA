import pytest

from scripts.text_eval_metrics import retrieval_metrics


def test_hit_and_recall_differ_for_multiple_relevant_faqs():
    result = retrieval_metrics(['wrong', 'gold_a', 'other'], ['gold_a', 'gold_b'], 3)
    assert result['hit_at_3'] == 1
    assert result['recall_at_3'] == .5
    assert result['expected_rank'] == 2
    assert result['reciprocal_rank'] == .5


def test_candidate_miss_and_reranking_cutoff_are_not_confused():
    ranked = ['a', 'b', 'c', 'gold', 'e']
    assert retrieval_metrics(ranked, ['gold'], 5)['recall_at_5'] == 1
    assert retrieval_metrics(ranked, ['gold'], 3)['recall_at_3'] == 0
    assert retrieval_metrics([], ['gold'], 5)['reciprocal_rank'] == 0
    with pytest.raises(ValueError):
        retrieval_metrics(['a', 'a'], ['gold'], 5)
