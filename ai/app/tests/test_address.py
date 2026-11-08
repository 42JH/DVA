"""주소 보정(app/address): 보정기 자체(도로 사전·작은 주소DB)와 카카오 지번·우편번호. record_fields에 붙은 동작은 test_tools.
보정기 사례는 kakao_map_test의 자체 테스트를 옮긴 것이다. 실제 주소DB(data/address.db) 없이 돈다."""

import csv
from pathlib import Path

import httpx2
import pytest
from conftest import run

from app.address.gazetteer import AddressDB, open_db
from app.address.matcher import NOT_FOUND, RoadDict, candidates, correct
from app.address.phonetic import jamo
from app.domain.state import Geo
from app.integrations import kakao
from app.integrations.address import AddressService
from app.tests.address_sample_db import build_sample_db

REAL_GEOCODE = kakao.geocode  # fake_kakao 픽스처가 바꾸기 전 진짜 함수

DATA = Path(__file__).parent / "fixtures"


# --- 보정기: 지역 트리·도로명 퍼지 매칭 ---

@pytest.fixture(scope="module")
def rd():
    with open(DATA / "roads_sample.csv", encoding="utf-8") as f:
        rows = [tuple(r) for r in csv.reader(f)][1:]
    # 실제처럼 대로에 N길이 줄줄이 붙어 있는 상황
    rows += [("서울특별시", "강남구", f"테헤란로{i}길") for i in range(1, 41)]
    # 가나다 길, 숫자 글자로만 된 도로명 (테스트용 가상 배치)
    rows += [("서울특별시", "강남구", r) for r in ("개봉로1나길", "개봉로1다길", "개봉로1라길", "오천3길", "오천길")]
    # 도로명 안에 숫자가 있는 도로(이펜1로)와 비슷한 이름들
    rows += [("서울특별시", "양천구", r) for r in ("신정이펜1로", "신정이펜2로", "신정로", "신정중앙로")]
    return RoadDict(rows)


@pytest.mark.parametrize("heard, want", {
    "서울 강남구 태헤란로 212": ("강남구", "테헤란로", "212"),
    "서울 강남구 대핸란로 212": ("강남구", "테헤란로", "212"),
    "서울 강남구 테헤란노 이백십이번지": ("강남구", "테헤란로", "212"),
    "서울시 강남구 테헤란로 212": ("강남구", "테헤란로", "212"),
    "서울특별시 강남구 테헤란로 212": ("강남구", "테헤란로", "212"),
    "서울 특별시 강남구 테헤란로 212": ("강남구", "테헤란로", "212"),
    "서울 강남 테헤란로 212": ("강남구", "테헤란로", "212"),
    "서울 중9 세종대로 110": ("중구", "세종대로", "110"),
    "서울 중고 세종대로 110": ("중구", "세종대로", "110"),
    "서울 중구 세종 대로 백십": ("중구", "세종대로", "110"),
    "서울 중구 세정대로 110": ("중구", "세종대로", "110"),
    "서울 송파구 올림핑노 300": ("송파구", "올림픽로", "300"),
    "서울 종로9 사징노 161": ("종로구", "사직로", "161"),
    "경기 성남시 분당구 판교영노 166": ("성남시 분당구", "판교역로", "166"),
    "경기도 성남시 분당구 판교 역로 백육십육": ("성남시 분당구", "판교역로", "166"),
    "경기 분당구 판교역로 166": ("성남시 분당구", "판교역로", "166"),
    "경기 성남시분당구 판교역로 166": ("성남시 분당구", "판교역로", "166"),
    "서울 강남구 테헤란로 팔길 이십": ("강남구", "테헤란로8길", "20"),
    "서울 강남구 테헤란로 이백십이 다시 일": ("강남구", "테헤란로", "212-1"),
    "서울 강남구 테헤란로 이백 십이": ("강남구", "테헤란로", "212"),
    "서울 강남구 테헤란로 이 일 이": ("강남구", "테헤란로", "212"),
    "서울 영등포구 의사당대로 일": ("영등포구", "의사당대로", "1"),
    "경기 성남 분당구 불쩡노 육": ("성남시 분당구", "불정로", "6"),
    "서울 강남구 테헤란로 십길 이십": ("강남구", "테헤란로10길", "20"),
    "서울 강남구 테헤란로 십 길 이십": ("강남구", "테헤란로10길", "20"),
    "서울 강남구 테헤란로십길 이십": ("강남구", "테헤란로10길", "20"),
    "서울 강남구 테헤란로10길 20": ("강남구", "테헤란로10길", "20"),
    "서울 강남구 태헤란노 이십육길 십": ("강남구", "테헤란로26길", "10"),
    "서울 강남구 테헤란로 삼십일길 오 다시 이": ("강남구", "테헤란로31길", "5-2"),
    "서울 강남구 테헤란로 이십육펀킬 십": ("강남구", "테헤란로26길", "10"),
    "서울 강남구 태헤란로26낄 10": ("강남구", "테헤란로26길", "10"),
    "서울 강남구 테헤란로26뻔 길 10": ("강남구", "테헤란로26길", "10"),
    "서울 강남구 개봉로1타길 22": ("강남구", "개봉로1다길", "22"),
    "서울 강남구 개봉로1라길 22": ("강남구", "개봉로1라길", "22"),
    "서울 강남구 개봉로1따 길 22": ("강남구", "개봉로1다길", "22"),
    "서울 강남구 오천3길 21-2": ("강남구", "오천3길", "21-2"),
    "서울 강남구 오천길 21": ("강남구", "오천길", "21"),
    # 모델이 "이펜일로"를 숫자로 옮겨 적은 경우(2026-10-28 통화)
    "서울시 양천구 신정 201로 50": ("양천구", "신정이펜1로", "50"),
    "서울시 양천구 신정 2-1로 50": ("양천구", "신정이펜1로", "50"),
    "서울 양천구 신정이펜일로 50": ("양천구", "신정이펜1로", "50"),
    "서울 양천구 신정이팬1로 50": ("양천구", "신정이펜1로", "50"),
    "서울 양천구 신정이펜이로 50": ("양천구", "신정이펜2로", "50"),
}.items())
def test_candidates_correct_misheard_road(rd, heard, want):
    got = candidates(rd, heard)
    assert got and got[0][1:4] == want, got[:2]


