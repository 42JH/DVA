"""말 다듬기: 받아쓴 주소 문장 → (지역+도로명 토큰, 길 번호, 건물번호) 해석들, 그리고 못 찾았을 때 다시 볼 표기.

숫자는 위치로 해석한다: 뒤에서부터 숫자 토큰을 떼어내고, '길' 앞은 길 번호, 뒤는 건물번호.
"""

import itertools
import re

from app.address.numbers import HANGUL_DIGITS, HANGUL_NUMERALS, korean_to_int

NUM_CHARS = HANGUL_NUMERALS + "0-9"
# 도로명 뒤에 오는 숫자 토큰: "십", "이백", "10길", "십길", "길", "212번지", "212-1", "다시"
# STT가 "번길"을 "펀킬", "번낄"처럼 쓰는 경우까지
GIL = "(?:[번펀뻔]?[길낄킬])"
LETTER = "[가나다라마바사아자차카타파하까따빠싸짜]"  # "개봉로1다길"처럼 길 번호 뒤에 붙는 글자 (+STT 된소리)
TAIL_TOKEN = re.compile(rf"[{NUM_CHARS}-]*(?:{GIL}|번지|번|호)?|\d+{LETTER}{GIL}|다시|대시")


def branch_key(num, letter=""):
    return num + letter


def to_number(s):
    """'이백 십이' / '이 일 이' / '20' / '이백12' -> '212' 같은 숫자 문자열. 숫자가 없거나 숫자로 읽을 수 없는 배열이면 ''."""
    s = re.sub(r"\s|번지|번|호", "", s)
    if not s or not re.fullmatch(rf"[{NUM_CHARS}]+", s):
        return ""
    if s.isdigit():
        return s
    n = korean_to_int(s)
    return "" if n is None else str(n)


def normalize_text(text):
    # 한글 숫자는 여기서 바꾸지 않고 parse()에서 위치 보고 한꺼번에 해석 ("이백 십이"가 "200 12"로 쪼개지지 않게)
    # "테헤란로10길", "테헤란로십길" -> "테헤란로 10길" (본 도로명과 길 번호 분리)
    # 아라비아 숫자는 어떤 글자 뒤든 분리 ("인동13길"), 한글 숫자는 단어를 잘못 자를 수 있어 로/노 뒤만
    text = re.sub(rf"(\d)([번펀뻔]|{LETTER})\s+([길낄킬])(?=\s|$)", r"\1\2\3", text)  # "59번 길", "10다 길" 붙이기
    text = re.sub(rf"(?<=[가-힣])(?=\d+{LETTER}?{GIL}(?:\s|$))", " ", text)
    text = re.sub(rf"(?<=[로노])(?=[{NUM_CHARS}]+{GIL}(?:\s|$))", " ", text)
    # 지번 "123번지 4호" -> "123 다시 4호" (본번-부번), "산12" -> "산 12"
    text = re.sub(rf"번지\s*(?=[{NUM_CHARS}]+\s*호)", " 다시 ", text)
    text = re.sub(r"(?<=\s)산(?=\d)", "산 ", text)
    # "중9", "종로9" -> "중구", "종로구" (구를 숫자 9로 인식)
    return re.sub(r"(?<=[가-힣])9(?=\s)", "구", text)


def parse(text):
    """-> [(지역+본 도로명 토큰들, 길 번호 or None, 건물번호), ...] 해석 후보.

    "오천3길"의 '오천'처럼 도로명이 숫자 글자로만 돼 있을 수 있어서,
    숫자를 가장 많이 뗀 해석부터 하나씩 덜 뗀 해석까지 모두 돌려준다.
    """
    tokens = normalize_text(text).split()
    i = len(tokens)
    while i > 1 and TAIL_TOKEN.fullmatch(tokens[i - 1]):
        i -= 1
    return [split_tail(tokens[:j], " ".join(tokens[j:])) for j in range(i, len(tokens))] or [(tokens, None, "")]


