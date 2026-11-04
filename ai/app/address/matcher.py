"""STT 결과 텍스트를 도로명 사전에 대고 보정해서 실제 도로명주소를 찾는다.

전제: 고객은 지역(시도 -> 시군구)부터 말한다. ("서울시 양천구 목동로 ...") 시도나 구는 빼고 말해도 된다.
흐름: 뒤쪽 숫자 토큰을 길 번호/건물번호로 해석(parse.py) -> 앞 토큰으로 시도를 찾고 -> 그 시도 안에서 시군구
      -> 그 시군구 안에서 본 도로명 퍼지 매칭 (길 번호는 읽는 소리로 비교)
      -> correct(): 후보 도로의 실제 건물번호와 소리 거리까지 더해 고르고, 1등이 뚜렷하면 확정
지번 주소("인의동 123-4", "선산읍 완전리 산 12")는 시군구 안의 법정동·리 이름으로 같은 방식으로 찾고,
결과는 그 지번에 있는 건물의 도로명주소로 돌려준다.
"""
import functools
import re
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Literal

from app.address.parse import LETTER, branch_key, parse, readings, unlink_gil
from app.address.phonetic import Name, distance, num_distance, read_digits, road_readings


@dataclass(frozen=True)
class Resolution:
    """보정 결과. address는 confirmed일 때만, candidates는 confirmed면 [확정 주소], ambiguous면 가까운 순 최대 3개."""
    status: Literal["confirmed", "ambiguous", "not_found"]
    address: str | None
    candidates: tuple[str, ...]


NOT_FOUND = Resolution("not_found", None, ())


# --- 도로명 사전 ---------------------------------------------------------------
def sido_aliases(sido):
    """서울특별시 -> 서울/서울시, 경상남도 -> 경남, 경기도 -> 경기 ..."""
    short = sido[0] + sido[2] if sido[:2] in ("충청", "전라", "경상") else sido[:2]
    aliases = {sido, short, short + "시", short + "도"}
    if "광주" in sido:  # 전남광주통합특별시: 광주 쪽 사람은 "광주"라고 말함
        aliases |= {"광주", "광주광역시"}  # "광주시"는 경기도 광주시와 겹쳐서 뺌
    return aliases


