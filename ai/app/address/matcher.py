"""STT 결과 텍스트를 도로명 사전에 대고 보정해서 실제 도로명주소를 찾는다.

흐름: 뒤쪽 숫자 토큰을 길 번호/건물번호로 해석(parse.py) -> 앞 토큰으로 지역을 정하고 -> 그 안에서 본 도로명 퍼지 매칭
      (길 번호는 읽는 소리로 비교) -> _correct(): 들은 건물번호가 실제로 있는 주소만 남겨 (도로명 거리 + 길 번호 거리)로 고르고,
      1등이 뚜렷하면 확정. 서로 다른 시군구에 걸치면 확정하지 않고 지역을 되묻는다(region_needed).
지역: 시도 -> 시군구 순으로 말하면 그 안에서만 찾는다(match_region). 시군구를 못 잡으면 전국 이름 색인(gazetteer.names)으로
      범위를 정한다(wide_scope): 시도만 말함 -> 그 시도 전체, 법정동·읍면을 말함 -> 그 동이 있는 시군구들, 아무것도 없으면 전국.
지번 주소("인의동 123-4", "선산읍 완전리 산 12")는 법정동·리 이름으로 같은 방식으로 찾고, 그 지번 건물의 도로명주소로 돌려준다.
건물명("롯데월드타워")은 도로·지번으로 못 찾았고 번호가 없을 때 부가정보 건물명으로 찾는다(building_candidates).
"""
import re
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Literal

from app.address.parse import (LETTER, branch_key, is_number_token, parse, readings, split_detail, strip_ending,
                               unlink_gil)
from app.address.phonetic import Name, distance, num_distance, read_digits, road_readings


@dataclass(frozen=True)
class Resolution:
    """보정 결과. address는 confirmed일 때만. candidates는 confirmed면 [확정 주소], ambiguous면 가까운 순 최대 3개,
    region_needed면 그 주소가 있는 지역 이름("서울특별시 양천구") 최대 3개.
    weak: 지역 없이 건물명만으로 확정했거나 지역 없이 소리를 고친 이름 하나뿐이라 되묻는 경우 — 두 번째 근거(카카오)로 가릴 수 있다."""
    status: Literal["confirmed", "ambiguous", "region_needed", "not_found"]
    address: str | None
    candidates: tuple[str, ...]
    weak: bool = False


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

    def sigungus(self, sido):
        """그 시도의 (시도, 시군구) 전부."""
        return [(sido, f"{si} {gu}".strip()) for si, gus in self.tree[sido].items() for gu in gus]

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


# --- 시군구를 못 잡았을 때의 범위: 전국 이름 색인(gazetteer.AddressDB.search_names) ------------------------
AREA_MAX = 1.0  # 시도·동 이름은 정확히 들렸을 때만 범위로 본다(시도 생략 때 시군구와 같은 규칙)
AREA_END = re.compile(r"[동리가읍면]$")  # 지역으로 볼 이름 끝(법정동·리, 읍면, 종로1가 같은 "가")


def sido_scope(db, tokens):
    """시도만 말한 경우("서울 테헤란로 212") -> (그 시도의 (시도, 시군구) 전부, 남은 토큰). 시도도 없으면 (None, tokens) = 전국.
    이름 색인이 없는 사전(RoadDict)이면 ([], []) — 지역 없이는 찾지 않는다."""
    if not hasattr(db, "search_names"):
        return [], []
    for d, sido, j in RoadDict.step(tokens, 0, db.sido_names):
        if d < AREA_MAX:
            return db.sigungus(sido), tokens[j:]
    return None, tokens


def area_regions(db, said, scopes):
    """said가 정확히(소리로) 들린 법정동·리·읍면 이름이면 그 이름이 있는 (시도, 시군구)들. 행정동 "역삼1동"은 "역삼동"으로도."""
    qs = [(Name(said), 0)] + [(Name(re.sub(r"\d+(?=동$)", "", said)), 0.5)] * bool(re.search(r"\d동$", said))
    found = {}
    for text, sido, sg in db.search_names(1, db.name_key(said), scopes):
        d = min(distance(q, Name(text)) + p for q, p in qs)
        if d < AREA_MAX and d < found.get((sido, sg), 99):
            found[(sido, sg)] = d
    return list(found)