def test_linking_sound_is_compared_as_pronounced():
    """연음·ㅢ 발음: "인의동"을 "이니동"으로 받아써도 같은 소리로 본다(다른 동보다 훨씬 가깝게)."""
    from app.address.phonetic import Name, distance
    assert jamo("인의동", canon=True) == jamo("이니동", canon=True)
    assert distance(Name("이니동"), Name("인의동")) < 1 < distance(Name("이니동"), Name("인동"))


def test_region_is_searched_top_down(rd):
    assert candidates(rd, "서울 중구 세종대로 110")[0][0] == "서울특별시"  # 부산 중구가 아니라
    assert candidates(rd, "부산 중구 중앙대로 100")[0][:3] == ("부산광역시", "중구", "중앙대로")
    assert candidates(rd, "서울 중구 중앙대로 100") == []  # 서울 안에서만 찾는다
    # 이름 색인이 없는 사전(RoadDict)은 시·군·구 없이 찾지 않는다(주소DB는 전국 색인으로 찾는다 — test_resolve_without_region)
    assert candidates(rd, "테헤란로 212") == []
    assert candidates(rd, "서울 테헤란로 212") == []


def test_sido_can_be_omitted(rd):
    """시도를 빼고 말해도 시·군·구부터 모든 시도에서 찾는다."""
    assert candidates(rd, "강남구 테헤란로 212")[0][:3] == ("서울특별시", "강남구", "테헤란로")
    assert candidates(rd, "분당구 판교역로 166")[0][:3] == ("경기도", "성남시 분당구", "판교역로")
    # 여러 시도에 있는 "중구"는 모두 후보로 두고 도로가 있는 쪽으로
    assert candidates(rd, "중구 세종대로 110")[0][:3] == ("서울특별시", "중구", "세종대로")
    assert candidates(rd, "중구 중앙대로 100")[0][:3] == ("부산광역시", "중구", "중앙대로")
    # 시도를 뺐을 때 시·군·구 이름은 정확히 들려야 한다(퍼지로 엉뚱한 곳을 잡지 않게)
    assert candidates(rd, "강넘구 테헤란로 212") == []
    # 시도를 말했으면 그쪽이 우선(시도 이름을 시·군·구로 오해하지 않음)
    assert candidates(rd, "서울 강남구 테헤란로 212")[0][:2] == ("서울특별시", "강남구")


def test_region_tree_levels():
    rd2 = RoadDict([("경상북도", "포항시", "해안로"), ("경상북도", "포항시 남구", "운하로"),
                    ("경상북도", "포항시 북구", "운하로"), ("충청남도", "금산군", "진밭들길"),
                    ("전북특별자치도", "고산군", "진밭들길"), ("세종특별자치시", "", "한누리대로")])
    assert rd2.tree["경상북도"]["포항시"].keys() == {"", "남구", "북구"}  # 시 단독 예외 행은 구 자리 ""
    assert candidates(rd2, "경북 포항시 남구 운하로 44")[0][:3] == ("경상북도", "포항시 남구", "운하로")
    assert candidates(rd2, "경북 포항 북구 운하로 44")[0][:3] == ("경상북도", "포항시 북구", "운하로")
    assert candidates(rd2, "경북 남구 운하로 44")[0][:3] == ("경상북도", "포항시 남구", "운하로")  # 시 건너뜀
    assert candidates(rd2, "경북 포항시남구 운하로 44")[0][:3] == ("경상북도", "포항시 남구", "운하로")  # 붙여 말함
    assert candidates(rd2, "충남 금산 진밭들길 90")[0][:3] == ("충청남도", "금산군", "진밭들길")  # 군 생략
    assert candidates(rd2, "세종시 한누리대로 2130")[0][:3] == ("세종특별자치시", "", "한누리대로")
    # 각 단계는 위 단계 안에서만: 충남 아래 "고산군"은 금산군으로, 충남에 없는 "해운대구"는 못 찾음
    assert rd2.match_region(["충남", "고산군", "진밭들길"]) == ([("충청남도", "금산군")], ["진밭들길"])
    assert rd2.match_region(["충남", "해운대구", "진밭들길"]) == ([], [])
    # 구를 빼고 말하면 그 시의 구 전부에서 찾는다
    assert set(rd2.match_region(["경북", "포항시", "운하로"])[0]) >= {("경상북도", "포항시 남구"), ("경상북도", "포항시 북구")}
    assert candidates(rd2, "경북 포항시 운하로 44")[0][2] == "운하로"
    assert candidates(rd2, "포항시 남구 운하로 44")[0][:3] == ("경상북도", "포항시 남구", "운하로")  # 시도 생략
    assert candidates(rd2, "금산군 진밭들길 90")[0][:3] == ("충청남도", "금산군", "진밭들길")  # 고산군과 헷갈리지 않음