class RoadDict:
    def __init__(self, rows):
        self.roads = defaultdict(set)  # (시도, 시군구) -> {도로명}
        for sido, sigungu, road in rows:
            self.roads[(sido, sigungu)].add(road)
        self.parts = {}
        self.add_parts({r for rs in self.roads.values() for r in rs})
        self.set_regions(self.roads)

    def add_parts(self, roads):
        """도로명 -> (본 도로명 Name, 길 번호 or None): "테헤란로10길" -> (테헤란로, "10")"""
        for r in roads:
            if r not in self.parts:
                m = BRANCH.fullmatch(r)
                self.parts[r] = (Name(read_digits(m[1])), branch_key(m[2], m[3])) if m else (Name(read_digits(r)), None)

    def set_regions(self, keys):
        """지역 트리: 시도 -> 시·군·구 -> 구 -> (도로는 self.roads[(시도, 시군구)]).

        주소DB의 시군구명은 "강남구", "성남시 분당구" 같은 문자열 하나라 공백으로 잘라 두 단계로 만든다.
        구가 없는 시·군·구는 구 자리가 "". 세종시는 시·군·구 자리도 "".
        """
        self.tree = defaultdict(lambda: defaultdict(dict))  # 시도 -> 시 -> 구 -> 구 비교 이름들
        self.direct = defaultdict(dict)  # 시도 -> (시, 구) -> 시를 건너뛰거나 붙여 말한 구 ("분당구", "성남시분당구")
        for sido, sigungu in keys:
            si, _, gu = sigungu.partition(" ")
            self.tree[sido][si][gu] = level_names(gu)
            if gu:
                self.direct[sido][(si, gu)] = level_names(gu) + [Name(si + gu), Name(si[:-1] + gu)]
        self.sido_names = {s: [Name(a) for a in sido_aliases(s)] for s in self.tree}
        self.si_names = {s: {si: level_names(si) for si in sis} for s, sis in self.tree.items()}

    def match_region(self, tokens):
        """발화 순서대로 시도 -> 시·군·구 -> 구 트리를 타고 내려간다. 각 단계는 바로 위 단계 안에서만 찾는다.

        -> ([(시도, 시군구)], 도로 쪽 남은 토큰). 시도나 시·군·구가 안 맞으면 ([], []).
        STT가 한 이름을 두 토큰으로 쪼갤 수 있어서("서울 특별시") 단계마다 1~2토큰씩 시도한다.
        도로명 토큰이 최소 하나는 남아야 한다.
        시도를 빼고 말하면("구미시 인동9길", "강남구 테헤란로") 모든 시도에서 시·군·구부터 찾는다.
        """
        # 거리가 작은 쪽, 같으면 토큰을 더 많이 먹은 쪽("포항시"까지보다 "포항시 남구"까지). 완전히 같으면 모두 후보
        best, scopes, rest = (99, 0), [], []

        def keep(score, keys, j):
            nonlocal best, scopes, rest
            if score < best:
                best, scopes, rest = score, list(keys), tokens[j:]
            elif score == best:
                scopes += [k for k in keys if k not in scopes]

        for d1, sido, i in self.step(tokens, 0, self.sido_names):
            for d2, keys, j in self.below_sido(sido, tokens, i):
                keep((d1 + d2, len(tokens) - j), keys, j)
        if not scopes:
            # 시도를 뺐으면 시·군·구 이름은 정확히 들렸을 때만(퍼지로 엉뚱한 시도의 비슷한 이름을 잡지 않게).
            # "중구"처럼 여러 시도에 있는 이름은 모두 후보로 두고, 도로명·건물번호가 실제로 있는 쪽이 이긴다
            for sido in self.tree:
                for d, keys, j in self.below_sido(sido, tokens, 0):
                    if j > 0 and d < 1:
                        keep((d, len(tokens) - j), keys, j)
        return scopes, rest

    def below_sido(self, sido, tokens, i):
        """시도 아래 -> (거리, [(시도, 시군구)], 다 먹은 토큰 위치)들."""
        sis = self.tree[sido]
        if "" in sis:  # 세종시: 시도 바로 아래가 도로
            yield 0, [(sido, "")], i
            return
        for d, si, j in self.step(tokens, i, self.si_names[sido]):
            gus = sis[si]
            named = {g: f for g, f in gus.items() if g}
            every_gu = [(sido, f"{si} {g}") for g in named]
            if "" in gus:  # 구 없는 시·군·구("강남구", "익산시"). 시 단독 예외 행(포항시·고양시)이면 그 시의 구도 같이
                yield d, [(sido, si)] + every_gu, j
            elif named:  # 구를 빼고 말함("경기 성남시 판교역로"): 그 시의 구 전부. 구를 말한 쪽이 이기게 조금 불리하게
                yield d + GU_SKIP, every_gu, j
            for d3, gu, k in self.step(tokens, j, named):
                yield d + d3, [(sido, f"{si} {gu}")], k
        # 시를 건너뛰거나("경기 분당구") 시·구를 붙여 말함("성남시분당구")
        for d, (si, gu), j in self.step(tokens, i, self.direct[sido]):
            yield d, [(sido, f"{si} {gu}")], j

    @staticmethod
    def step(tokens, i, options):
        """tokens[i:]의 앞 1~2토큰과 가장 가까운 options 키 -> (거리, 키, 다음 위치)들. 도로 토큰 하나는 남김."""
        for j in (i + 1, i + 2):
            if j >= len(tokens):
                break
            d, keys = closest(Name("".join(tokens[i:j])), options)
            for k in keys:
                yield d, k, j


GU_SKIP = 0.5  # 구를 빼고 말한 경우의 불이익(구를 말했으면 그쪽 우선)


def level_names(name):
    """한 단계 이름의 비교 형태: 금산군 -> 금산군/금산, 분당구 -> 분당구/분당. 위 단계 안에서만 비교해서 줄여도 덜 겹침."""
    names = [Name(name)]
    if len(name) >= 3 and name[-1] in "시군구":
        names.append(Name(name[:-1]))
    return names


def closest(q, options):
    """{키: [Name]} 중 q와 가장 가까운 키들 -> (거리, [키]). 허용 거리 안에 없으면 (99, [])."""
    scored = {k: min(distance(q, f) for f in forms) for k, forms in options.items()}
    best = min(scored.values(), default=99)
    return best, [k for k, d in scored.items() if d == best < 99]


