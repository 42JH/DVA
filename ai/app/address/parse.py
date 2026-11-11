"""말 다듬기: 받아쓴 주소 문장 → (지역+도로명 토큰, 길 번호, 건물번호) 해석들, 그리고 못 찾았을 때 다시 볼 표기.

숫자는 위치로 해석한다: 뒤에서부터 숫자 토큰을 떼어내고, '길' 앞은 길 번호, 뒤는 건물번호.
"""

import itertools
import re

from app.address.numbers import UNITS, korean_to_int

NUM_CHARS = "영공일이삼사오육륙칠팔구십백천만0-9"
# 도로명 뒤에 오는 숫자 토큰: "십", "이백", "10길", "십길", "길", "212번지", "212-1", "다시"
# STT가 "번길"을 "펀킬", "번낄"처럼 쓰는 경우까지
GIL = "(?:[번펀뻔]?[길낄킬])"
LETTER = "[가나다라마바사아자차카타파하까따빠싸짜]"  # "개봉로1다길"처럼 길 번호 뒤에 붙는 글자 (+STT 된소리)
TAIL_TOKEN = re.compile(rf"[{NUM_CHARS}-]*(?:{GIL}|번지|번|호)?|\d+{LETTER}{GIL}|다시|대시")


def branch_key(num, letter=""):
    return num + letter


def is_number_token(token):
    """토큰 전체가 번호인가: "212", "217-60", "이백십이", "212번지", "10길". "63빌딩"·"2차"처럼 글자가 섞이면 아니다."""
    return bool(token and TAIL_TOKEN.fullmatch(token) and token not in ("다시", "대시") and re.search(rf"[{NUM_CHARS}]", token))


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
    text = re.sub(rf"({GIL})(?=[{NUM_CHARS}])", r"\1 ", text)  # "광양구길십이요" -> "광양구길 십이요" (길 뒤에 붙은 번호)
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


# --- 기본주소 | 상세주소 가르기(서버가 한다, 2026-11-09) -----------------------------
# 들은 문장 전체("신정이펜일로 오십삼백십이동 사백삼호요")에서 상세주소(동·호·층·건물 이름)를 뗀다. 수사가 붙어 와 경계가
# 여럿이면 가능한 자르기를 모두 돌려주고 어느 기본주소가 실존하는지는 주소DB가 가린다(matcher.resolve_detail).
SYL = "영공일이삼사오육륙칠팔구십백천"
_ANCHOR = re.compile(rf"^(지하)?([{SYL}]*|\d*)(호|층|동)$")
_LETTER_DONG = re.compile(r"^[가나다라마바사아자차카타파하]동$")
_NAME = re.compile(r"(아파트|빌라|빌딩|타워|오피스텔|캠퍼스|센터|학교|경영관|사무실|교무실|비서실|주차장|상가|플라자|점|관)$")
_VERB_TAIL = re.compile(r"\s*(?:으로|로)?\s*(?:보내|보낼|할게|할래|바꿀|해\s*주|주세요)[가-힣]*[.?!\s]*$")
_PLAIN_ENDING = re.compile(r"(이라고요|라고요|이거든요|거든요|인데요|입니다|이에요|이에유|예요|에요|이요|에서|이야|요)[.!?\s]*$")
SPLIT_MAX = 6  # 자르기 후보 상한(붙은 수사 한 덩이에서 많아야 대여섯)


def valid_numeral(s: str) -> bool:
    """읽을 수 있는 수사인가: 자릿값이 내림차순이고 숫자 글자가 연달아 오지 않는다("삼백십이"·"백이"·"삼공일" O,
    "십삼백십이"·"일오백이" X). 아라비아 숫자는 그 자체로 하나의 수(앞자리 0 불가)."""
    if not s:
        return False
    if s.isdigit():
        return s == "0" or s[0] != "0"
    if not re.fullmatch(rf"[{SYL}]+", s):
        return False
    if not any(c in UNITS for c in s):
        return True  # 한 자리씩 읽음("삼공일")
    last_unit, after_digit = 10 ** 9, False
    for c in s:
        if c in UNITS:
            if UNITS[c] >= last_unit:
                return False
            last_unit, after_digit = UNITS[c], False
        else:
            if after_digit or c in "영공":
                return False
            after_digit = True
    return True


def _number_like(token: str) -> bool:
    """기본주소의 마지막이 될 수 있는 토큰: 번호·길 번호·번지("212", "이십이", "321번길", "번지")."""
    return bool(TAIL_TOKEN.fullmatch(token)) and token not in ("다시", "대시") and (
        bool(re.search(rf"[{NUM_CHARS}]", token)) or token.endswith("번지"))


def _numeral_only(token: str) -> bool:
    return bool(re.fullmatch(rf"[{SYL}]+", token))