# --- 주소DB와 correct(): 확정 / 애매함 / 없음 ---

@pytest.fixture
def db_path(tmp_path):
    return build_sample_db(tmp_path / "address.db")


@pytest.fixture
def db(db_path):
    return AddressDB(db_path)


def test_correct_statuses(db):
    assert correct(db, "서울 강남구 태헤란노 211").address == "서울특별시 강남구 테헤란로 211"
    # 테헤란로2길에는 10번이 없고 1길에만 있음 -> 일/이 혼동으로 보고 1길 10으로 확정
    assert correct(db, "서울 강남구 테헤란로2길 10").address == "서울특별시 강남구 테헤란로1길 10"
    # 1길 32, 2길 32 둘 다 있음 -> 들은 그대로 있는 쪽
    assert correct(db, "서울 강남구 테헤란로2길 32").address == "서울특별시 강남구 테헤란로2길 32"
    # 건물번호를 고쳐야만 맞는 주소는 후보로도 두지 않는다(없는 번호를 비슷한 번호로 기록하지 않게, 사용자 결정 2026-11-05)
    assert correct(db, "서울 강남구 테헤란로 112") == NOT_FOUND
    assert correct(db, "경북 구미시 인동9길 7") == NOT_FOUND  # 부번을 빼면 다른 번호(7-3을 7로 들음 ≠ 7-3)
    assert correct(db, "서울 강남구 테헤란로 99999") == NOT_FOUND
    assert correct(db, "서울 강남구 없는로 12").status == "not_found"
    assert correct(db, "전북 익산시 왕궁로 100").address == "전북특별자치도 익산시 왕궁면 왕궁로 100"  # 읍면은 주소에 들어감
    # 도로명을 많이 고치고 건물번호까지 바꿔야 맞는 주소는 억지로 맞추지 않는다(없는 주소). 번호가 맞으면 후보로 둔다
    weak = correct(db, "서울 강남구 대해남노 112")
    assert weak == NOT_FOUND
    assert correct(db, "서울 강남구 대해남노 211").candidates == ("서울특별시 강남구 테헤란로 211",)
    # 연음으로 받아쓴 길 번호("구길" -> "국일")
    assert correct(db, "경북 구미시 인동 국일 7-3").address == "경상북도 구미시 인동9길 7-3"


def test_jibun_address_resolves_to_road_address(db):
    """지번은 시군구 안의 법정동·리 이름으로 찾고, 그 지번 건물의 도로명주소로 돌려준다."""
    assert correct(db, "경북 구미시 인의동 844-5").address == "경상북도 구미시 인동9길 7-3"
    assert correct(db, "경북 구미시 인의동 844번지 5호").address == "경상북도 구미시 인동9길 7-3"
    assert correct(db, "경북 구미시 이니동 845").address == "경상북도 구미시 인동9길 8"  # 연음으로 받아씀(인의동)
    assert correct(db, "구미시 이니동 844-5").address == "경상북도 구미시 인동9길 7-3"  # 시도 생략 + 연음
    assert correct(db, "경북 구미시 선산읍 완전리 산 12").address == "전북특별자치도 익산시 왕궁면 왕궁로 100"
    assert correct(db, "경북 구미시 인의동 9999").status == "not_found"


def test_service_is_off_without_db_file(tmp_path, db_path, fake_kakao):
    """주소DB 파일이 없으면 보정을 끄고 들은 그대로(status off) — 주소DB가 있으면 보정한다."""
    assert open_db(tmp_path / "none.db") is None
    off = run(AddressService(None).resolve("서울 강남구 테헤란로 212"))
    assert (off.status, off.address) == ("off", "서울 강남구 테헤란로 212")
    on = run(AddressService(open_db(db_path)).resolve("서울 강남구 태헤란노 212"))
    assert (on.status, on.address) == ("confirmed", "서울특별시 강남구 테헤란로 212")


# --- 카카오 주소 검색(지번·동명·우편번호) ---

def kakao_api(handler):
    seen = []

    def wrapped(req):
        seen.append(req)
        return handler(req)

    return httpx2.MockTransport(wrapped), seen


KAKAO_DOC = {"address_name": "서울 강남구 테헤란로 212", "address_type": "ROAD_ADDR", "x": "127.0444", "y": "37.5013",
             "address": {"address_name": "서울 강남구 역삼동 718-5", "region_3depth_name": "역삼동"},
             "road_address": {"address_name": "서울 강남구 테헤란로 212", "region_3depth_name": "역삼동", "zone_no": "06220"}}


