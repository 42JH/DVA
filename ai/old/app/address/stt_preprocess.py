"""한글 숫자 <-> 아라비아 숫자. 예) "이백십이" -> 212, "이일이" -> 212, 212 -> "이백십이"."""
import re

DIGITS = {"영": 0, "공": 0, "일": 1, "이": 2, "삼": 3, "사": 4, "오": 5,
          "육": 6, "륙": 6, "칠": 7, "팔": 8, "구": 9}
UNITS = {"십": 10, "백": 100, "천": 1000}


def korean_to_int(s):
    if not any(c in UNITS or c == "만" for c in s):
        # 단위 없이 한 자리씩 읽은 경우: "이일이" -> 212
        return int("".join(c if c.isdigit() else str(DIGITS[c]) for c in s))
    total = section = num = 0
    for t in re.findall(r"\d+|\D", s):
        if t in UNITS:
            section += (num or 1) * UNITS[t]
            num = 0
        elif t == "만":
            total += (section + num or 1) * 10000
            section = num = 0
        else:
            num = int(t) if t.isdigit() else DIGITS[t]
    return total + section + num


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
