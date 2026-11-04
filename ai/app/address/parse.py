"""말 다듬기: 받아쓴 주소 문장 → (지역+도로명 토큰, 길 번호, 건물번호) 해석들, 그리고 못 찾았을 때 다시 볼 표기.

숫자는 위치로 해석한다: 뒤에서부터 숫자 토큰을 떼어내고, '길' 앞은 길 번호, 뒤는 건물번호.
"""

import re

from app.address.numbers import korean_to_int

NUM_CHARS = "영공일이삼사오육칠팔구십백천만0-9"
# 도로명 뒤에 오는 숫자 토큰: "십", "이백", "10길", "십길", "길", "212번지", "212-1", "다시"
# STT가 "번길"을 "펀킬", "번낄"처럼 쓰는 경우까지
GIL = "(?:[번펀뻔]?[길낄킬])"
LETTER = "[가나다라마바사아자차카타파하까따빠싸짜]"  # "개봉로1다길"처럼 길 번호 뒤에 붙는 글자 (+STT 된소리)
TAIL_TOKEN = re.compile(rf"[{NUM_CHARS}-]*(?:{GIL}|번지|번|호)?|\d+{LETTER}{GIL}|다시|대시")


def branch_key(num, letter=""):
    return num + letter


def to_number(s):
    """'이백 십이' / '이 일 이' / '20' / '이백12' -> '212' 같은 숫자 문자열. 숫자가 없으면 ''."""
    s = re.sub(r"\s|번지|번|호", "", s)
    if not s or not re.fullmatch(rf"[{NUM_CHARS}]+", s):
        return ""
    return s if s.isdigit() else str(korean_to_int(s))


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
NUMBER_SYLLABLES = set("영공일이삼사오육칠팔구십백")


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


_GIL = re.compile(r"(?<=[가-힣])([영공일이삼사오육칠팔구십백]+번?길)(?=\s|$)")


def split_gil(heard: str) -> str | None:
    """"인동구길" → "인동 구길": 붙여 쓴 한글 길 번호를 띄운다(보정기는 띄운 "구길"만 9길로 읽는다). 바뀐 게 없으면 None.
    못 찾았을 때만 쓴다 — 아무 데서나 떼면 "구미"처럼 숫자 글자로 시작하는 이름을 자를 수 있어서."""
    spaced = _GIL.sub(r" \1", heard)
    return spaced if spaced != heard else None


def retries(heard: str) -> list[str]:
    """못 찾았을 때 차례로 다시 볼 표기: 붙인 길 번호 띄우기, 쉼표 뒤(건물 이름) 떼기
    (2026-11-03 통화 98b348: "도림로143길 27, 리버뷰 신안 인스빌")."""
    road = heard.split(",")[0].strip() if "," in heard else ""
    out = [split_gil(heard), road if road and road != heard else None, split_gil(road) if road else None]
    return list(dict.fromkeys(x for x in out if x))