def wide_scope(db, tokens):
    """match_region이 시군구를 못 잡았을 때의 범위 -> (scopes, 도로 쪽 남은 토큰). scopes: [] 색인 없음 / None 전국 / 지역들.
    시도 뒤(또는 맨 앞)의 1~2토큰이 동·읍·면이면 그 동이 있는 시군구들로 좁힌다("역삼동 테헤란로 212", "서울 역삼동 …")."""
    scopes, rest = sido_scope(db, tokens)
    if scopes == []:
        return [], []
    for j in (1, 2):
        if j >= len(rest):
            break
        said = "".join(rest[:j])
        if AREA_END.search(said) and (regions := area_regions(db, said, scopes)):
            return regions, rest[j:]
    return scopes, rest


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
        wide = not scopes
        if wide:  # 시군구를 못 잡음: 시도 전체·동이 있는 지역들·전국을 이름 색인으로
            scopes, rest = wide_scope(rd, tokens)
            if scopes == []:
                continue
        # 띄어쓰기가 잘못 들어가 도로명이 쪼개진 경우 대비: 끝에서 1~3토큰을 도로명으로 시도
        # 시군구와 도로 사이에 읍/면/동을 말했으면("익산시 왕궁면 ...") 짧은 분할에서 먼저 찾혀 무시됨
        for k in range(1, min(3, len(rest)) + 1):
            said = "".join(rest[-k:])
            qs = [Name(t) for t in road_readings(said)]
            if wide:
                pairs = [((sido, sg), road) for road, sido, sg in rd.search_names(0, rd.name_key(said), scopes)]
                rd.add_parts({road for _, road in pairs})
            else:
                pairs = [(key, road) for key in scopes for road in rd.roads[key]]
            for key, road in pairs:
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


def jibun_candidates(db, text):
    """지번 주소 -> [(areas.id, 산여부, 번지-호, 거리, (시도, 시군구))]. 끝 1~2토큰("인의동", "선산읍 완전리")을 법정동·리와 비교.
    시군구를 못 잡으면 시도 전체("서울 신천동 29")나 전국("역삼동 737": 그 이름의 동이 있는 지역들)에서."""
    tokens, branch, number = parse(text)[0]
    if branch is not None:  # "~길 N"은 도로명주소
        return []
    scopes, rest = db.match_region(tokens)
    if not scopes:
        scopes, rest = sido_scope(db, tokens)
        if scopes == []:
            return []
    san = int(bool(rest) and rest[-1] == "산")
    rest = rest[:-1] if san else rest
    if not rest or not AREA_END.search(rest[-1]):
        return []
    found = {}
    for k in range(1, min(2, len(rest)) + 1):
        said = "".join(rest[-k:])
        # 행정동 "역삼1동"은 법정동 "역삼동"으로도 비교. "상도1동"처럼 숫자 붙은 법정동도 있어서 원래 이름이 우선
        qs = [(Name(said), 0)] + [(Name(re.sub(r"\d+(?=동$)", "", said)), 0.5)] * bool(re.search(r"\d동$", said))
        keys = scopes if scopes is not None else area_regions(db, said, None)  # 전국: 그 이름이 (소리로) 맞는 지역만
        for key in keys:
            for area, names in db.areas(key):
                d = min(distance(q, n) + p for q, p in qs for n in names)
                if d < found.get(area, (99,))[0]:
                    found[area] = (d, key)
    return [(area, san, number, d, key) for area, (d, key) in found.items()]


def building_candidates(db, text):
    """건물명(부가정보)으로 찾기: 번호 없는 발화("롯데월드타워", "송파구 롯데월드타워")를 건물명 색인과 소리로 비교.
    복합 표기는 빌드 때 풀어 두었으므로(gazetteer.name_variants) 여기서는 같은 이름인지(거리)만 본다.
    -> {도로명주소: (거리, (시도, 시군구))}. 지역이 둘 이상이면 어차피 되묻기라 주소를 읽지 않고 이름을 자리에 넣는다(judge는 지역만 본다)."""
    tokens, branch, number = parse(text)[0]
    # 번호 토큰이 하나라도 있으면("한누리대로 2130 세종시청이요") 건물명이 아니다 — 번호는 도로·지번 경로가 본다
    if branch is not None or number or any(map(is_number_token, tokens)) or not hasattr(db, "search_names"):
        return {}
    scopes, rest = db.match_region(tokens)
    if not scopes:
        scopes, rest = sido_scope(db, tokens)
    # 지역 이름이 건물명의 일부일 수 있다("강남파이낸스센터", "서울특별시청"): 지역을 뗀 이름과 말한 전체를 둘 다 본다
    hits = []
    for scope, words in [(scopes, rest)] + ([(None, tokens)] if rest != tokens else []):
        if not words:
            continue
        said = "".join(words)
        q = Name(read_digits(said))
        hits += [(d, name, (sido, sg)) for name, sido, sg in db.search_names(2, db.name_key(said), scope)
                 if (d := distance(q, Name(read_digits(re.sub(r"[\s,.·()]", "", name))))) < 99]
    if not hits:
        return {}
    best = min(d for d, _, _ in hits)
    close = [h for h in hits if h[0] - best < MARGIN]
    if len({r for _, _, r in close}) > 1:
        return {f"{name} ({' '.join(r).strip()})": (d, r) for d, name, r in close}
    found = {}
    for d, name, r in close:
        for addr in db.named_addresses(name, [r]):
            if d < found.get(addr, (99,))[0]:
                found[addr] = (d, r)
    return found