def test_kakao_geocode_parses_first_complete_document(monkeypatch):
    monkeypatch.setenv("KAKAO_REST_API_KEY", "k")
    broken = {**KAKAO_DOC, "road_address": None}  # 도로명 정보(우편번호)가 없으면 건너뛴다
    transport, seen = kakao_api(lambda req: httpx2.Response(200, json={"meta": {}, "documents": [broken, KAKAO_DOC]}))
    geo = run(REAL_GEOCODE("서울특별시 강남구 테헤란로 212", 3.0, transport))
    assert geo == Geo(jibun_address="서울 강남구 역삼동 718-5", dong_name="역삼동", postal_code="06220")
    assert seen[0].headers["Authorization"] == "KakaoAK k" and seen[0].url.params["query"].endswith("212")


@pytest.mark.parametrize("response", [
    httpx2.Response(200, json={"meta": {}, "documents": []}),
    httpx2.Response(401, json={}),
    httpx2.Response(200, json={"documents": [{**KAKAO_DOC, "road_address": {"zone_no": "123"}}]}),  # 우편번호 형식 틀림
])
def test_kakao_geocode_not_found_or_error_is_none(monkeypatch, response):
    monkeypatch.setenv("KAKAO_REST_API_KEY", "k")
    transport, _ = kakao_api(lambda req: response)
    assert run(REAL_GEOCODE("서울", 3.0, transport)) is None


def test_kakao_geocode_off_without_key(monkeypatch):
    monkeypatch.delenv("KAKAO_REST_API_KEY", raising=False)
    transport, seen = kakao_api(lambda req: httpx2.Response(200, json={"documents": [KAKAO_DOC]}))
    assert run(REAL_GEOCODE("서울", 3.0, transport)) is None and not seen


def test_linked_gil_number_is_unlinked_only_when_not_found():
    from app.address.parse import unlink_gil
    assert unlink_gil("경북 구미시 인동 국일 7-3") == "경북 구미시 인동  구길 7-3"
    assert unlink_gil("경북 구미시 인동국일 7-3") == "경북 구미시 인동 구길 7-3"
    assert unlink_gil("서울 강남구 테헤란로 212") is None
    assert unlink_gil("인천 남동구 만수일로 3") is None  # 받침 ㄱ이 아니면 그대로


# --- 못 찾았을 때 다시 볼 표기(parse.readings) ---

def test_rewrites_each_fix_only_what_it_targets():
    from app.address.parse import cut_trailing, ga_digits, split_dasi, strip_ending
    assert strip_ending("테헤란로 이일이요") == ["테헤란로 이일", "테헤란로 이일이"]  # 일(받침) + 이요 / 이일이 + 요
    assert strip_ending("인동 구길 사이요") == ["인동 구길 사이"]  # 받침 없는 글자 뒤 "이요"는 "요"만
    assert strip_ending("세종대로 110입니다") == ["세종대로 110"] and strip_ending("테헤란로 212") is None
    assert split_dasi("인동 구길 칠다시삼") == ["인동 구길 칠 다시 삼"]
    assert split_dasi("나주시 다시면 다시로 12") is None and split_dasi("고다시길 3") is None  # 도로명·면 이름은 그대로
    assert cut_trailing("올림픽로 300 롯데월드타워") == ["올림픽로 300"]
    assert cut_trailing("인동구길 칠 다시 삼이요") is None  # 부번이 이어지면 자르지 않는다(본번만 남으면 다른 건물)
    assert ga_digits("서울 중구 태평로 일가 삼십일") == ["서울 중구 태평로1가 삼십일"]


# --- 기본주소 | 상세주소 가르기(서버가 한다, 2026-11-09) ---

def test_valid_numeral_rejects_unreadable_runs():
    from app.address.parse import valid_numeral
    assert all(map(valid_numeral, ["삼백십이", "백이", "삼공일", "오십", "212", "일", "천오백이"]))
    assert not any(map(valid_numeral, ["십삼백십이", "일오백이", "오십삼백", "이백십일이", "012", "", "공십"]))