def _is_anchor(tokens: list[str], i: int, is_area) -> bool:
    """상세주소가 시작될 수 있는 토큰: N호·N층(항상), N동은 수사 두 음절 이상·아라비아 숫자·뒤에 호/층이 있을 때, 가~하동.
    법정동 이름("사이동")은 is_area로 뺀다."""
    t = tokens[i]
    m = _ANCHOR.fullmatch(t)
    if t.endswith("동") and is_area and is_area(t):  # 법정동 이름과 같다("이동", "사동") → 바로 뒤에 호 번호가 이어질 때만 상세
        rest = tokens[i + 1:]
        j = next((k for k, x in enumerate(rest) if _ANCHOR.fullmatch(x) and x[-1] in "호층"), None)
        if m is None or j is None or not all(_numeral_only(x) for x in rest[:j]):
            return False
        return valid_numeral("".join(rest[:j]) + _ANCHOR.fullmatch(rest[j])[2])
    if _LETTER_DONG.fullmatch(t):
        return True
    if not m:
        return False
    if m[3] in ("호", "층"):
        return bool(m[2]) or (i > 0 and _numeral_only(tokens[i - 1]))  # "오백 이 호"의 맨 "호"
    num = m[2]
    return len(num) >= 2 or num.isdigit() or any(_ANCHOR.fullmatch(x) and x[-1] in "호층" for x in tokens[i + 1:])


def clean_text(text: str) -> str:
    """상세 가르기 전 정리: 쉼표·말끝·동사 꼬리("…으로 할게요")·붙은 '다시'. "삼홉니다"(=삼호입니다)도 바로잡는다."""
    text = re.sub(r"[,，]", " ", text).replace("홉니다", "호").replace("-", " - ")
    text = re.sub(rf"(\d)(?=[{SYL}])", r"\1 ", text)  # "22-1오백이호"처럼 숫자에 붙은 한글 수사 띄우기
    text = _VERB_TAIL.sub("", text)
    text = _PLAIN_ENDING.sub("", text.strip())
    text = split_dasi(text) or [text]
    return re.sub(r"\s+", " ", text[0]).strip()


def has_numbered_address(text: str) -> bool:
    """주소 검색이 불가능해도 도로명·법정동과 건물번호·지번을 함께 말했는지 확인한다."""
    cleaned = re.sub(r"(?<=[로길동리가읍면])(?=\d)", " ", clean_text(text))
    for head, branch, number in parse(cleaned):
        place = head[:-1] if head and head[-1] == "산" else head
        if number and number[0].isdigit() and place and (
                branch is not None or re.search(r"[가-힣0-9][로길동리가읍면]$", place[-1])
                or len(place) > 1 and place[-1] == "길"):
            return True
    return False


def split_detail(text: str, is_area=None) -> list[tuple[str, str, bool]]:
    """들은 문장 → [(기본주소, 상세주소 원문, 확실한 경계인가), ...] 자르기 후보, 그럴듯한 순서. 상세가 없으면 [].
    경계가 띄어쓰기·이름 자리면 확실한 후보 하나다. 수사가 붙어 와("오십삼백십이동") 경계를 모르면 수사 안 모든 지점이
    후보이고(확실하지 않음), 어느 기본주소가 실존하는지는 주소DB가 가린다(matcher.resolve_detail)."""
    tokens = clean_text(text).split()
    anchor = next((i for i in range(1, len(tokens)) if _is_anchor(tokens, i, is_area)), None)
    last_num = max((i for i, t in enumerate(tokens[:anchor]) if i > 0 and (_number_like(t) or t in ("다시", "대시", "-"))),
                   default=None)
    if anchor is None:
        if last_num is None or last_num == len(tokens) - 1:
            return []
        return [(" ".join(tokens[:last_num + 1]), " ".join(tokens[last_num + 1:]), True)]  # 번호 뒤 이름("… 212 롯데월드타워")
    if last_num is not None and last_num + 1 < anchor:  # 번호와 표지 사이의 이름은 상세("… 다시 삼 아슬란 삼백오호")
        return [(" ".join(tokens[:last_num + 1]), " ".join(tokens[last_num + 1:]), True)]
    m = _ANCHOR.fullmatch(tokens[anchor])
    if m is None:  # 가~하동
        return [(" ".join(tokens[:anchor]), " ".join(tokens[anchor:]), True)]
    under, run, suffix = m[1] or "", m[2], m[3]
    k = anchor  # 표지 바로 앞의 수사 토큰들("오십 삼백십이동"의 "오십", "오백 이 호"의 "오백 이")도 한 덩이로 본다
    while k > 1 and _numeral_only(tokens[k - 1]):
        k -= 1
    parts, head = tokens[k:anchor], tokens[:k]
    s = "".join(parts) + run
    bounds = {sum(len(p) for p in parts[:j]) for j in range(len(parts) + 1)}  # 원래 띄어쓰기 자리
    digits = any(ch.isdigit() for ch in s)
    cands = []
    for i in sorted(range(len(s)), key=lambda i: (i not in bounds, -i if i in bounds else i)):  # 띄어쓰기 자리 → 짧은 번호부터
        if digits and i not in bounds:
            continue  # 아라비아 숫자는 자르지 않는다(이미 나뉘어 온다)
        prefix, rest = s[:i], s[i:]
        if not (valid_numeral(prefix) if prefix else head and _number_like(head[-1])) or not valid_numeral(rest):
            continue
        base = " ".join(head + ([prefix] if prefix else []))
        cands.append((base, " ".join([under + rest + suffix] + tokens[anchor + 1:]), i in bounds))
    return cands[:SPLIT_MAX]