# --- 판정 ------------------------------------------------------------------------
CONFIRM_MAX = 3.0  # 이보다 많이 고쳐야 맞는 주소는 확정하지 않고 고객에게 확인
MARGIN = 1.0       # 1등과 이만큼 이상 차이 나야 확정. 안 나면 애매함


RETRY_GROUPS = 8     # 다시 볼 표기 묶음 상한(묶음당 표기 1~2개)
RETRY_SEC = 1.0      # 다시 보기 시간 상한. 넘으면 못 찾음 — AddressService 예산(2.5초) 초과는 "장애"로 들은 값을 기록하게 되므로


def resolve(db, heard: str, clock=time.monotonic, deadline: float | None = None) -> Resolution:
    """서버가 쓰는 입구: 들은 그대로 먼저 본다(확정이면 그대로 — 고침이 기존 결과를 바꾸지 않게). 확정이 아니면
    parse.readings()의 표기 묶음을 적게 고친 것부터 본다: 못 찾았으면 처음 찾은 묶음을, 약한 결과(애매함·지역 되묻기)였으면
    확정이 나오는 묶음만 받아들이고 없으면 원래 결과를 돌려준다("킨텍스요" → 말끝을 떼면 정확한 이름).
    deadline: 여러 후보를 보는 호출자(resolve_detail)가 되읽기 시간을 함께 쓰게."""
    r = correct(db, heard)
    if r.status == "confirmed":
        return r
    deadline = deadline or clock() + RETRY_SEC
    for group in readings(heard)[:RETRY_GROUPS]:
        if clock() > deadline:
            break
        found = [x for x in (correct(db, t) for t in group) if x.status != "not_found"]
        if found:
            merged = _merge(found)
            if r.status == "not_found" or merged.status == "confirmed":
                return merged
    return r