def split_tail(head, tail):
    branch = None
    m = re.match(rf"(.*?)\s*{GIL}(?:\s+|$)(.*)", tail)
    lm = m and re.fullmatch(rf"(\d+)({LETTER})", m[1].replace(" ", ""))
    if m and to_number(m[1]):
        branch, tail = to_number(m[1]), m[2]
    elif lm:
        branch, tail = branch_key(lm[1], lm[2]), m[2]
    elif m:
        # 숫자 없는 '길'은 도로명 일부 ("낙산 길 250")
        head, tail = head + ["길"], m[2]
    # 부번: "이백십이 다시 일" / "212-1"
    main, _, sub = re.sub(r"\s*(?:다시|대시|-)\s*", "|", tail, count=1).partition("|")
    number = to_number(main) + (f"-{to_number(sub)}" if to_number(sub) else "")
    return head, branch, number


# --- 못 찾았을 때 다시 볼 표기 ----------------------------------------------------
NUMBER_SYLLABLES = set(HANGUL_DIGITS + "십백")


def unlink_gil(text):
    """연음으로 바뀌어 받아써진 길 번호를 되돌린다: "인동 국일" -> "인동 구길"(구길이 [구길]→"국일"로 들림).
    ㄱ받침 음절 + "일"에서 받침을 떼면 숫자 글자가 되는 경우만. 바뀐 게 없으면 None."""
    def fix(m):
        code = ord(m[1]) - 0xAC00
        if code % 28 != 1:  # 받침 ㄱ
            return m[0]
        base = chr(ord(m[1]) - 1)
        return " " + base + "길" if base in NUMBER_SYLLABLES else m[0]  # 도로명과 길 번호를 띄운다("인동국일")

    fixed = re.sub(r"([가-힣])일(?=\s|$|\d)", fix, text)
    return fixed if fixed != text else None


_GIL = re.compile(rf"(?<=[가-힣])([{HANGUL_DIGITS}십백]+번?길)(?=\s|$)")


def split_gil(heard: str) -> str | None:
    """"인동구길" → "인동 구길": 붙여 쓴 한글 길 번호를 띄운다(보정기는 띄운 "구길"만 9길로 읽는다). 바뀐 게 없으면 None.
    못 찾았을 때만 쓴다 — 아무 데서나 떼면 "구미"처럼 숫자 글자로 시작하는 이름을 자를 수 있어서."""
    spaced = _GIL.sub(r" \1", heard)
    return spaced if spaced != heard else None


# 받아쓴 그대로 넘긴 기본주소의 말끝. "이요"·"이에요"는 앞 글자에 받침이 있으면 두 가지로 읽힌다
# ("테헤란로 이일이요" = "이일이"+"요" / "이일"+"이요") — 글자만으로 못 정해서 두 해석을 다 보고 주소DB가 가린다
_ENDING = re.compile(r"\s*(입니다|이에요|예요|에요|이요|요)[.!?\s]*$")


def _has_final(ch: str) -> bool:
    return "가" <= ch <= "힣" and (ord(ch) - 0xAC00) % 28 != 0


def strip_ending(text: str) -> list[str] | None:
    """말끝을 뗀 해석 1~2개. 말끝이 없으면 None."""
    m = _ENDING.search(text)
    if not m:
        return None
    base = text[:m.start()].rstrip()
    if m[1] in ("이요", "이에요") and not base[-1:].isdigit():
        out = [base, base + "이"] if _has_final(base[-1:]) else [base + "이"]
    else:
        out = [base]
    return [x for x in out if x] or None


def _is_number(token: str) -> bool:
    return bool(re.search(r"\d", token) or to_number(token))


def cut_trailing(text: str) -> list[str] | None:
    """번호 뒤에 붙은 건물 이름 떼기: "올림픽로 300 롯데월드타워" → "올림픽로 300". 쉼표가 있으면 쉼표 앞만
    (2026-11-03 통화 98b348: "도림로143길 27, 리버뷰 신안 인스빌"). 바뀐 게 없으면 None.
    shortcut: 마지막 숫자 토큰 뒤를 모두 뗀다 — 기본주소에 "101동" 같은 상세주소가 섞이면 그대로 둔다(상세는 따로 받는다)."""
    head = text.split(",")[0].strip()
    tokens = head.split()
    last = max((i for i, t in enumerate(tokens) if i > 0 and _is_number(t)), default=None)
    if last is not None:
        if tokens[last + 1:last + 2] in (["다시"], ["대시"], ["-"]):
            return None  # 부번이 이어진다("칠 다시 삼이요") — 자르면 본번만 남아 다른 건물이 된다
        head = " ".join(tokens[:last + 1])
    return [head] if head and head != text.strip() else None