_DETAIL_SPLIT = re.compile(rf"([{SYL}\d]+(?:동|층))(?=[{SYL}\d])")


def detail_text(raw: str) -> str:
    """상세주소의 수사를 숫자로: "삼백십이동 사백삼호" → "312동 403호", "오백 이 호" → "502호", "지하구십구층" → "지하 99층".
    이름은 그대로("소담미인 501호", "가동")."""
    text = clean_text(raw) if raw.strip() else ""
    tokens = _DETAIL_SPLIT.sub(r"\1 ", text).split()  # "일동일호" → "일동 일호"
    out, acc = [], []
    for t in tokens:
        m = _ANCHOR.fullmatch(t)
        if m and (acc or m[2]):
            num = "".join(acc) + m[2]
            if valid_numeral(num):
                n = num if num.isdigit() else str(korean_to_int(num))
                out.append(f"{m[1] + ' ' if m[1] else ''}{n}{m[3]}")
                acc = []
                continue
        if _numeral_only(t) and not _LETTER_DONG.fullmatch(t):
            acc.append(t)
            continue
        out.extend(acc)
        acc = []
        out.append(t)
    out.extend(acc)
    return " ".join(out)


# --- 못 찾았을 때 다시 볼 표기 ----------------------------------------------------
NUMBER_SYLLABLES = set("영공일이삼사오육륙칠팔구십백")


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


_GIL = re.compile(rf"(?<=[가-힣])([영공일이삼사오육륙칠팔구십백]+번?길)(?=[\s{SYL}\d]|$)")  # "광양구길십" 뒤에 붙은 번호도


def split_gil(heard: str) -> str | None:
    """"인동구길" → "인동 구길": 붙여 쓴 한글 길 번호를 띄운다(보정기는 띄운 "구길"만 9길로 읽는다). 바뀐 게 없으면 None.
    못 찾았을 때만 쓴다 — 아무 데서나 떼면 "구미"처럼 숫자 글자로 시작하는 이름을 자를 수 있어서."""
    spaced = _GIL.sub(r" \1", heard)
    return spaced if spaced != heard else None


# 받아쓴 그대로 넘긴 기본주소의 말끝. "이요"·"이에요"는 앞 글자에 받침이 있으면 두 가지로 읽힌다
# ("테헤란로 이일이요" = "이일이"+"요" / "이일"+"이요") — 글자만으로 못 정해서 두 해석을 다 보고 주소DB가 가린다
_ENDING = re.compile(r"\s*(이라고요|라고요|이거든요|거든요|인데요|입니다|이에요|예요|에요|이요|에서|이야|요)[.!?\s]*$")


def _has_final(ch: str) -> bool:
    return "가" <= ch <= "힣" and (ord(ch) - 0xAC00) % 28 != 0


def strip_ending(text: str) -> list[str] | None:
    """말끝을 뗀 해석 1~2개. 말끝이 없으면 None."""
    m = _ENDING.search(text)
    if not m:
        return None
    base = text[:m.start()].rstrip()
    if m[1] in ("이요", "이에요", "이거든요", "이라고요") and not base[-1:].isdigit():
        last = base.split()[-1] if base.split() else ""
        readable = not _numeral_only(last) or valid_numeral(last + "이")  # "이십칠이"처럼 못 읽는 수사는 해석에서 뺀다
        out = ([base] if _has_final(base[-1:]) else []) + ([base + "이"] if readable else [])
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
    fixed = re.sub(r"(?<=[가-힣])\s*([영공일이삼사오육칠팔구십]+)가(?=\s|$)",
                   lambda m: f"{korean_to_int(m[1])}가", text)
    return [fixed] if fixed != text else None


def _gil(text: str) -> list[str] | None:
    spaced = split_gil(text)
    return [spaced] if spaced else None


# 못 찾았을 때 다시 볼 고침들(앞에 있을수록 먼저). 말끝은 다른 고침보다 먼저 떼야 뒤 고침이 끝 토큰을 제대로 본다
REWRITES = (strip_ending, _gil, cut_trailing, split_dasi, ga_digits)


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
