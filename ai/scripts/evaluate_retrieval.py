"""검토 완료한 FAQ 질문으로 검색 순위와 시간을 비교한다.

--dry-run은 데이터만 확인한다. 실제 실행은 질문 임베딩 API와 Qdrant 읽기를
사용하며, 자료 등록·수정·삭제나 답변 생성은 하지 않는다.
"""

import argparse
import hashlib
import json
import math
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from statistics import fmean
from time import perf_counter

from langchain_core.documents import Document


AI_DIR = Path(__file__).resolve().parent.parent


def load_cases(path: Path, split: str = "dev") -> tuple[list[dict], dict]:
    """검토 완료·답변 가능 문항만 선택하고 제외 사유를 집계한다."""
    dataset_bytes = path.read_bytes()
    rows = json.loads(dataset_bytes.decode("utf-8"))
    if not isinstance(rows, list):
        raise ValueError("평가 데이터는 JSON 배열이어야 합니다.")
    ids: set[str] = set()
    questions: set[str] = set()
    selected = []
    skipped = Counter()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("문항은 JSON 객체여야 합니다.")
        for key in ("id", "question", "split", "review_status"):
            if not isinstance(row.get(key), str) or not row[key].strip():
                raise ValueError(f"문항의 {key} 값이 올바르지 않습니다.")
        if row["id"] in ids or row["question"].strip() in questions:
            raise ValueError("문항 ID 또는 질문이 중복됩니다.")
        ids.add(row["id"])
        questions.add(row["question"].strip())
        if type(row.get("answerable")) is not bool:
            raise ValueError("answerable은 true 또는 false여야 합니다.")
        if row["review_status"] != "reviewed":
            skipped["not_reviewed"] += 1
            continue
        if row["split"] != split:
            skipped["other_split"] += 1
            continue
        if not row["answerable"]:
            skipped["unanswerable"] += 1
            continue
        titles = row.get("expected_faq_titles")
        if not isinstance(titles, list) or not titles or any(
            not isinstance(title, str) or not title.strip() for title in titles
        ):
            raise ValueError(f"{row['id']}: 정답 FAQ 제목이 필요합니다.")
        selected.append(row)
    if not selected:
        raise ValueError("평가할 검토 완료 문항이 없습니다.")
    return selected, {
        "total": len(rows), "selected": len(selected), "skipped": dict(skipped),
        "dataset_sha256": hashlib.sha256(dataset_bytes).hexdigest(),
    }


def unique_faqs(results: list[tuple[Document, float]]) -> list[dict]:
    """소개·출처 청크를 제외하고 같은 FAQ의 첫 결과만 유지한다."""
    ranked = []
    seen = set()
    for raw_rank, (document, score) in enumerate(results, start=1):
        title = document.metadata.get("header_3")
        if not isinstance(title, str) or not title.strip() or title in seen:
            continue
        seen.add(title)
        ranked.append({
            "faq_rank": len(ranked) + 1,
            "raw_rank": raw_rank,
            "title": title,
            "score": float(score),
            "point_id": str(document.metadata.get("_id", "")),
            "source": document.metadata.get("source"),
            "context": document.metadata.get("context", document.page_content),
        })
    return ranked


def rank_metrics(titles: list[str], expected: list[str]) -> dict:
    """정답이 여러 개이면 가장 먼저 찾은 정답의 순위를 채점한다."""
    rank = next((i for i, title in enumerate(titles, start=1) if title in expected), None)
    return {
        "expected_rank": rank,
        "hit_at_1": int(rank == 1),
        "hit_at_3": int(rank is not None and rank <= 3),
        "reciprocal_rank": 1.0 / rank if rank else 0.0,
    }


def timing_summary(values: list[float]) -> dict:
    """관측 시간의 평균과 최근접 순위 방식의 95백분위수를 반환한다."""
    ordered = sorted(values)
    return {
        "mean": fmean(ordered),
        "p95": ordered[math.ceil(0.95 * len(ordered)) - 1],
    }


def summarize(records: list[dict], names: list[str]) -> dict:
    summary = {}
    for name in names:
        rows = [row for row in records if row["collection"] == name]
        if not rows:
            continue
        summary[name] = {
            "question_count": len(rows),
            "hit_at_1": fmean(row["hit_at_1"] for row in rows),
            "hit_at_3": fmean(row["hit_at_3"] for row in rows),
            "mrr": fmean(row["reciprocal_rank"] for row in rows),
            "embedding_seconds": timing_summary([row["embedding_seconds"] for row in rows]),
            "retrieval_seconds": timing_summary([row["retrieval_seconds"] for row in rows]),
            "embedding_plus_retrieval_seconds": timing_summary([
                row["embedding_seconds"] + row["retrieval_seconds"] for row in rows
            ]),
        }
    return summary


