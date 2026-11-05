"""한글 숫자 <-> 아라비아 숫자. 예) "이백십이" -> 212, "이일이" -> 212, 212 -> "이백십이"."""
import re

DIGITS = {"영": 0, "공": 0, "일": 1, "이": 2, "삼": 3, "사": 4, "오": 5,
          "육": 6, "륙": 6, "칠": 7, "팔": 8, "구": 9}
UNITS = {"십": 10, "백": 100, "천": 1000}
# 숫자로 읽는 한글 글자(모든 곳이 이것을 쓴다 — 목록이 갈라져 "오륙오"를 못 읽은 일, 2026-11-05 통화 07f92ee3)
HANGUL_DIGITS = "".join(DIGITS)
HANGUL_NUMERALS = HANGUL_DIGITS + "".join(UNITS) + "만"


def korean_to_int(s):
    """한글(+아라비아) 숫자 -> int. 숫자로 읽을 수 없는 배열("이백십일이", "십백")이면 None — 추측한 값이 실제 번지와
    맞아 다른 주소가 기록되지 않게(예전엔 "이백십일이"를 212, "이백일이"를 202로 읽었다)."""
    if not any(c in UNITS or c == "만" for c in s):
        # 단위 없이 한 자리씩 읽은 경우: "이일이" -> 212
        return int("".join(c if c.isdigit() else str(DIGITS[c]) for c in s))
    total = section = 0
    num = last_unit = None  # num: 아직 단위가 붙지 않은 숫자, last_unit: 이 만 단위 안에서 마지막 단위(작아져야 함)
    for t in re.findall(r"\d+|\D", s):
        if t in UNITS:
            if last_unit is not None and UNITS[t] >= last_unit:
                return None  # "십백"
            if num is not None and not 0 < num < 10:
                return None  # "12백"
            section += (num or 1) * UNITS[t]
            num, last_unit = None, UNITS[t]
        elif t == "만":
            if total:
                return None  # 만이 두 번
            total = (section + (num or 0) or 1) * 10000
            section, num, last_unit = 0, None, None
        else:
            if num is not None:
                return None  # 단위 없이 숫자가 이어짐("이백십일이", "이백일이")
            num = int(t) if t.isdigit() else DIGITS[t]
            if last_unit is not None and num >= last_unit:
                return None  # 단위보다 큰 나머지("백이삼"의 "이삼"은 위에서, "이백123"은 여기서)
    return total + section + (num or 0)


DIG = "영일이삼사오육칠팔구"


def to_korean(n):
    """212 -> 이백십이, 10234 -> 만이백삼십사 (주소 읽기)."""
    out = ""
    if n >= 10000:
        q, n = divmod(n, 10000)
        out = ("" if q == 1 else to_korean(q)) + "만"
    for unit, name in ((1000, "천"), (100, "백"), (10, "십")):
        q, n = divmod(n, unit)
        if q:
            out += ("" if q == 1 else DIG[q]) + name
    return out + (DIG[n] if n else "") or "영"