def split_dasi(text: str) -> list[str] | None:
    """숫자 사이에 붙은 부번 표시 띄우기: "칠다시삼" → "칠 다시 삼"(운영 통화 8ffabaca). 바뀐 게 없으면 None."""
    spaced = re.sub(rf"(?<=[{NUM_CHARS}])(다시|대시)(?=[{NUM_CHARS}])", r" \1 ", text)
    return [spaced] if spaced != text else None


def ga_digits(text: str) -> list[str] | None:
    """한글 숫자로 말한 "N가" 동 이름을 사전 표기로: "태평로 일가" → "태평로1가". 바뀐 게 없으면 None."""
    def digits(m):
        n = korean_to_int(m[1])
        return m[0] if n is None else f"{n}가"

    fixed = re.sub(rf"(?<=[가-힣])\s*([{HANGUL_DIGITS}십]+)가(?=\s|$)", digits, text)
    return [fixed] if fixed != text else None


_GLUED = re.compile(rf"(.*[가-힣\d][로길동리가])((?:\d[\d-]*|[{HANGUL_NUMERALS}]+(?:(?:다시|대시)[{HANGUL_NUMERALS}]+)?)"
                    rf"(?:번지|번)?)")


def split_number(text: str) -> list[str] | None:
    """이름에 붙어 받아써진 건물번호·번지 띄우기: "테헤란로212" → "테헤란로 212", "금암이동백사십구 다시 십일" →
    "금암이동 백사십구 다시 십일"(통화 3851b79d), "태평로1가31" → "태평로1가 31". 번호 바로 앞의 이름 토큰에서만,
    떼는 부분이 아라비아 숫자이거나 두 글자 이상의 한글 숫자일 때만 뗀다("강동구"의 "구" 같은 지역 이름을 자르지 않게).
    바뀐 게 없으면 None."""
    tokens = text.split()
    i = len(tokens) - 1
    while i > 0 and TAIL_TOKEN.fullmatch(tokens[i]):
        i -= 1
    m = _GLUED.fullmatch(tokens[i]) if tokens else None
    if not m:
        return None
    num = re.sub(r"번지|번", "", m[2])
    if not re.search(r"\d", num) and (len(num) < 2 or not to_number(re.split(r"다시|대시", num)[0])):
        return None
    return [" ".join(tokens[:i] + [m[1], m[2]] + tokens[i + 1:])]


def _gil(text: str) -> list[str] | None:
    spaced = split_gil(text)
    return [spaced] if spaced else None


# 못 찾았을 때 다시 볼 고침들(앞에 있을수록 먼저). 말끝은 다른 고침보다 먼저 떼야 뒤 고침이 끝 토큰을 제대로 본다
REWRITES = (strip_ending, split_number, _gil, cut_trailing, split_dasi, ga_digits)


def readings(heard: str) -> list[tuple[str, ...]]:
    """못 찾았을 때 다시 볼 표기 묶음들, 적게 고친 것부터(고침 1개 → 2개 → …). 한 묶음 안의 표기들은 똑같이 그럴듯한
    해석이다(말끝 "이요"의 두 해석) — 둘 다 실제 주소면 확정하지 않는다(matcher.resolve)."""
    out, seen = [], {heard}
    for size in range(1, len(REWRITES) + 1):
        for combo in itertools.combinations(REWRITES, size):
            texts = [heard]
            for fix in combo:  # 고침마다 실제로 바뀌어야 한다(안 바뀌는 고침이 낀 조합은 앞 조합과 같다)
                texts = [y for t in texts for y in (fix(t) or [])]
                if not texts:
                    break
            group = tuple(dict.fromkeys(t for t in texts if t not in seen))
            if group:
                seen.update(group)
                out.append(group)
    return out