# --- 후보 찾기 -------------------------------------------------------------------
BRANCH = re.compile(rf"(.+?)(\d+)({LETTER}?)(?:번길|길)")  # 사전 도로명 "테헤란로10길" -> ("테헤란로", "10")
BRANCH_KEY = re.compile(r"(\d+)(\D?)")  # branch_key() 결과 "1다" -> ("1", "다")
BRANCH_MAX = 1.5  # 길 번호는 자모 한 개 차이까지 (1길/2길 = 일/이)
# STT가 헷갈리는 1다길/1타길/1따길, 1나길/1라길. 1나길과 1라길이 둘 다 있는 도로가 있어서 정확히 같은 게 없을 때만 씀
LETTER_CANON = str.maketrans("카타파차까따빠싸짜라", "가다바자가다바사자나")


def branch_penalty(query, road):
    """길 번호 비교: 같으면 0, 가나다 글자가 소리가 비슷하면 +0.5, 숫자는 읽는 소리 거리. 멀면 None(후보 아님)."""
    if query == road:
        return 0
    if not (query and road):
        return None
    (qn, ql), (rn, rl) = BRANCH_KEY.fullmatch(query).groups(), BRANCH_KEY.fullmatch(road).groups()
    if ql.translate(LETTER_CANON) != rl.translate(LETTER_CANON):
        return None
    d = 0.5 * (ql != rl) + num_distance(qn, rn)
    return d if d <= BRANCH_MAX else None


def candidates(rd, text, top=5):
    """보정된 (시도, 시군구, 도로명, 건물번호, 점수) 후보 목록, 점수 낮을수록 좋음."""
    for tokens, branch, number in parse(text):
        found = {}
        scopes, rest = rd.match_region(tokens)
        # 띄어쓰기가 잘못 들어가 도로명이 쪼개진 경우 대비: 끝에서 1~3토큰을 도로명으로 시도
        # 시군구와 도로 사이에 읍/면/동을 말했으면("익산시 왕궁면 ...") 짧은 분할에서 먼저 찾혀 무시됨
        for k in range(1, min(3, len(rest)) + 1):
            qs = [Name(t) for t in road_readings("".join(rest[-k:]))]
            for key in scopes:
                for road in rd.roads[key]:
                    base, road_branch = rd.parts[road]
                    penalty = branch_penalty(branch, road_branch)
                    if penalty is None:
                        continue
                    d = min(distance(q, base) for q in qs) + penalty
                    if d < found.get((key, road), 99):
                        found[(key, road)] = d
            # 발음 정규화 거리 0인 후보(점수 < 1)를 찾았으면 더 긴 분할은 안 봄
            if found and min(found.values()) < 1:
                break
        if found:  # 이 숫자 해석으로 도로를 찾았으면 다음 해석은 안 봄
            break
    ranked = sorted(found.items(), key=lambda x: x[1])[:top]
    return [(sido, sg, road, number, round(d, 2)) for ((sido, sg), road), d in ranked]


AREA_END = re.compile(r"[동리가]$")  # 지번 주소로 볼 이름 끝 (법정동·리, 종로1가 같은 "가")


def jibun_candidates(db, text):
    """지번 주소 -> [(areas.id, 산여부, 번지-호, 거리)]. 끝 1~2토큰("인의동", "선산읍 완전리")을 법정동·리와 비교."""
    tokens, branch, number = parse(text)[0]
    if branch is not None:  # "~길 N"은 도로명주소
        return []
    scopes, rest = db.match_region(tokens)
    san = int(bool(rest) and rest[-1] == "산")
    rest = rest[:-1] if san else rest
    if not rest or not AREA_END.search(rest[-1]):
        return []
    found = {}
    for k in range(1, min(2, len(rest)) + 1):
        said = "".join(rest[-k:])
        # 행정동 "역삼1동"은 법정동 "역삼동"으로도 비교. "상도1동"처럼 숫자 붙은 법정동도 있어서 원래 이름이 우선
        qs = [(Name(said), 0)] + [(Name(re.sub(r"\d+(?=동$)", "", said)), 0.5)] * bool(re.search(r"\d동$", said))
        for key in scopes:
            for area, names in db.areas(key):
                d = min(distance(q, n) + p for q, p in qs for n in names)
                if d < found.get(area, 99):
                    found[area] = d
    return [(area, san, number, d) for area, d in found.items()]


