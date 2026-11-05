"""주소 보정(app/address): 보정기 자체(도로 사전·작은 주소DB)와 카카오 지번·우편번호. record_fields에 붙은 동작은 test_tools.
보정기 사례는 kakao_map_test의 자체 테스트를 옮긴 것이다. 실제 주소DB(data/address.db) 없이 돈다."""

import csv
from pathlib import Path

import httpx2
import pytest
from conftest import run

from app.address.gazetteer import AddressDB, open_db
from app.address.matcher import RoadDict, candidates, correct, not_found
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
    # 지역을 전혀 말하지 않거나 시·군·구를 빼면 찾지 않는다
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
    # 테헤란로2길에는 10번이 없고 1길에만 있음 -> 정확히 들은 2길을 버리고 1길로 고치지 않는다(다시 물음, 2026-11-05)
    assert correct(db, "서울 강남구 테헤란로2길 10") == not_found("number")
    # 1길 32, 2길 32 둘 다 있음 -> 들은 그대로 있는 쪽
    assert correct(db, "서울 강남구 테헤란로2길 32").address == "서울특별시 강남구 테헤란로2길 32"
    # 건물번호를 고쳐야만 맞는 주소는 후보로도 두지 않는다(없는 번호를 비슷한 번호로 기록하지 않게, 사용자 결정 2026-11-05)
    assert correct(db, "서울 강남구 테헤란로 112") == not_found("number")
    assert correct(db, "경북 구미시 인동9길 7") == not_found("number")  # 부번을 빼면 다른 번호(7-3을 7로 들음 ≠ 7-3)
    assert correct(db, "서울 강남구 테헤란로 99999") == not_found("number")
    assert correct(db, "서울 강남구 없는로 12").status == "not_found"
    assert correct(db, "전북 익산시 왕궁로 100").address == "전북특별자치도 익산시 왕궁면 왕궁로 100"  # 읍면은 주소에 들어감
    # 도로명을 많이 고치고 건물번호까지 바꿔야 맞는 주소는 억지로 맞추지 않는다(없는 주소). 번호가 맞으면 후보로 둔다
    weak = correct(db, "서울 강남구 대해남노 112")
    assert weak == not_found("name")  # 도로명을 많이 고친 이름이라 번호 문제가 아니다
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


def test_resolve_retries_only_when_not_found_and_readings_decide(db):
    from app.address.matcher import resolve
    r = resolve(db, "서울 강남구 테헤란로 이백십이요")  # "이백십"(210 없음)·"이백십이"(212) 중 확정된 쪽
    assert (r.status, r.address) == ("confirmed", "서울특별시 강남구 테헤란로 212")
    # 211·212 둘 다 실제 주소 → 후보가 둘 이상이면 1순위를 기록하지 않고 다시 묻는다(사용자 결정 2026-11-05)
    assert resolve(db, "서울 강남구 테헤란로 이백십일이요") == not_found("multiple")
    assert resolve(db, "경북 구미시 인동 구길 칠다시삼").address == "경상북도 구미시 인동9길 7-3"
    assert resolve(db, "경북 구미 인동구길 칠 다시 삼이요").address == "경상북도 구미시 인동9길 7-3"  # 말끝 + 붙인 길
    assert resolve(db, "서울 강남구 테헤란로 212 무슨타워").address == "서울특별시 강남구 테헤란로 212"
    assert resolve(db, "서울 강남구 없는로 칠다시삼") == not_found("name")


def test_resolve_stops_retrying_after_time_limit(db):
    """다시 보기가 시간 상한을 넘으면 못 찾음 — 예산 초과로 "장애"가 되어 들은 값을 기록하지 않게."""
    from app.address.matcher import RETRY_SEC, resolve
    ticks = iter([0, RETRY_SEC + 1])
    assert resolve(db, "서울 강남구 테헤란로 212요", clock=lambda: next(ticks)).status == "not_found"
    assert resolve(db, "서울 강남구 테헤란로 212요").status == "confirmed"


def test_heard_name_is_not_replaced_by_a_similar_real_place(db):
    """맞게 들은 이름은 고치지 않고, 짧은 이름은 소리가 같을 때만 맞다고 본다(2026-11-05 "산동 580" → 신동 580)."""
    # 리 없이 읍·면만 말하면 번지가 하나로 정해지지 않는다 → 비슷한 다른 동·리로 고치지 않는다(못 찾음)
    assert correct(db, "경북 구미시 선산읍 산 12") == not_found("needs_ri")
    assert correct(db, "경북 구미시 선산읍 완전리 산 12").status == "confirmed"
    # 짧은 동 이름("인의")에서 글자가 바뀌면 다른 장소 → 후보가 아니다. 연음처럼 소리가 같으면 그대로 찾는다
    assert correct(db, "경북 구미시 안의동 844-5") == not_found("name")
    assert correct(db, "경북 구미시 이니동 844-5").status == "confirmed"
    # 긴 도로명은 받아쓰기 오류를 지금처럼 고친다
    assert correct(db, "서울 강남구 태헤란노 211").address == "서울특별시 강남구 테헤란로 211"


def test_not_found_says_which_part_to_say_again(db):
    """못 찾은 이유(needs.detail): 고객에게 어느 부분을 또렷하게 다시 말해 달라고 할지."""
    from app.address.matcher import resolve
    assert resolve(db, "테헤란로 212") == not_found("region")  # 시·군·구 없음
    assert resolve(db, "서울 강남구 없는로 12") == not_found("name")
    assert resolve(db, "경북 구미시 선산 12") == not_found("needs_ri")  # 리 없이 읍·면만(접미사 없이)
    assert resolve(db, "서울 강남구 테헤란로 99999") == not_found("number")
    # 이유는 가장 많이 알아들은 해석 기준: 건물명을 떼면 이름은 맞고 번호가 없다
    assert resolve(db, "서울 강남구 테헤란로 99999 무슨빌딩") == not_found("number")
