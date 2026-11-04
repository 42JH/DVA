"""임시 주문(택배 하나)과 배송지. 백엔드 주문의 parcel 하나가 여기 Order 하나다(spec/backend-api.md)."""

import re

from pydantic import BaseModel

from address_resolver.kakao import Geo  # 지번·동명·우편번호는 주소 모듈이 만든다

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


class CompanyPlace(Place):
    """기업 검색 후보. 소속 번호는 PIN 번호가 아니며 주문 주소에는 복사하지 않는다."""

    organization_seq: int
    organization_name: str
    membership_seq: int
    customer_seq: int
    department_seq: int | None = None
    department_name: str | None = None

    def label(self) -> str:
        return " ".join(v for v in (self.organization_name, self.department_name, self.name, self.address,
                                    self.address_detail) if v)


def words(text: str | None) -> list[str]:
    return re.findall(r"[0-9A-Za-z가-힣]+", text or "")


def _contains(text: str, said: str | None, keep: int = 2) -> bool:
    """말한 낱말이 모두 들어 있음(띄어쓰기 무시). 낱말 끝의 조사·호칭 한두 글자("해운대로", "강남에서", "이영희님")는
    떼고도 본다. 뗀 뒤 keep 글자보다 짧아지면 떼지 않는다(이름은 3: "이영희"를 "이영"으로 줄여 남을 찾지 않게)."""
    squeezed = "".join(words(text))
    return all(w in squeezed or any(w[:-k] in squeezed for k in (1, 2) if len(w) - k >= keep)
               for w in words(said))


# 장소를 가리지 않는 말: 맞지 않아도 핀을 빼지 않고 맞아도 점수로 치지 않는다
GENERIC_WORDS = {"쪽", "근처", "집", "동네", "거기", "아파트", "빌라", "건물", "회사", "주소", "거", "곳", "데"}
# 시·도 줄임말. 이것과 시·도·구·군으로 끝나는 말은 너무 넓어서 이것만 맞은 핀은 후보로 보지 않는다
SIDO_WORDS = {"서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북",
              "전남", "경북", "경남", "제주"}


def _is_region(word: str) -> bool:
    return word in SIDO_WORDS or (len(word) >= 2 and word[-1] in "시도구군")


def _word_in(squeezed: str, word: str, squeezed_jamo: str) -> bool:
    """조사 한두 글자를 떼고도 보고("해운대로", "강남에서"), 세 글자 이상이면 받아쓰기 철자 차이 자모 하나까지 본다
    ("마린씨티" ↔ "마린시티")."""
    from address_resolver.corrector import jamo, lev

    if any(w in squeezed for w in [word] + [word[:-k] for k in (1, 2) if len(word) - k >= 2]):
        return True
    if len(word) < 3:
        return False
    target = jamo(word, canon=True)
    n = len(target)
    return any(lev(target, squeezed_jamo[i:i + n + d]) <= 1
               for d in (-1, 0, 1) for i in range(max(0, len(squeezed_jamo) - n - d + 1)))


def place_score(where: str, said: str | None) -> int | None:
    """고객이 말한 장소가 핀 주소와 얼마나 비슷한지(맞은 낱말 수). 주소를 다 말하지 않아도 찾는다(맞지 않는 낱말은
    넘어간다). 비슷하지 않으면 None:
    - 말한 숫자(번지·건물번호·호수, 한글 숫자 포함)가 핀에 없다: 숫자가 다르면 다른 곳이다.
    - 시·도·구 밖의 낱말(도로·동·건물)을 말했는데 하나도 맞지 않았다: 시·구만 같은 다른 곳이다
      ("서울 강남구 테헤란로"를 강남구의 다른 핀으로 권하지 않게). 시·구만 말했으면 그것만 맞아도 된다."""
    from address_resolver.corrector import jamo, to_number

    squeezed = "".join(words(where))
    squeezed_jamo = jamo(squeezed, canon=True)
    numbers = {n.lstrip("0") for n in re.findall(r"\d+", where)}
    score, specific_said, specific_hit = 0, False, False
    for w in words(said):
        if w in GENERIC_WORDS or (len(w) == 1 and not w.isdigit()):
            continue  # "이"·"오" 같은 한 글자는 숫자로도 낱말로도 보지 않는다
        num = w if w.isdigit() else to_number(w)
        if num:  # "이백십이", "1203호"
            if num.lstrip("0") not in numbers:
                return None
            score += 1
            continue
        region = _is_region(w)
        specific_said |= not region
        if _word_in(squeezed, w, squeezed_jamo):
            score += 1
            specific_hit |= not region
    if score == 0 or (specific_said and not specific_hit):
        return None
    return score


def match_places(places: list[Place], name: str | None, place: str | None, detail: str | None) -> list[Place]:
    """고객이 말한 이름·층/호수가 맞고, 장소(지역·도로·건물)가 가장 비슷한 핀들. 말하지 않은 것은 따지지 않는다.
    장소는 일부만 말해도 된다(place_score): 비슷한 핀 중 가장 많이 맞은 것들."""
    scored = []
    for p in places:
        if not (_contains(p.name, name, keep=3) and _contains(p.address_detail, detail)):
            continue
        if not any(w not in GENERIC_WORDS and (len(w) > 1 or w.isdigit()) for w in words(place)):
            scored.append((0, p))
            continue
        where = " ".join([p.address, p.geo.jibun_address, p.geo.dong_name] if p.geo else [p.address])
        score = place_score(f"{where} {p.address_detail}", place)
        if score is not None:
            scored.append((score, p))
    best = max((s for s, _ in scored), default=0)
    return [p for s, p in scored if s == best]


def pin_labels(pins: list[Place]) -> list[str]:
    """후보끼리 다른 값으로 부른다(상세주소 → 주소 → 이름 순). 다이어그램의 {층수}·{상세주소}."""
    if any(isinstance(p, CompanyPlace) for p in pins):
        return [p.label() if isinstance(p, CompanyPlace) else f"{p.name} {p.address} {p.address_detail}".strip()
                for p in pins]
    for part in ("address_detail", "address", "name"):
        values = [getattr(p, part) for p in pins]
        if all(values) and len(set(values)) == len(values):
            return values
    return [f"{p.name} {p.address} {p.address_detail}".strip() for p in pins]
