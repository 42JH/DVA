"""소리 비교: 한글 자모 분해·발음 정규화·편집거리. 주소 보정(matcher)과 주소록 장소 매칭(backend_client.place_score)이 같이 쓴다."""

import functools
import re

from app.address.numbers import DIG, to_korean

CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
JONG = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"
# STT가 헷갈리는 소리를 같은 글자로 묶는다 (비음화/유음화/된소리/ㅐㅔ 등)
CHO_CANON = str.maketrans("ㄲㄸㅃㅆㅉㄹ", "ㄱㄷㅂㅅㅈㄴ")
JUNG_CANON = str.maketrans("ㅐㅒㅖㅙㅞ", "ㅔㅔㅔㅚㅚ")
JONG_CANON = str.maketrans("ㄲㅋㄳㄺㄱㄷㅅㅆㅈㅊㅌㅎㅂㅍㅄㄿ", "ㅇㅇㅇㅇㅇㄴㄴㄴㄴㄴㄴㄴㅁㅁㅁㅁ")


def jamo(s, canon=False):
    syl = []
    for c in s:
        code = ord(c) - 0xAC00
        syl.append([CHO[code // 588], JUNG[code % 588 // 28], JONG[code % 28].strip()] if 0 <= code < 11172 else c)
    if canon:
        for i, x in enumerate(syl):
            if isinstance(x, str):
                continue
            nxt = syl[i + 1] if i + 1 < len(syl) and not isinstance(syl[i + 1], str) else None
            # 연음: 받침 뒤에 ㅇ으로 시작하는 음절이 오면 받침이 넘어감 (인의동 -> 이늬동, 좋은 -> 조은)
            if nxt and nxt[0] == "ㅇ" and x[2] and x[2] != "ㅇ":
                if x[2] != "ㅎ" and x[2] in CHO:
                    nxt[0] = x[2]
                if x[2] == "ㅎ" or x[2] in CHO:
                    x[2] = ""
            if i and x[1] == "ㅢ":  # 첫 음절이 아닌 ㅢ는 [ㅣ] (이늬 -> 이니)
                x[1] = "ㅣ"
            x[:] = x[0].translate(CHO_CANON), x[1].translate(JUNG_CANON), x[2].translate(JONG_CANON)
    return "".join(x if isinstance(x, str) else "".join(x) for x in syl)


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


class Name:
    """비교용으로 자모 형태를 미리 계산해 둔 이름."""
    __slots__ = ("text", "raw", "canon")

    def __init__(self, text):
        self.text, self.raw, self.canon = text, jamo(text), jamo(text, canon=True)


def distance(q, cand):
    """발음 정규화 거리 + 원래 자모 거리 약간 (같은 발음이면 철자가 가까운 쪽 우선)."""
    if abs(len(q.canon) - len(cand.canon)) > allowed(cand):
        return 99
    d = lev(q.canon, cand.canon)
    return 99 if d > allowed(cand) else d + 0.3 * lev(q.raw, cand.raw)


def allowed(cand):
    return max(2, len(cand.canon) // 4)


def read_digits(text):
    """도로명 안의 숫자를 읽는 소리로: "신정이펜1로" -> "신정이펜일로". 사전 도로명 쪽(값으로 읽는다)."""
    return re.sub(r"\d+", lambda m: to_korean(int(m[0])), text)


def road_readings(text):
    """들은 도로명의 숫자를 읽을 수 있는 소리 전부: "신정201로" -> 신정이백일로·신정이공일로, "신정2-1로" -> 신정이일로.
    모델이 "이펜일로"를 "2-1로"·"201로"처럼 숫자로 옮겨 적으면 소리 비교가 안 돼서(2026-10-28 통화) 숫자를 소리로 되돌린다."""
    if not re.search(r"\d", text):
        return [text]
    value = re.sub(r"\d+", lambda m: to_korean(int(m[0])), text.replace("-", ""))
    each = re.sub(r"\d", lambda m: "공" if m[0] == "0" else DIG[int(m[0])], text.replace("-", ""))
    split = re.sub(r"\d+", lambda m: to_korean(int(m[0])), text).replace("-", "")  # "2-1" -> 이일(값마다)
    return list(dict.fromkeys([value, each, split]))


@functools.cache
def spoken(num):
    """숫자 문자열을 읽는 소리로: "212" -> 이백십이. 일/이, 삼/사처럼 소리로 헷갈리는 걸 거리로 재려고."""
    return Name(to_korean(int(num)) if num else "")


def num_distance(a, b):
    """숫자 둘을 읽는 소리의 거리: 211 vs 212(이백십일/이백십이) 1.3, 112 vs 212(백십이/이백십이) 2.6."""
    if a == b:
        return 0
    x, y = spoken(a), spoken(b)
    return lev(x.canon, y.canon) + 0.3 * lev(x.raw, y.raw)