def evaluate_cases(cases, stores, embed_query, fetch_limit, progress=None):
    """같은 질문 벡터로 각 컬렉션을 검색한다. 가짜 객체를 넣어 검증할 수 있다."""
    records = []
    names = list(stores)
    for index, case in enumerate(cases):
        started = perf_counter()
        vector = embed_query(case["question"])
        embedding_seconds = perf_counter() - started
        # 먼저 조회하는 컬렉션을 번갈아 바꿔 고정 순서의 영향을 줄인다.
        order = names if index % 2 == 0 else names[::-1]
        for name in order:
            started = perf_counter()
            results = stores[name].similarity_search_with_score_by_vector(vector, k=fetch_limit)
            retrieval_seconds = perf_counter() - started
            ranked = unique_faqs(results)
            records.append({
                "id": case["id"], "question": case["question"],
                "category": case.get("category", "미분류"),
                "collection": name, "expected_faq_titles": case["expected_faq_titles"],
                **rank_metrics([row["title"] for row in ranked], case["expected_faq_titles"]),
                "embedding_seconds": embedding_seconds,
                "retrieval_seconds": retrieval_seconds,
                "raw_result_count": len(results), "unique_faq_count": len(ranked),
                "results": ranked,
            })
        if progress:
            progress(index + 1, len(cases))
    return records


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=["text-embedding-3-small", "text-embedding-3-large"], default="text-embedding-3-small")
    parser.add_argument("--dataset", type=Path, default=AI_DIR / "evaluation/datasets/faq_retrieval_v1.json")
    parser.add_argument("--collections", nargs="+", default=["manuals_dev_openai_small", "manuals_dev_question_only"])
    parser.add_argument("--split", choices=["dev", "test"], default="dev")
    parser.add_argument("--fetch-limit", type=int, default=100)
    parser.add_argument("--limit", type=int, help="소수의 질문으로 먼저 동작 확인")
    parser.add_argument("--output", type=Path, help="결과 JSON을 새로 저장할 경로")
    parser.add_argument("--dry-run", action="store_true", help="데이터 검사만 수행. 외부 연결 없음")
    args = parser.parse_args()
    if args.fetch_limit < 3 or (args.limit is not None and args.limit < 1):
        parser.error("fetch-limit은 3 이상, limit은 1 이상이어야 합니다.")
    if len(set(args.collections)) != len(args.collections):
        parser.error("컬렉션 이름이 중복됩니다.")
    try:
        cases, selection = load_cases(args.dataset, args.split)
    except (ValueError, OSError) as error:
        raise SystemExit(f"데이터 확인 실패: {error}") from None
    if args.limit:
        cases = cases[:args.limit]
    print(f"전체 {selection['total']}개 / 검토 완료·답변 가능·{args.split} {selection['selected']}개")
    print(f"이번 실행: {len(cases)}문항 / 컬렉션 {len(args.collections)}개")
    if args.dry_run:
        print("데이터 확인 완료. 환경변수·API·Qdrant에 접근하지 않았습니다.")
        return

    # dry-run을 통과한 실제 실행에서만 환경변수와 API 클라이언트를 준비한다.
    from dotenv import load_dotenv
    from langchain_qdrant import QdrantVectorStore
    from qdrant_client import QdrantClient
    from app.rag.embeddings import MODEL_DIMENSIONS, create_embeddings

    load_dotenv(AI_DIR / ".env", override=False)
    api_key = os.getenv("QDRANT_API_KEY")
    if not api_key or not api_key.strip():
        raise SystemExit("QDRANT_API_KEY 환경변수를 설정하세요.")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = args.output or AI_DIR / "data/private/evaluation/results" / f"retrieval_{stamp}.json"
    if output.exists():
        raise SystemExit("결과 파일이 이미 있습니다. 다른 저장 경로를 지정하세요.")
    client = QdrantClient(url=os.getenv("QDRANT_URL", "http://127.0.0.1:6333"), api_key=api_key, timeout=30.0)
    try:
        embeddings = create_embeddings(model=args.model)
        stores = {}
        corpus = {}
        for name in args.collections:
            info = client.get_collection(name)
            vectors = info.config.params.vectors
            if isinstance(vectors, dict) or str(vectors.distance) != "Cosine":
                raise ValueError("이 평가는 이름 없는 Cosine 벡터 컬렉션을 대상으로 합니다.")
            if vectors.size != MODEL_DIMENSIONS[args.model]:
                raise ValueError("컬렉션 차원과 질문 임베딩 모델이 다릅니다.")
            corpus[name] = {"point_count": info.points_count, "vector_size": vectors.size}
            if info.points_count is None or info.points_count > args.fetch_limit:
                raise ValueError("전체 후보를 가져오려면 fetch-limit을 포인트 수 이상으로 지정하세요.")
            # 벡터 검색에서도 차원을 검증한다. 초기화 때의 불필요한 임베딩 요청은 피한다.
            stores[name] = QdrantVectorStore(client=client, collection_name=name,
                embedding=embeddings, validate_collection_config=False)
        records = evaluate_cases(cases, stores, embeddings.embed_query, args.fetch_limit,
            progress=lambda done, total: print(f"평가 진행: {done}/{total}", flush=True))
        summary = summarize(records, args.collections)
        report = {
            "started_at_utc": stamp, "split": args.split, "status": "completed",
            "dataset_sha256": selection["dataset_sha256"],
            "embedding_model": embeddings.model, "selection": selection,
            "evaluated_question_count": len(cases), "fetch_limit": args.fetch_limit,
            "corpus": corpus, "ranking_unit": "header_3가 있는 중복 없는 FAQ",
            "timing_note": "질문 임베딩 시간을 공용으로 사용. 검색에는 클라이언트 설정 확인도 포함. 초기화·답변 생성·음성 출력 제외. 질문별 1회 관측값.",
            "summary": summary, "records": records,
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        for name, result in summary.items():
            seconds = result["embedding_plus_retrieval_seconds"]
            print(f"\n{name}: {result['question_count']}문항")
            print(f"Hit@1={result['hit_at_1']:.1%} / Hit@3={result['hit_at_3']:.1%} / MRR={result['mrr']:.4f}")
            print(f"임베딩+검색 평균={seconds['mean']:.3f}초 / 관측 p95={seconds['p95']:.3f}초")
        print(f"결과 저장: {output}")
    except Exception as error:
        # 외부 예외 원문에는 접속 주소·인증값이 있을 수 있어 출력하지 않는다.
        raise SystemExit(f"평가 중단: {type(error).__name__}. 완료 점수는 저장하지 않았습니다.") from None
    finally:
        client.close()


if __name__ == "__main__":
    main()
