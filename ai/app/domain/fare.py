"""배송비(notifiedPrice) 계산. 단가는 config/server.toml [fare]를 사용한다.

택배마다 서류는 최대 10개를 한 요금 단위로, 박스는 한 개씩 계산한다.
요금이 없는 규격·기타 물품이 있거나 물품이 없으면 모른다(None):
금액을 지어 말하거나 보내지 않는다(통화 결과는 INCOMPLETE).
shortcut: 규격·개수만 본다(거리·무게 할증 없음). 백엔드나 운영이 요금 규칙을 주면 그것으로 바꾼다.
"""

from collections.abc import Mapping

from app.domain.state import Items

SIZES = (("document", "document_count"), ("small_box", "small_box_count"),
         ("medium_box", "medium_box_count"), ("big_box", "big_box_count"))
DOCUMENTS_PER_FARE_UNIT = 10


def parcel_fare(snapshot: dict, table: Mapping[str, int | None]) -> int | None:
    items: Items | None = snapshot.get("items")
    if items is None:
        return None
    total = 0
    for size, field in SIZES:
        count = getattr(items, field) or 0
        if count:
            if table.get(size) is None:
                return None
            if size == "document":
                count = (count + DOCUMENTS_PER_FARE_UNIT - 1) // DOCUMENTS_PER_FARE_UNIT
            total += count * table[size]
    return total if total and not items.other_item else None