# --- 판정 ------------------------------------------------------------------------
CONFIRM_MAX = 3.0  # 이보다 많이 고쳐야 맞는 주소는 확정하지 않고 고객에게 확인
MARGIN = 1.0       # 1등과 이만큼 이상 차이 나야 확정. 안 나면 애매함


def number_distance(heard, real):
    """건물번호 "본번-부번" 둘의 거리(읽는 소리 기준이라 "07"과 "7"은 0). 부번을 안 말한 것도 거리로 친다."""
    hm, _, hs = heard.partition("-")
    rm, _, rs = real.partition("-")
    return num_distance(hm, rm) + num_distance(hs, rs)


RETRY_GROUPS = 8     # 다시 볼 표기 묶음 상한(묶음당 표기 1~2개)
RETRY_SEC = 1.0      # 다시 보기 시간 상한. 넘으면 못 찾음 — AddressService 예산(2.5초) 초과는 "장애"로 들은 값을 기록하게 되므로


def resolve(db, heard: str, clock=time.monotonic) -> Resolution:
    """서버가 쓰는 입구: 들은 그대로 먼저 본다(찾으면 그대로 — 고침이 기존 결과를 바꾸지 않게). 못 찾았을 때만
    parse.readings()의 표기 묶음을 적게 고친 것부터 보고, 처음 찾은 묶음에서 멈춘다."""
    r = correct(db, heard)
    if r.status != "not_found":
        return r
    deadline = clock() + RETRY_SEC
    for group in readings(heard)[:RETRY_GROUPS]:
        if clock() > deadline:
            break
        found = [x for x in (correct(db, t) for t in group) if x.status != "not_found"]
        if found:
            return _merge(found)
    return NOT_FOUND


def _merge(found: list[Resolution]) -> Resolution:
    """같은 묶음(똑같이 그럴듯한 해석)에서 찾은 결과 합치기: 확정이 있으면 확정만 보고, 서로 다른 주소면 확정하지 않는다."""
    picked = [x for x in found if x.status == "confirmed"] or found
    addresses = tuple(dict.fromkeys(a for x in picked for a in x.candidates))
    if len(picked) == 1 or len(addresses) == 1:
        return picked[0]
    return Resolution("ambiguous", None, addresses[:3])


def correct(db, text) -> Resolution:
    """못 찾으면 연음으로 바뀐 길 번호를 되돌려 한 번 더(기존 결과는 그대로 두고 못 찾을 때만)."""
    result = _correct(db, text)
    if result.status == "not_found" and (fixed := unlink_gil(text)):
        return _correct(db, fixed)
    return result


def _correct(db, text) -> Resolution:
    """도로 후보마다 들은 건물번호(지번)가 실제로 있는 주소만 남겨 (도로명 거리 + 길 번호 거리)가 가장 작은 주소를 고른다.
    건물번호를 고쳐야만 맞는 주소는 후보가 아니다(사용자 결정 2026-11-05: 없는 "테헤란로 210"을 510으로 기록하던 문제 —
    번호를 잘못 들었는지 없는 번호인지 구별할 수 없으니 다시 묻는다). 1등이 뚜렷하지 않으면 확정하지 않는다.
    지번 후보도 같은 점수로 같이 비교한다. db 는 numbers()/areas()/jibun_numbers() 가 있는 gazetteer.AddressDB.
    """
    # (이름 거리, 들은 번호, 실제 (번호, 주소) 목록 읽기)
    sources = [(d, number, functools.partial(db.numbers, sido, sigungu, road))
               for sido, sigungu, road, number, d in candidates(db, text, top=30)]
    sources += [(d, number, functools.partial(db.jibun_numbers, area, san))
                for area, san, number, d in jibun_candidates(db, text)]
    sources.sort(key=lambda x: x[0])
    scored = {}
    for d, number, numbers in sources:
        if d > sources[0][0] + CONFIRM_MAX:  # 이름부터 1등보다 훨씬 먼 후보는 볼 필요 없음
            break
        for real, address in numbers():
            if number_distance(number, real) == 0 and d < scored.get(address, 99):
                scored[address] = d
    ranked = sorted(scored.items(), key=lambda x: x[1])
    if not ranked:
        return NOT_FOUND
    best = ranked[0][1]
    close = tuple(a for a, c in ranked if c - best < MARGIN)[:3]
    if len(close) == 1 and best <= CONFIRM_MAX:
        return Resolution("confirmed", close[0], close)
    return Resolution("ambiguous", None, close)