def test_split_detail_candidates_and_order():
    from app.address.parse import split_detail
    sure = lambda text, areas=None: [c for c in split_detail(text, areas) if c[2]]
    # 띄어쓰기 자리가 확실한 경계: 확실한 후보 하나(붙여 읽은 자르기는 그 뒤에), 말끝·쉼표·동사 꼬리는 뗀다
    assert sure("경북 구미시 인동 구길 칠 다시 삼, 이백삼호요") == [("경북 구미시 인동 구길 칠 다시 삼", "이백삼호", True)]
    assert split_detail("서울 종로구 성균관로 이십오 다시 이 경영관으로 할게요") == [("서울 종로구 성균관로 이십오 다시 이", "경영관", True)]
    assert split_detail("구미시 인의동 오륙오 다시 삼 아슬란 삼백오호입니다") == [("구미시 인의동 오륙오 다시 삼", "아슬란 삼백오호", True)]
    assert split_detail("서울 강남구 테헤란로 212 롯데월드타워") == [("서울 강남구 테헤란로 212", "롯데월드타워", True)]  # 번호 뒤 이름
    assert split_detail("부산 서구 구덕로 삼백이십일번길 오층이야") == [("부산 서구 구덕로 삼백이십일번길", "오층", True)]  # 번호 없이 가지만
    # 수사가 붙은 경계: 띄어쓰기 자리(확실) 다음에 읽을 수 있는 자르기만, 짧은 번호부터
    cands = split_detail("서울시 양천구 신정이펜일로 오십삼백십이동 사백삼호")
    assert [(b.split()[-1], d, s) for b, d, s in cands] == [  # "오십삼백|십이"는 못 읽는 수사라 후보가 아니다
        ("오십", "삼백십이동 사백삼호", False), ("오십삼", "백십이동 사백삼호", False)]
    assert split_detail("구미 인동구길 이십이 다시 일오백이호")[0] == ("구미 인동구길 이십이 다시 일", "오백이호", False)
    assert split_detail("서울시 양천구 신정이펜일로 오십 삼백십이동")[0] == ("서울시 양천구 신정이펜일로 오십", "삼백십이동", True)
    assert split_detail("구미 인동 구길 이십이 다시 일 오백 이 호")[0] == ("구미 인동 구길 이십이 다시 일", "오백이호", True)
    # 상세가 없으면 빈 목록(지금 경로 그대로): 법정동·번지·길 번호는 상세가 아니다
    assert split_detail("전주시 금암이동 백사십구 다시 십일 번지요") == []
    assert split_detail("서울 강남구 테헤란로 이백십이요") == [] and split_detail("안산시 상록구 사이동 1234", {"사이동"}.__contains__) == []
    assert split_detail("서울시 양천구 신정이펜일로 오십 이동 사백삼호", {"이동"}.__contains__)[0][1] == "이동 사백삼호"  # 법정동과 같아도 호가 이어지면 상세


def test_detail_text_converts_numerals_only():
    from app.address.parse import detail_text
    assert detail_text("삼백십이동 사백삼호요") == "312동 403호" and detail_text("오백 이 호") == "502호"
    assert detail_text("일동일호") == "1동 1호" and detail_text("지하구십구층") == "지하 99층"
    assert detail_text("소담미인 오백일호") == "소담미인 501호" and detail_text("베르디움 가동 사백일 호") == "베르디움 가동 401호"
    assert detail_text("미소지음 503호") == "미소지음 503호" and detail_text("오션 드파이") == "오션 드파이" and detail_text("") == ""


def test_resolve_detail_lets_the_db_pick_the_cut(db):
    from app.address.matcher import resolve_detail
    r, base, detail = resolve_detail(db, "경북 구미시 인동구길 칠다시삼 이백삼홉니다")  # 붙은 다시·"삼홉니다"
    assert (r.address, base, detail) == ("경상북도 구미시 인동9길 7-3", "경북 구미시 인동구길 칠 다시 삼", "이백삼호")
    r, _, detail = resolve_detail(db, "서울 강남구 테헤란로 이백십이백일동 삼호")  # 212|101동만 읽히고 실존
    assert (r.status, r.address, detail) == ("confirmed", "서울특별시 강남구 테헤란로 212", "백일동 삼호")
    r, _, detail = resolve_detail(db, "서울 강남구 테헤란로 이일이 멀티캠퍼스 십팔층입니다")
    assert (r.address, detail) == ("서울특별시 강남구 테헤란로 212", "멀티캠퍼스 십팔층")
    r, _, detail = resolve_detail(db, "서울 강남구 테헤란로 이일이백삼호")  # 21|이백삼 · 212|백삼 둘 다 실존 → 확정하지 않음
    assert r.status == "ambiguous" and set(r.candidates) == {"서울특별시 강남구 테헤란로 21", "서울특별시 강남구 테헤란로 212"}
    r, base, detail = resolve_detail(db, "서울 강남구 테헤란로 212요")  # 상세 없음: resolve와 같다
    assert (r.address, base, detail) == ("서울특별시 강남구 테헤란로 212", "서울 강남구 테헤란로 212요", None)
    r, _, detail = resolve_detail(db, "서울 강남구 없는로 12 삼층")  # 못 찾아도 상세는 돌려준다(기록은 유지)
    assert r.status == "not_found" and detail == "삼층"


def test_resolve_retries_only_when_not_found_and_readings_decide(db):
    from app.address.matcher import resolve
    r = resolve(db, "서울 강남구 테헤란로 이백십이요")  # "이백십"(210 없음)·"이백십이"(212) 중 확정된 쪽
    assert (r.status, r.address) == ("confirmed", "서울특별시 강남구 테헤란로 212")
    r = resolve(db, "서울 강남구 테헤란로 이일이요")  # "이일"(21)·"이일이"(212) 둘 다 실제 주소 → 확정하지 않는다
    assert r.status == "ambiguous" and r.candidates == ("서울특별시 강남구 테헤란로 21", "서울특별시 강남구 테헤란로 212")
    assert resolve(db, "서울 강남구 테헤란로 이백십일이요").address == "서울특별시 강남구 테헤란로 211"  # "이백십일이"는 못 읽는 수사
    assert resolve(db, "경북 구미시 인동 구길 칠다시삼").address == "경상북도 구미시 인동9길 7-3"
    assert resolve(db, "경북 구미 인동구길 칠 다시 삼이요").address == "경상북도 구미시 인동9길 7-3"  # 말끝 + 붙인 길
    assert resolve(db, "서울 강남구 테헤란로 212 무슨타워").address == "서울특별시 강남구 테헤란로 212"
    assert resolve(db, "서울 강남구 없는로 칠다시삼") == NOT_FOUND


