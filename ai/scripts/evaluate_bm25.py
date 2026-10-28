"""같은 FAQ와 평가 문항으로 기본/용어 보완 Kiwi의 BM25를 로컬 비교한다."""

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from statistics import fmean
from time import perf_counter

from langchain_core.documents import Document

from app.rag.chunking import split_markdown
from scripts.evaluate_retrieval import load_cases, rank_metrics, timing_summary
from scripts.kiwi_preprocessing import EXCLUDED_TAGS, USER_WORDS, tokenize_for_bm25
from scripts.search_descriptions import load_descriptions, search_documents


AI_DIR = Path(__file__).resolve().parent.parent
BM25_PARAMS = {"k1": 1.5, "b": 0.75, "epsilon": 0.25}






def evaluate(cases: list[dict], documents: list[Document], *, descriptions=None) -> dict:
    from langchain_community.retrievers import BM25Retriever

    records, summaries, indexes = [], {}, {}
    index_documents = search_documents(documents, descriptions or {})
    modes = {"kiwi_base": False, "kiwi_user_dict": True}
    for mode, use_dictionary in modes.items():
        preprocess = lambda text, flag=use_dictionary: tokenize_for_bm25(text, use_user_dictionary=flag)
        started = perf_counter()
        corpus_tokens = [preprocess(doc.page_content) for doc in index_documents]
        if any(not tokens for tokens in corpus_tokens):
            raise ValueError("토큰이 없는 FAQ가 있습니다.")
        retriever = BM25Retriever.from_documents(
            index_documents, preprocess_func=preprocess, bm25_params=BM25_PARAMS, k=len(documents),
        )
        indexes[mode] = (preprocess, corpus_tokens, retriever, perf_counter()-started)
    for index, case in enumerate(cases):
        order = list(modes) if index % 2 == 0 else list(modes)[::-1]
        for mode in order:
            preprocess, corpus_tokens, retriever, _ = indexes[mode]
            started = perf_counter()
            query_tokens = preprocess(case["question"])
            token_seconds = perf_counter()-started
            started = perf_counter()
            scores = retriever.vectorizer.get_scores(query_tokens)
            ranked = rank_bm25(documents, scores, query_tokens, corpus_tokens)
            search_seconds = perf_counter()-started
            records.append({
                "id": case["id"], "question": case["question"], "mode": mode,
                "category": case.get("category"), "expected_faq_titles": case["expected_faq_titles"],
                **rank_metrics([row["title"] for row in ranked], case["expected_faq_titles"]),
                "query_tokens": query_tokens, "tokenization_seconds": token_seconds,
                "search_seconds": search_seconds, "results": ranked,
                "top1_tie": len(ranked)>1 and abs(ranked[0]["score"]-ranked[1]["score"])<1e-12,
                "top3_boundary_tie": len(ranked)>3 and abs(ranked[2]["score"]-ranked[3]["score"])<1e-12,
            })
    for mode in modes:
        rows = [row for row in records if row["mode"] == mode]
        summaries[mode] = {
            "question_count": len(rows), "hit_at_1": fmean(row["hit_at_1"] for row in rows),
            "hit_at_3": fmean(row["hit_at_3"] for row in rows), "mrr": fmean(row["reciprocal_rank"] for row in rows),
            "index_build_seconds": indexes[mode][3],
            "query_seconds": timing_summary([row["tokenization_seconds"]+row["search_seconds"] for row in rows]),
            "empty_result_count": sum(not row["results"] for row in rows),
            "top1_tie_count": sum(row["top1_tie"] for row in rows),
            "top3_boundary_tie_count": sum(row["top3_boundary_tie"] for row in rows),
        }
    return {"summary": summaries, "records": records}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=AI_DIR/"manuals/delivery_faq.md")
    parser.add_argument("--dataset", type=Path, default=AI_DIR/"evaluation/datasets/faq_retrieval_v1.json")
    parser.add_argument("--split", choices=["dev", "test"], default="dev")
    parser.add_argument("--search-descriptions", type=Path, help="원문과 분리한 검색용 설명 JSON")
    args = parser.parse_args()
    cases, selection = load_cases(args.dataset, args.split)
    data = args.source.read_bytes()
    documents = faq_documents(data.decode("utf-8"), args.source)
    titles = {doc.metadata["header_3"] for doc in documents}
    if any(not set(case["expected_faq_titles"]) <= titles for case in cases):
        raise ValueError("원문에 없는 정답 FAQ가 있습니다.")
    descriptions = load_descriptions(args.search_descriptions, data, documents) if args.search_descriptions else {}
    report = evaluate(cases, documents, descriptions=descriptions)
    report.update({
        "status": "completed", "split": args.split, "selection": selection,
        "source_sha256": hashlib.sha256(data).hexdigest(), "faq_count": len(documents),
        "search_descriptions": descriptions,
        "search_descriptions_sha256": hashlib.sha256(args.search_descriptions.read_bytes()).hexdigest() if args.search_descriptions else None,
        "versions": {name: version(name) for name in ["kiwipiepy", "rank-bm25", "langchain-community"]},
        "bm25_parameters": BM25_PARAMS, "user_words": list(USER_WORDS), "excluded_tags": sorted(EXCLUDED_TAGS),
        "tie_policy": "동점은 chunk_id 오름차순. 동점 경계 문항은 별도 집계.",
        "note": "문서/질문 공통 전처리. 일치 단어 0개는 제외. 초기화/질문 시간 분리. dev 점수는 독립 test 성능이 아님.",
    })
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = AI_DIR/"data/private/evaluation/results"/f"bm25_{stamp}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as file:
        json.dump(report, file, ensure_ascii=False, indent=2, allow_nan=False)
    for mode, summary in report["summary"].items():
        print(f"{mode}: {summary['question_count']}문항 / Hit@1={summary['hit_at_1']:.1%} / Hit@3={summary['hit_at_3']:.1%} / MRR={summary['mrr']:.4f}")
        print(f"질문 평균={summary['query_seconds']['mean']*1000:.2f}ms / 색인 준비={summary['index_build_seconds']:.3f}초 / Top3 경계 동점={summary['top3_boundary_tie_count']}")
    print(f"결과 저장: {output}")


# 운영과 평가가 같은 알고리즘을 사용한다.
from app.rag.algorithms import faq_documents, rank_bm25

if __name__ == "__main__":
    main()
