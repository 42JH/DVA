"""임시 주문(택배 하나)과 배송지. 백엔드 주문의 parcel 하나가 여기 Order 하나다(spec/backend-api.md)."""

import re

from pydantic import BaseModel

# 받는 순서의 기준이 되는 택배 항목. item은 물품(규격별 수량 또는 기타 물품 설명)을 묶어 부르는 이름이다
ORDER_FIELDS = (
    "sender_name",
    "sender_phone",
    "sender_address",
    "sender_address_detail",
    "receiver_name",
    "receiver_phone",
    "receiver_address",
    "receiver_address_detail",
    "item",
    "item_price",
)
TEXT_FIELDS = ORDER_FIELDS[:8]
PHONE_FIELDS = ("sender_phone", "receiver_phone")
# 물품 규격별 수량(백엔드 documentCount·smallBoxCount·mediumBoxCount·bigBoxCount)
COUNT_FIELDS = ("document_count", "small_box_count", "medium_box_count", "big_box_count")
PLACE_PARTS = ("name", "phone", "address", "address_detail", "geo")
# 주문의 어느 쪽이 저장된 배송지의 어느 종류인지(보내는 곳 = 출발지, 받는 곳 = 도착지)
PLACE_KIND = {"sender": "origin", "receiver": "destination"}


class Geo(BaseModel, frozen=True):
    """주소에 딸린 값(고객에게 묻지 않는다). 확정한 도로명주소를 카카오 주소 검색으로 찾아 채운다(spec/address.md)."""

    jibun_address: str
    dong_name: str
    postal_code: str
    latitude: float
    longitude: float


class Order(BaseModel):
    """접수 전 임시 주문(택배 하나). 요약·되읽기·접수의 유일한 근거. 상세 주소가 없으면 빈 문자열."""

    sender_name: str | None = None
    sender_phone: str | None = None
    sender_address: str | None = None
    sender_address_detail: str | None = None
    receiver_name: str | None = None
    receiver_phone: str | None = None
    receiver_address: str | None = None
    receiver_address_detail: str | None = None
    document_count: int | None = None
    small_box_count: int | None = None
    medium_box_count: int | None = None
    big_box_count: int | None = None
    other_item: str | None = None  # 서류·박스가 아닌 물품 설명
    item_price: int | None = None  # 물품 가액(원)
    client_comment: str | None = None  # 배송 요청 사항(묻지 않고, 말하면 기록)
    sender_geo: Geo | None = None
    receiver_geo: Geo | None = None

    def has(self, name: str) -> bool:
        if name == "item":
            return any(getattr(self, f) for f in COUNT_FIELDS) or bool(self.other_item)
        return getattr(self, name) is not None

    def missing(self) -> list[str]:
        return [f for f in ORDER_FIELDS if not self.has(f)]

    def complete(self) -> bool:
        return not self.missing()

    def empty(self) -> bool:
        return self == Order()

    def place(self, role: str) -> "Place | None":
        values = {p: getattr(self, f"{role}_{p}") for p in PLACE_PARTS}
        return None if None in (values[p] for p in PLACE_PARTS[:4]) else Place(**values)

    def set_place(self, role: str, place: "Place") -> None:
        for p in PLACE_PARTS:
            setattr(self, f"{role}_{p}", getattr(place, p))


class Place(BaseModel, frozen=True):
    """저장된 배송지(고객 주소록). 보내는 곳·받는 곳 어느 쪽에도 쓴다."""

    name: str
    phone: str
    address: str
    address_detail: str
    geo: Geo | None = None


def words(text: str | None) -> list[str]:
    return re.findall(r"[0-9A-Za-z가-힣]+", text or "")


def _contains(text: str, said: str | None, keep: int = 2) -> bool:
    """말한 낱말이 모두 들어 있음(띄어쓰기 무시). 낱말 끝의 조사·호칭 한두 글자("해운대로", "강남에서", "이영희님")는
    떼고도 본다. 뗀 뒤 keep 글자보다 짧아지면 떼지 않는다(이름은 3: "이영희"를 "이영"으로 줄여 남을 찾지 않게)."""
    squeezed = "".join(words(text))
    return all(w in squeezed or any(w[:-k] in squeezed for k in (1, 2) if len(w) - k >= keep)
               for w in words(said))


def match_places(places: list[Place], name: str | None, place: str | None, detail: str | None) -> list[Place]:
    """고객이 말한 이름·장소(지역·도로·건물)·층/호수가 모두 맞는 핀. 말하지 않은 것은 따지지 않는다."""
    out = []
    for p in places:
        where = " ".join([p.address, p.geo.jibun_address, p.geo.dong_name] if p.geo else [p.address])
        if _contains(p.name, name, keep=3) and _contains(where, place) and _contains(p.address_detail, detail):
            out.append(p)
    return out


def pin_labels(pins: list[Place]) -> list[str]:
    """후보끼리 다른 값으로 부른다(상세주소 → 주소 → 이름 순). 다이어그램의 {층수}·{상세주소}."""
    for part in ("address_detail", "address", "name"):
        values = [getattr(p, part) for p in pins]
        if all(values) and len(set(values)) == len(values):
            return values
    return [f"{p.name} {p.address} {p.address_detail}".strip() for p in pins]