def resolve_detail(db, heard: str, clock=time.monotonic) -> tuple[Resolution, str, str | None]:
    """들은 문장 전체(기본주소 + 상세주소)로 → (판정, 기본주소 문장, 상세주소 원문 or None). 상세가 없으면 resolve와 같다.
    확실한 경계 후보는 차례로 보고 처음 확정에서 멈춘다. 붙은 수사의 불확실한 후보는 모두 보고, 서로 다른 주소가 둘 이상
    확정되면 확정하지 않는다(애매함 → 후보 보관). 아무것도 확정되지 않으면 첫 후보로 되읽기까지 한다."""
    cands = split_detail(heard, getattr(db, "is_dong", None))
    deadline = clock() + RETRY_SEC
    if not cands:
        # 상세 없음: 말끝("십오라고요")을 먼저 떼고 본다 — 말끝이 붙은 채 첫 통과에서 엉뚱한 주소로 확정되지 않게
        group = strip_ending(heard)
        if group:
            found = [x for x in (correct(db, t) for t in group) if x.status != "not_found"]
            if found and (m := _merge(found)).status == "confirmed":
                return m, heard, None
        return resolve(db, heard, clock, deadline), heard, None
    for base, detail, sure in cands:  # 확실한 경계: 차례로, 처음 찾은 것
        if sure and (r := resolve(db, base, clock, deadline)).status != "not_found":
            return r, base, detail
    unsure = [c for c in cands if not c[2]]
    confirmed = [(r, base, detail) for base, detail, _ in unsure if (r := correct(db, base)).status == "confirmed"]
    if not confirmed:  # 첫 통과로 못 찾으면 되읽기까지(시간은 함께 씀), 처음 확정에서 멈춤
        for base, detail, _ in unsure:
            if clock() > deadline:
                break
            if (r := resolve(db, base, clock, deadline)).status == "confirmed":
                confirmed.append((r, base, detail))
                break
    if confirmed:
        addresses = tuple(dict.fromkeys(r.address for r, _, _ in confirmed))
        if len(addresses) == 1:
            return confirmed[0]
        return Resolution("ambiguous", None, addresses), confirmed[0][1], confirmed[0][2]
    base, detail, _ = cands[0]
    return correct(db, base), base, detail


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
    번호를 잘못 들었는지 없는 번호인지 구별할 수 없으니 다시 묻는다). 지번 후보도 같은 점수로 같이 비교하고,
    둘 다 없으면 건물명으로 본다. db 는 lookup()/areas()/jibun_lookup() 이 있는 gazetteer.AddressDB.
    """
    scored = {}  # 주소 -> (이름 거리, (시도, 시군구))
    for sido, sg, road, number, d in candidates(db, text, top=200):
        addr = db.lookup(sido, sg, road, number)
        if addr and d < scored.get(addr, (99,))[0]:
            scored[addr] = (d, (sido, sg))
    for area, san, number, d, key in jibun_candidates(db, text):
        for addr in db.jibun_lookup(area, san, number):
            if d < scored.get(addr, (99,))[0]:
                scored[addr] = (d, key)
    tokens = parse(text)[0][0]
    national = not db.match_region(tokens)[0] and wide_scope(db, tokens)[0] is None  # 시군구도 시도도 동도 말하지 않음
    if scored:
        return judge(scored, exact_only=national)
    # 건물명은 건축물대장 이름이라 사람들이 부르는 장소명과 다를 수 있다(부가정보의 "63빌딩"은 인천의 다른 건물) — 지역 없이 건물명만으로
    # 확정한 결과는 weak: 두 번째 근거로 가린다
    return judge(building_candidates(db, text), exact_only=national, weak_confirm=national)


def judge(scored: dict, exact_only=False, weak_confirm=False) -> Resolution:
    """1등과 MARGIN 안의 후보들로 판정: 지역이 둘 이상이면 되묻기, 하나뿐이고 가까우면 확정, 아니면 애매함.
    exact_only(지역을 전혀 안 말함): 전국엔 비슷한 소리의 이름이 늘 있어서, 소리까지 정확히 맞는 이름(거리 < 1)만 확정하고
    아니면 그 후보 지역을 되묻는다("없는로 12"가 멀리 있는 비슷한 도로로 확정되지 않게) — 이 되묻기는 weak."""
    ranked = sorted(scored.items(), key=lambda x: x[1][0])
    if not ranked:
        return NOT_FOUND
    best = ranked[0][1][0]
    close = [(addr, region) for addr, (d, region) in ranked if d - best < MARGIN]
    regions = tuple(dict.fromkeys(" ".join(r).strip() for _, r in close))
    if len(regions) > 1:  # 다른 시군구를 자동으로 고르면 오배송 — 지역을 묻는다(사용자 결정 2026-11-05)
        return Resolution("region_needed", None, regions[:3])
    if exact_only and best >= 1:
        return Resolution("region_needed", None, regions, weak=True)
    addresses = tuple(addr for addr, _ in close)[:3]
    if len(addresses) == 1 and best <= CONFIRM_MAX:
        return Resolution("confirmed", addresses[0], addresses, weak=weak_confirm)
    return Resolution("ambiguous", None, addresses)


# --- 두 번째 근거(카카오 검색 결과)로 가리기 ---------------------------------------------------------
def verify(db, text):
    """밖(카카오)에서 온 주소 문자열이 주소DB에 실제로 있는지 -> (표준 주소, (시도, 시군구)) 또는 None. 이름은 소리까지 정확히."""
    for sido, sg, road, number, d in candidates(db, text, top=3):
        if d < 1 and (addr := db.lookup(sido, sg, road, number)):
            return addr, (sido, sg)
    return None


def _same_road(db, tokens, branch, address):
    """번호를 말한 발화는 들은 도로명(길 번호 포함)과 카카오 주소의 도로명이 소리로 같아야 한다 — 번호만 같은 다른 길
    ("테헤란로 21" ← "테헤란로87길 21")을 받지 않게."""
    road = address.split()[-2]
    db.add_parts({road})
    base, road_branch = db.parts[road]
    if branch_penalty(branch, road_branch) != 0:
        return False
    return any(min(distance(Name(t), base) for t in road_readings("".join(tokens[-k:]))) < 1
               for k in (1, 2) if len(tokens) >= k)


def with_witness(db, local: Resolution, texts: list[str], heard: str) -> Resolution:
    """로컬이 못 찾았거나 약할 때(weak) 카카오가 돌려준 도로명주소들로 다시 판정. 주소DB로 검증한 것만 쓰고, 들은 건물번호가
    있으면 같은 번호만 받는다(번호를 고쳐 맞추지 않는 규칙). 로컬 확정이 있으면 그것이 1순위이고 카카오가 다른 지역을 가리키면
    되묻는다. 지역이 엇갈리면 되묻고, 한 지역이면 1순위로 확정. 검증된 게 없으면 로컬 결과 그대로."""
    tokens, branch, number = parse(heard)[0]
    found = {}
    if local.status == "confirmed" and (v := verify(db, local.address)):
        found[local.address] = v[1]
    for text in texts:
        v = verify(db, text)
        if v and (not number or (v[0].endswith(" " + number) and _same_road(db, tokens, branch, v[0]))):
            found.setdefault(v[0], v[1])
    if not found:
        return local
    regions = tuple(dict.fromkeys(" ".join(r).strip() for r in found.values()))
    if len(regions) > 1:
        return Resolution("region_needed", None, regions[:3])
    first = next(iter(found))
    return Resolution("confirmed", first, (first,))
