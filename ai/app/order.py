"""임시 주문과 배송지."""

from pydantic import BaseModel

# 받는 순서의 기준이 되는 주문 항목. DB 컬럼 이름과 같다(SQL 컬럼은 이 목록으로만 만든다).
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
)
PHONE_FIELDS = ("sender_phone", "receiver_phone")
PLACE_PARTS = ("name", "phone", "address", "address_detail")
# 주문의 어느 쪽이 저장된 배송지의 어느 종류인지(보내는 곳 = 출발지, 받는 곳 = 도착지)
PLACE_KIND = {"sender": "origin", "receiver": "destination"}


class Order(BaseModel):
    """접수 전 임시 주문. 요약·되읽기·접수의 유일한 근거. 상세 주소가 없으면 빈 문자열."""

    sender_name: str | None = None
    sender_phone: str | None = None
    sender_address: str | None = None
    sender_address_detail: str | None = None
    receiver_name: str | None = None
    receiver_phone: str | None = None
    receiver_address: str | None = None
    receiver_address_detail: str | None = None
    item: str | None = None

    def missing(self) -> list[str]:
        return [f for f in ORDER_FIELDS if getattr(self, f) is None]

    def complete(self) -> bool:
        return not self.missing()

    def place(self, role: str) -> "Place | None":
        values = {p: getattr(self, f"{role}_{p}") for p in PLACE_PARTS}
        return None if None in values.values() else Place(**values)

    def set_place(self, role: str, place: "Place") -> None:
        for p in PLACE_PARTS:
            setattr(self, f"{role}_{p}", getattr(place, p))


class Place(BaseModel, frozen=True):
    """저장된 배송지(보내는 곳·받는 곳 어느 쪽에도 쓴다)."""

    name: str
    phone: str
    address: str
    address_detail: str
