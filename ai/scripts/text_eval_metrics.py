"""정답 ID 기준 검색 지표. 문장·주장 단위 Ragas 지표와 구분한다."""


def retrieval_metrics(ranked_ids, expected_ids, k):
    gold = set(expected_ids)
    if not gold or k < 1 or len(ranked_ids) != len(set(ranked_ids)):
        raise ValueError('정답 ID, K, 후보 중복을 확인하세요.')
    matched = len(set(ranked_ids[:k]) & gold)
    rank = next((rank for rank, key in enumerate(ranked_ids, 1) if key in gold), None)
    return {f'hit_at_{k}': int(matched > 0), f'recall_at_{k}': matched / len(gold),
            'expected_rank': rank, 'reciprocal_rank': 1 / rank if rank else 0.0}


def score_search_call(call, expected_ids):
    stages = {'bm25': ('bm25_results', 5), 'dense': ('dense_results', 5),
              'rrf': ('rrf_candidates', 5), 'reranked': ('reranked', 3)}
    output = {}
    for name, (field, k) in stages.items():
        ids = [row['chunk_id'] for row in call.get(field, [])]
        output[name] = {**retrieval_metrics(ids, expected_ids, k),
                        **retrieval_metrics(ids, expected_ids, 3),
                        'hit_at_1': int(bool(ids) and ids[0] in set(expected_ids))}
    return output
