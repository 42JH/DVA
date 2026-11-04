"""진단할 FAQ의 본문·저장 벡터를 읽고 선택적으로 재임베딩과 비교한다.

기본 실행은 Qdrant 읽기만 한다. --reembed는 OpenAI API를 호출하며
DB에서 가져온 본문을 그대로 재임베딩한다. DB는 변경하지 않는다.
"""

import argparse
import math
import os
from collections.abc import Callable
from pathlib import Path

from qdrant_client import QdrantClient, models


TARGET_TITLES = (
    "Q. 요금은 얼마인가요?",
    "Q. 착불도 되나요?",
    "Q. 수거는 언제 오나요?",
    "Q. 어느 택배사로 가나요?",
)


def vector_norm(vector: list[float], *, expected_size: int = 1536) -> float:
    """현재 컬렉션의 벡터 형식을 확인하고 길이를 계산한다."""
    if not isinstance(vector, list) or len(vector) != expected_size:
        raise ValueError(f"이름 없는 {expected_size}차원 벡터가 필요합니다.")
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in vector):
        raise ValueError("벡터에 유효하지 않은 숫자가 있습니다.")
    norm = math.hypot(*vector)
    if not math.isfinite(norm) or norm == 0:
        raise ValueError("벡터 길이가 0이거나 유효하지 않습니다.")
    return norm


def compare_embeddings(
    rows: list[dict],
    embed_documents: Callable[[list[str]], list[list[float]]],
) -> list[dict]:
    """DB 본문을 그대로 재임베딩해 같은 포인트의 저장 벡터와 비교한다."""
    if not rows:
        raise ValueError("비교할 본문이 없습니다.")
    stored_norms = [vector_norm(row["vector"]) for row in rows]
    # strip/줄바꿈 치환 등으로 원래 임베딩 입력을 바꾸지 않는다.
    new_vectors = embed_documents([row["text"] for row in rows])
    if len(new_vectors) != len(rows):
        raise ValueError("반환된 임베딩 개수가 본문 개수와 다릅니다.")
    comparisons = []
    for row, stored_norm, new_vector in zip(rows, stored_norms, new_vectors, strict=True):
        new_norm = vector_norm(new_vector)
        stored_unit = [value / stored_norm for value in row["vector"]]
        new_unit = [value / new_norm for value in new_vector]
        cosine = math.fsum(x * y for x, y in zip(stored_unit, new_unit, strict=True))
        comparisons.append({
            "id": row["id"],
            "title": row["title"],
            # 소수점 계산의 반올림으로 1을 아주 조금 넘는 경우만 보정한다.
            "cosine": max(-1.0, min(1.0, cosine)),
            "stored_norm": stored_norm,
            "new_norm": new_norm,
            "normalized_max_difference": max(
                abs(x - y) for x, y in zip(stored_unit, new_unit, strict=True)
            ),
        })
    return comparisons


def read_target_points(client: QdrantClient, collection: str) -> list[models.Record]:
    """다음 페이지가 없어질 때까지 지정 FAQ의 포인트를 읽는다."""
    points = []
    offset = None
    while True:
        batch, offset = client.scroll(
            collection_name=collection,
            scroll_filter=models.Filter(must=[
                models.FieldCondition(
                    key="metadata.header_3",
                    match=models.MatchAny(any=list(TARGET_TITLES)),
                )
            ]),
            limit=100,
            offset=offset,
            with_payload=True,
            with_vectors=True,
        )
        points.extend(batch)
        if offset is None:
            return points


def inspect_points(points: list[models.Record]) -> list[dict]:
    """본문·벡터의 기본 형식과 대상 FAQ 포함 여부를 확인한다."""
    rows = []
    for point in points:
        payload = point.payload or {}
        metadata = payload.get("metadata")
        if not isinstance(metadata, dict):
            raise ValueError("metadata가 없습니다.")
        title = metadata.get("header_3")
        text = payload.get("page_content")
        vector = point.vector
        if title not in TARGET_TITLES or not isinstance(text, str) or not text.strip():
            raise ValueError("대상 제목 또는 본문이 올바르지 않습니다.")
        # 현재 컬렉션은 이름 없는 1536차원 dense 벡터를 사용한다.
        vector_norm(vector)
        rows.append({"id": str(point.id), "title": title, "text": text, "vector": vector})
    if set(TARGET_TITLES) != {row["title"] for row in rows}:
        raise ValueError("진단 대상 FAQ 4종 중 일부가 없습니다.")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collection", default="manuals_dev_openai_small")
    parser.add_argument(
        "--reembed", action="store_true",
        help="가져온 본문을 OpenAI로 재임베딩해 비교합니다(API 비용 발생).",
    )
    args = parser.parse_args()

    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)
    api_key = os.getenv("QDRANT_API_KEY")
    if not api_key or not api_key.strip():
        raise SystemExit("QDRANT_API_KEY 환경변수를 설정하세요.")

    client = QdrantClient(
        url=os.getenv("QDRANT_URL", "http://127.0.0.1:6333"),
        api_key=api_key,
        timeout=30.0,
    )
    try:
        rows = inspect_points(read_target_points(client, args.collection))
        print(f"컬렉션: {args.collection}")
        print(f"대상 FAQ: 4종 / 읽은 포인트: {len(rows)}개")
        for row in sorted(rows, key=lambda item: (TARGET_TITLES.index(item["title"]), item["id"])):
            print(f"\n제목: {row['title']}\nID: {row['id']}")
            print(f"본문:\n{row['text']}")
            print(f"벡터 차원: {len(row['vector'])}")
            print(f"벡터 앞쪽 5개: {row['vector'][:5]}")
        if args.reembed:
            from app.rag.embeddings import create_embeddings

            embeddings = create_embeddings()
            print(f"\n재임베딩 모델: {embeddings.model} / 본문 {len(rows)}개")
            comparisons = compare_embeddings(rows, embeddings.embed_documents)
            for comparison in comparisons:
                print(f"\n비교: {comparison['title']} / ID: {comparison['id']}")
                print(f"코사인 유사도: {comparison['cosine']:.12f}")
                print(f"저장/새 벡터 길이: {comparison['stored_norm']:.9f} / {comparison['new_norm']:.9f}")
                print(f"길이를 맞춘 뒤 최대 숫자 차이: {comparison['normalized_max_difference']:.3e}")
            print("\n비교 완료. 1에 가까울수록 방향이 같습니다. 이 결과만으로 전체 DB나 검색 순위의 정합성을 확정하지 않습니다.")
        else:
            print("\n본문·벡터 읽기 및 기본 형식 확인 완료. 재임베딩 대응 검증은 아직 하지 않았습니다.")
    except Exception as error:
        # 외부 예외에는 접속 정보가 포함될 수 있으므로 종류만 출력한다.
        raise SystemExit(f"벡터 진단 실패: {type(error).__name__}") from None
    finally:
        client.close()


if __name__ == "__main__":
    main()