def test_resolve_stops_retrying_after_time_limit(db):
    """다시 보기가 시간 상한을 넘으면 못 찾음 — 예산 초과로 "장애"가 되어 들은 값을 기록하지 않게."""
    from app.address.matcher import RETRY_SEC, resolve
    ticks = iter([0, RETRY_SEC + 1])
    assert resolve(db, "서울 강남구 테헤란로 212요", clock=lambda: next(ticks)) == NOT_FOUND
    assert resolve(db, "서울 강남구 테헤란로 212요").status == "confirmed"


# --- 전국 이름 색인(names + FTS5 trigram)과 건물명 ---

def test_name_key_ignores_spacing_and_reads_digits():
    from app.address.gazetteer import name_key
    assert name_key("강남 파이낸스 센터") == name_key("강남파이낸스센터")
    assert name_key("63빌딩") == name_key("육십삼빌딩")
    assert name_key("태헤란노") == name_key("테헤란로")  # 발음 정규화(ㅐ/ㅔ, ㄴ/ㄹ)


def test_names_index_finds_similar_names_nationwide(db):
    from app.address.gazetteer import name_key
    assert db.search_names(0, name_key("태헤란노"))[0] == ("테헤란로", "서울특별시", "강남구")  # 지역 없이 찾는다
    assert db.search_names(0, name_key("테헤란로"), scope=[("경기도", "성남시 분당구")]) == []  # 지역 제한
    assert db.search_names(1, name_key("신천동"))[0] == ("신천동", "서울특별시", "송파구")
    assert db.search_names(2, name_key("롯데월드타워"))[0][0] == "롯데월드타워"  # 복합 표기 "…앤드롯데월드몰"을 풀어 둔 이름
    assert db.search_names(2, name_key("롯데월드"))[0][0] == "롯데월드"  # 정확히 같은 이름이 먼저
    assert db.search_names(2, name_key("카카오 판교아지트"))[0] == ("카카오 판교 아지트", "경기도", "성남시 분당구")


def test_named_addresses_resolve_building_to_road_address(db):
    assert db.named_addresses("롯데월드타워앤드롯데월드몰") == ["서울특별시 송파구 올림픽로 300"]
    assert db.named_addresses("포스코센터", scope=[("서울특별시", "강남구")]) == ["서울특별시 강남구 테헤란로 212"]
    assert db.named_addresses("포스코센터", scope=[("경기도", "성남시 분당구")]) == []


def test_open_db_rejects_old_schema(tmp_path):
    """옛 스키마(이름 색인 없음)는 조용히 축소하지 않고 기동을 막아 재빌드를 알린다(사용자 결정 2026-11-05)."""
    import sqlite3
    old = tmp_path / "old.db"
    conn = sqlite3.connect(old)
    conn.executescript("CREATE TABLE roads (road_code INTEGER, emd_seq INTEGER, road TEXT, sido TEXT, sigungu TEXT,"
                       " emd TEXT, emd_type TEXT);")
    conn.commit()
    conn.close()
    with pytest.raises(RuntimeError, match="다시 빌드"):
        open_db(old)


# --- 지역 없이·시도만·동부터·건물명(전국 이름 색인, 2026-11-05 재설계) ---

def test_composite_building_names_are_split_at_build():
    from app.address.gazetteer import name_variants
    assert name_variants("롯데월드타워앤드롯데월드몰") == ["롯데월드타워앤드롯데월드몰", "롯데월드타워", "롯데월드몰"]
    assert name_variants("부산광역시청, 부산광역시의회") == ["부산광역시청, 부산광역시의회", "부산광역시청", "부산광역시의회"]
    assert name_variants("서울역(본옥)") == ["서울역(본옥)", "서울역"]
    assert name_variants("삼성전자(주) 평택캠퍼스") == ["삼성전자(주) 평택캠퍼스", "삼성전자 평택캠퍼스"]
    assert name_variants("앤드류빌딩") == ["앤드류빌딩"]  # 이름 안의 글자는 구분자가 아니다


def test_resolve_without_region(db):
    from app.address.matcher import resolve
    ok = lambda heard: (resolve(db, heard).status, resolve(db, heard).address)
    assert ok("테헤란로 212") == ("confirmed", "서울특별시 강남구 테헤란로 212")  # 도로부터
    assert ok("태헤란노 212") == ("confirmed", "서울특별시 강남구 테헤란로 212")  # 소리로 같은 이름은 지역 없이도 확정
    assert ok("서울 테헤란로 212") == ("confirmed", "서울특별시 강남구 테헤란로 212")  # 시도만
    assert ok("역삼동 테헤란로 212") == ("confirmed", "서울특별시 강남구 테헤란로 212")  # 동부터
    assert ok("서울 역삼동 테헤란로 212") == ("confirmed", "서울특별시 강남구 테헤란로 212")
    assert ok("역삼동 737") == ("confirmed", "서울특별시 강남구 테헤란로 212")  # 동 + 지번
    assert ok("서울 신천동 29") == ("confirmed", "서울특별시 송파구 올림픽로 300")
    assert ok("중앙로 1") == ("confirmed", "경기도 고양시 덕양구 중앙로 1")  # 흔한 도로명이라도 번호가 한 곳에만 있으면 확정
    assert ok("경기 중앙로 232") == ("confirmed", "경기도 고양시 덕양구 중앙로 232")
    assert ok("없는로 12") == ("not_found", None) and ok("테헤란로 99999") == ("not_found", None)


