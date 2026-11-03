"""저장된 BM25·벡터 순위에 LangChain RRF를 적용해 오프라인 평가한다."""

import argparse
import hashlib
import json
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from statistics import fmean
from time import perf_counter

from langchain_core.runnables import RunnableLambda

from scripts.evaluate_bm25 import faq_documents
from scripts.evaluate_retrieval import load_cases, rank_metrics, timing_summary


AI_DIR = Path(__file__).resolve().parent.parent


def checked_records(report, field, value, cases, documents, *, require_all=False):
    """같은 질문/정답/본문의 전체 기록인지 확인한다."""
    if report.get("status") != "completed":
        raise ValueError("완료된 결과만 사용할 수 있습니다.")
    corpus = {doc.metadata["header_3"]: doc for doc in documents}
    selected = {}
    for row in report["records"]:
        if row[field] != value:
            continue
        if row["id"] in selected:
            raise ValueError("문항 ID가 중복됩니다.")
        titles = [result["title"] for result in row["results"]]
        if len(titles) != len(set(titles)) or (require_all and set(titles) != set(corpus)):
            raise ValueError("후보가 중복되거나 전체 FAQ 순위가 아닙니다.")
        for result in row["results"]:
            doc = corpus.get(result["title"])
            if doc is None or result["context"] != doc.page_content:
                raise ValueError("저장 결과와 현재 원문이 다릅니다.")
            if "chunk_id" in result and result["chunk_id"] != doc.metadata["chunk_id"]:
                raise ValueError("청크 ID가 다릅니다.")
        selected[row["id"]] = row
    if set(selected) != {case["id"] for case in cases}:
        raise ValueError("문항 집합이 다릅니다.")
    for case in cases:
        row = selected[case["id"]]
        if row["question"] != case["question"] or set(row["expected_faq_titles"]) != set(case["expected_faq_titles"]):
            raise ValueError("질문 또는 정답이 변경됐습니다.")
    return selected




def tie_bounds(ranked, expected):
    """점수 동점 안에서 정답 순서를 바꿀 때 첫 적중 순위의 범위를 구한다."""
    gold = next((row for row in ranked if row["title"] in expected), None)
    if gold is None:
        return {"best_rank": None, "worst_rank": None, "hit3_guaranteed": 0, "hit3_possible": 0}
    above = sum(row["score"] > gold["score"]+1e-15 for row in ranked)
    tied = [row for row in ranked if abs(row["score"]-gold["score"])<1e-15]
    best = above+1
    worst = above+len(tied)-sum(row["title"] in expected for row in tied)+1
    return {"best_rank": best, "worst_rank": worst, "hit3_guaranteed": int(worst<=3), "hit3_possible": int(best<=3)}