def test_same_road_in_several_regions_asks_region(db):
    """같은 도로명·번호가 서로 다른 시군구에 있으면 자동으로 고르지 않고 지역을 되묻는다(사용자 결정 2026-11-05)."""
    from app.address.matcher import resolve
    r = resolve(db, "중앙로 232")
    assert r.status == "region_needed" and set(r.candidates) == {"서울특별시 양천구", "경기도 고양시 덕양구"} and r.address is None
    # 지역을 전혀 안 말했고 이름을 고쳐야 맞으면(소리 거리 ≥ 1) 확정하지 않고 그 후보 지역을 묻는다
    r = resolve(db, "대핸란로 212")
    assert r.status == "region_needed" and r.candidates == ("서울특별시 강남구",)
    assert resolve(db, "서울 테헤람로 212").address == "서울특별시 강남구 테헤란로 212"  # 시도를 말했으면 고쳐서 확정
    assert resolve(db, "강남구 테헤람로 212").address == "서울특별시 강남구 테헤란로 212"  # 시도 없이 시군구만 말해도 지역을 말한 것
    assert resolve(db, "테헤람로 212").status == "region_needed"


def test_building_name_resolves_to_its_road_address(db):
    from app.address.matcher import resolve
    ok = lambda heard: (resolve(db, heard).status, resolve(db, heard).address)
    assert ok("롯데월드타워") == ("confirmed", "서울특별시 송파구 올림픽로 300")  # 실제 표기 "롯데월드타워앤드롯데월드몰"을 풀어 둠
    assert ok("롯데월드") == ("confirmed", "서울특별시 송파구 올림픽로 240")
    assert ok("송파구 롯데월드타워") == ok("서울 롯데월드타워") == ("confirmed", "서울특별시 송파구 올림픽로 300")
    assert ok("카카오 판교아지트") == ("confirmed", "경기도 성남시 분당구 판교역로 166")  # 띄어쓰기 무시
    assert ok("포스코센터") == ("confirmed", "서울특별시 강남구 테헤란로 212")
    assert ok("서울 포스코 센타") == ("confirmed", "서울특별시 강남구 테헤란로 212")  # 시도 안에서는 소리 오류를 고친다
    assert resolve(db, "포스코 센타").status == "region_needed"  # 지역 없이 고친 이름은 되묻는다
    assert ok("없는빌딩타워") == ("not_found", None)
    assert ok("롯데월드타워 300") == ("not_found", None)  # 번호가 붙으면 건물명 경로가 아니다


# --- 두 번째 근거: 카카오 키워드·similar 검색 결과를 주소DB로 검증해 채택(3단계, 2026-11-06) ---

def test_kakao_search_returns_top_road_addresses(monkeypatch):
    monkeypatch.setenv("KAKAO_REST_API_KEY", "k")
    docs = [{"place_name": "국회의사당", "road_address_name": "서울 영등포구 의사당대로 1"}, {"place_name": "x", "road_address_name": ""}]
    transport, seen = kakao_api(lambda req: httpx2.Response(200, json={"documents": docs}))
    assert run(kakao.search_places("국회의사당", 3.0, transport)) == ["서울 영등포구 의사당대로 1"]
    assert seen[0].url.path.endswith("keyword.json") and seen[0].url.params["query"] == "국회의사당"
    docs = [{"road_address": {"address_name": "서울 강남구 테헤란로 212"}}, {"road_address": None}]
    transport, seen = kakao_api(lambda req: httpx2.Response(200, json={"documents": docs}))
    assert run(kakao.search_addresses("테헤란로 212 무슨빌딩", 3.0, transport)) == ["서울 강남구 테헤란로 212"]
    assert seen[0].url.params["analyze_type"] == "similar"
    transport, _ = kakao_api(lambda req: httpx2.Response(500, json={}))
    assert run(kakao.search_places("x", 3.0, transport)) == [] and run(kakao.search_addresses("x", 3.0, transport)) == []


def witness(monkeypatch, places=(), addresses=()):
    """카카오 검색을 가짜로: 불렸는지(seen)와 결과를 정한다."""
    seen = []

    async def fake_places(q, *a, **k):
        seen.append(("places", q))
        return list(places)

    async def fake_addresses(q, *a, **k):
        seen.append(("addresses", q))
        return list(addresses)

    monkeypatch.setenv("KAKAO_REST_API_KEY", "k")
    monkeypatch.setattr(kakao, "search_places", fake_places)
    monkeypatch.setattr(kakao, "search_addresses", fake_addresses)
    return seen