def evaluate(cases, documents, dense, bm25, *, bm25_weight=0.5, c=60):
    corpus = {doc.metadata["header_3"]: doc for doc in documents}
    records = []
    for case in cases:
        for mode in ("kiwi_base", "kiwi_user_dict"):
            bm = bm25[mode][case["id"]]
            de = dense[case["id"]]
            started = perf_counter()
            ranked = fuse(
                [corpus[row["title"]] for row in bm["results"]],
                [corpus[row["title"]] for row in de["results"]], bm25_weight=bm25_weight, c=c,
            )
            records.append({
                "id": case["id"], "question": case["question"], "mode": mode,
                "expected_faq_titles": case["expected_faq_titles"],
                **rank_metrics([row["title"] for row in ranked], case["expected_faq_titles"]),
                "tie_bounds": tie_bounds(ranked, case["expected_faq_titles"]),
                "fusion_seconds": perf_counter()-started, "results": ranked,
                "top1_tie": len(ranked)>1 and abs(ranked[0]["score"]-ranked[1]["score"])<1e-15,
                "top3_boundary_tie": len(ranked)>3 and abs(ranked[2]["score"]-ranked[3]["score"])<1e-15,
            })
    summary = {}
    for mode in bm25:
        rows = [row for row in records if row["mode"] == mode]
        summary[mode] = {
            "question_count": len(rows), "hit_at_1": fmean(row["hit_at_1"] for row in rows),
            "hit_at_3": fmean(row["hit_at_3"] for row in rows), "mrr": fmean(row["reciprocal_rank"] for row in rows),
            "fusion_seconds": timing_summary([row["fusion_seconds"] for row in rows]),
            "top1_tie_count": sum(row["top1_tie"] for row in rows),
            "top3_boundary_tie_count": sum(row["top3_boundary_tie"] for row in rows),
            "hit3_guaranteed_count": sum(row["tie_bounds"]["hit3_guaranteed"] for row in rows),
            "hit3_possible_count": sum(row["tie_bounds"]["hit3_possible"] for row in rows),
        }
    return {"summary": summary, "records": records}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dense-results", type=Path, required=True)
    parser.add_argument("--dense-collection", default="manuals_dev_openai_small")
    parser.add_argument("--bm25-results", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=AI_DIR/"manuals/delivery_faq.md")
    parser.add_argument("--dataset", type=Path, default=AI_DIR/"evaluation/datasets/faq_retrieval_v1.json")
    parser.add_argument("--split", choices=["dev", "test"], default="dev")
    parser.add_argument("--bm25-weight", type=float, default=0.5)
    parser.add_argument("--c", type=int, default=60)
    args = parser.parse_args()
    if not 0 < args.bm25_weight < 1 or args.c < 0:
        parser.error("가중치 또는 c가 올바르지 않습니다.")
    cases, selection = load_cases(args.dataset, args.split)
    source_bytes = args.source.read_bytes()
    documents = faq_documents(source_bytes.decode("utf-8"), args.source)
    dense_bytes, bm25_bytes = args.dense_results.read_bytes(), args.bm25_results.read_bytes()
    dense_report, bm25_report = json.loads(dense_bytes), json.loads(bm25_bytes)
    if dense_report["dataset_sha256"] != selection["dataset_sha256"] or bm25_report["selection"]["dataset_sha256"] != selection["dataset_sha256"]:
        raise ValueError("평가 데이터 해시가 다릅니다.")
    if bm25_report["source_sha256"] != hashlib.sha256(source_bytes).hexdigest():
        raise ValueError("BM25 원문 해시가 다릅니다.")
    dense = checked_records(dense_report, "collection", args.dense_collection, cases, documents, require_all=True)
    bm25 = {mode: checked_records(bm25_report, "mode", mode, cases, documents) for mode in ("kiwi_base", "kiwi_user_dict")}
    report = evaluate(cases, documents, dense, bm25, bm25_weight=args.bm25_weight, c=args.c)
    report.update({
        "status": "completed", "selection": selection, "split": args.split, "faq_count": len(documents),
        "dense_results": str(args.dense_results.resolve()), "bm25_results": str(args.bm25_results.resolve()),
        "dense_results_sha256": hashlib.sha256(dense_bytes).hexdigest(),
        "bm25_results_sha256": hashlib.sha256(bm25_bytes).hexdigest(),
        "dense_collection": args.dense_collection, "embedding_model": dense_report.get("embedding_model"),
        "source_sha256": hashlib.sha256(source_bytes).hexdigest(), "langchain_classic_version": version("langchain-classic"),
        "bm25_weight": args.bm25_weight, "dense_weight": 1-args.bm25_weight, "c": args.c,
        "formula": "bm25_weight/(c+bm25_rank) + dense_weight/(c+dense_rank), 순위는 1부터",
        "candidate_policy": "전체 FAQ 순위. BM25는 일치 토큰 없는 후보 제외. 한쪽에 없는 항목의 기여는 0.",
        "tie_policy": "LangChain 안정 정렬: BM25 목록 먼저, 같은 점수는 최초 등장 순서. 경계 동점 별도 집계.",
        "note": "저장 순위의 오프라인 결합 평가. API/DB 요청 및 운영 검색기 연결 없음. fusion 시간은 실제 검색 지연이 아님.",
        "bm25_configuration": {key: bm25_report[key] for key in ("bm25_parameters", "user_words", "excluded_tags", "versions")},
        "search_descriptions": bm25_report.get("search_descriptions", {}),
        "search_descriptions_sha256": bm25_report.get("search_descriptions_sha256"),
    })
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = AI_DIR/"data/private/evaluation/results"/f"rrf_{stamp}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as file:
        json.dump(report, file, ensure_ascii=False, indent=2, allow_nan=False)
    for mode, row in report["summary"].items():
        print(f"{mode}: H1={row['hit_at_1']:.1%} / H3={row['hit_at_3']:.1%} / MRR={row['mrr']:.4f} / Top3 경계 동점={row['top3_boundary_tie_count']}")
    print(f"결과 저장: {output}")


# 운영과 평가가 같은 알고리즘을 사용한다.
from app.rag.algorithms import fuse

if __name__ == "__main__":
    main()