def test_witness_fills_in_only_verified_addresses(db_path, fake_kakao, monkeypatch):
    svc = AddressService(open_db(db_path))
    seen = witness(monkeypatch, places=["서울 강남구 없는로 1", "서울 강남구 테헤란로 212", "서울 강남구 테헤란로 211"])
    r = run(svc.resolve("무슨빌딩"))  # 로컬에 없는 상호 → 검증되는 카카오 1순위
    assert (r.status, r.address) == ("confirmed", "서울특별시 강남구 테헤란로 212") and len(seen) == 2
    witness(monkeypatch, addresses=["서울 강남구 테헤란로 212"])
    assert run(svc.resolve("테헤란로 210")).status == "not_found"  # 들은 번호와 다른 주소는 받지 않는다
    witness(monkeypatch, addresses=["서울 강남구 테헤란로1길 10"])
    assert run(svc.resolve("테헤란로 10")).status == "not_found"  # 번호만 같고 길이 다른 주소도 받지 않는다(v1 k08)
    witness(monkeypatch, addresses=["서울 강남구 테헤란로1길 10"])
    assert run(svc.resolve("테헤란로 일길 10 무슨빌딩")).address == "서울특별시 강남구 테헤란로1길 10"
    witness(monkeypatch, places=["경기 성남시 분당구 판교역로 166"], addresses=["서울 강남구 테헤란로 212"])
    assert run(svc.resolve("어딘가")).status == "region_needed"  # 카카오 결과끼리 지역이 엇갈리면 되묻는다


def test_witness_checks_weak_local_results(db_path, fake_kakao, monkeypatch):
    """지역 없이 건물명만으로 확정한 결과는 카카오가 다른 지역을 가리키면 되묻고, 같은 지역이면 그대로. 소리를 고친 되묻기는 카카오가 확정할 수 있다."""
    svc = AddressService(open_db(db_path))
    witness(monkeypatch, places=["경기 성남시 분당구 판교역로 166"])
    r = run(svc.resolve("포스코센터"))
    assert r.status == "region_needed" and r.alternatives == ("서울특별시 강남구", "경기도 성남시 분당구")
    witness(monkeypatch, places=["서울 강남구 테헤란로 212"])
    assert run(svc.resolve("포스코센터")).address == "서울특별시 강남구 테헤란로 212"
    witness(monkeypatch)  # 카카오가 모르는 이름이면 로컬 확정 유지
    assert run(svc.resolve("포스코센터")).address == "서울특별시 강남구 테헤란로 212"
    witness(monkeypatch, places=["서울 강남구 테헤란로 212"])
    assert run(svc.resolve("포스코 센타")).address == "서울특별시 강남구 테헤란로 212"  # 되묻기(weak) → 카카오로 확정


def test_witness_is_not_asked_for_strong_results_or_without_key(db_path, fake_kakao, monkeypatch):
    svc = AddressService(open_db(db_path))
    seen = witness(monkeypatch, places=["서울 양천구 중앙로 232"])
    assert run(svc.resolve("중앙로 232")).status == "region_needed" and not seen  # 여러 지역에 실제로 있음: 카카오가 덮지 못한다
    assert run(svc.resolve("서울 강남구 테헤란로 212")).status == "confirmed" and not seen
    monkeypatch.delenv("KAKAO_REST_API_KEY")
    assert run(svc.resolve("무슨빌딩")).status == "not_found" and not seen


# --- 접수용 값(지번·법정동·우편번호)을 주소DB에서(4단계 Geo 로컬화, 2026-11-06) ---

def test_local_geo_matches_kakao_format(db):
    # 대표 지번(737, 비대표 738은 아님), 시도 두 글자, 우편번호 5자리
    assert db.geo("서울특별시 강남구 테헤란로 212") == Geo("서울 강남구 역삼동 737", "역삼동", "06220")
    assert db.geo("서울특별시 송파구 올림픽로 300") == Geo("서울 송파구 신천동 29", "신천동", "05551")
    # 읍면·리·산, 특별자치도는 정식 명칭 그대로
    assert db.geo("전북특별자치도 익산시 왕궁면 왕궁로 100") == Geo("전북특별자치도 익산시 선산읍 완전리 산 12", "선산읍 완전리", "54546")
    assert db.geo("서울특별시 강남구 테헤란로 211") is None  # 지번·우편번호 없음 → 카카오로 보완
    assert db.geo("서울특별시 강남구 테헤란로 99999") is None


def test_kakao_sido_abbreviation():
    from app.address.gazetteer import kakao_sido
    assert [kakao_sido(s) for s in ("서울특별시", "부산광역시", "경기도", "경상북도", "충청남도")] == ["서울", "부산", "경기", "경북", "충남"]
    assert [kakao_sido(s) for s in ("세종특별자치시", "제주특별자치도", "강원특별자치도", "전남광주통합특별시")] == \
        ["세종특별자치시", "제주특별자치도", "강원특별자치도", "전남광주통합특별시"]


def test_service_uses_local_geo_and_falls_back_to_kakao(db_path, monkeypatch):
    calls = []

    async def geocode(address_, timeout_sec, transport=None, http=None):
        calls.append(address_)
        return Geo("카카오", "카카오동", "00000")

    monkeypatch.setattr(kakao, "geocode", geocode)
    svc = AddressService(open_db(db_path))
    r = run(svc.resolve("서울 강남구 테헤란로 212"))
    assert r.geo == Geo("서울 강남구 역삼동 737", "역삼동", "06220") and not calls  # 로컬에서, 카카오 호출 없음
    r = run(svc.resolve("서울 강남구 테헤란로 211"))
    assert r.geo == Geo("카카오", "카카오동", "00000") and calls == ["서울특별시 강남구 테헤란로 211"]  # 로컬에 없으면 카카오
