"""주소 보정(app/address): 보정기 자체(도로 사전·작은 주소DB)와 record_order에 붙은 동작.
보정기 사례는 kakao_map_test의 자체 테스트를 옮긴 것이다. 실제 주소DB(data/address.db) 없이 돈다."""

import csv
import json
import sqlite3
from pathlib import Path

import pytest
from conftest import FULL_ORDER, make_call, run

from app import address
from app.address.corrector import RoadDict, candidates, correct, jamo
from app.address.db import INDEXES, SCHEMA, AddressDB
from app.dispatcher import dispatch

DATA = Path(__file__).parent / "data"


# --- 보정기: 지역 트리·도로명 퍼지 매칭 ---

@pytest.fixture(scope="module")
def rd():
    with open(DATA / "roads_sample.csv", encoding="utf-8") as f:
        rows = [tuple(r) for r in csv.reader(f)][1:]
    # 실제처럼 대로에 N길이 줄줄이 붙어 있는 상황
    rows += [("서울특별시", "강남구", f"테헤란로{i}길") for i in range(1, 41)]
    # 가나다 길, 숫자 글자로만 된 도로명 (테스트용 가상 배치)
    rows += [("서울특별시", "강남구", r) for r in ("개봉로1나길", "개봉로1다길", "개봉로1라길", "오천3길", "오천길")]
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
}.items())
def test_candidates_correct_misheard_road(rd, heard, want):
    got = candidates(rd, heard)
    assert got and got[0][1:4] == want, got[:2]


def test_linking_sound_is_compared_as_pronounced():
    """연음·ㅢ 발음: "인의동"을 "이니동"으로 받아써도 같은 소리로 본다(다른 동보다 훨씬 가깝게)."""
    from app.address.corrector import Name, distance
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

ROADS = [  # (도로명코드, 읍면동일련번호, 도로명, 시도, 시군구, 읍면동, 읍면동구분 0:읍면 1:동)
    (1, 0, "테헤란로", "서울특별시", "강남구", "역삼동", "1"),
    (2, 0, "테헤란로1길", "서울특별시", "강남구", "역삼동", "1"),
    (3, 0, "테헤란로2길", "서울특별시", "강남구", "역삼동", "1"),
    (4, 0, "판교역로", "경기도", "성남시 분당구", "백현동", "1"),
    (5, 0, "왕궁로", "전북특별자치도", "익산시", "왕궁면", "0"),
    (6, 0, "인동9길", "경상북도", "구미시", "인의동", "1"),
]
BUILDINGS = {1: (111, 115, 211, 212), 2: (10, 32), 3: (32,), 4: (166,), 5: (100,), 6: ((7, 3), (8, 0))}
AREAS = [(1, "경상북도", "구미시", "인의동", ""), (2, "경상북도", "구미시", "선산읍", "완전리")]
JIBUN = [  # (법정동·리, 산여부, 번지, 호, 건물 = 도로명코드*100 + 순번)
    (1, 0, 844, 5, 601),  # 인의동 844-5 -> 인동9길 7-3
    (1, 0, 845, 0, 602),  # 인의동 845 -> 인동9길 8
    (2, 1, 12, 0, 501),   # 선산읍 완전리 산 12 -> (테스트용으로) 왕궁로 100
]


@pytest.fixture
def db_path(tmp_path):
    path = tmp_path / "address.db"
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA + INDEXES)
    conn.executemany("INSERT INTO roads VALUES (?,?,?,?,?,?,?)", ROADS)
    conn.executemany("INSERT INTO buildings VALUES (?,?,?,?,?,?)",
                     [(code * 100 + i, code, 0, 0, *(n if isinstance(n, tuple) else (n, 0)))
                      for code, ns in BUILDINGS.items() for i, n in enumerate(ns, 1)])
    conn.executemany("INSERT INTO areas VALUES (?,?,?,?,?)", AREAS)
    conn.executemany("INSERT INTO jibun VALUES (?,?,?,?,?)", JIBUN)
    conn.commit()
    conn.close()
    return path


@pytest.fixture
def db(db_path):
    return AddressDB(db_path)


def test_correct_statuses(db):
    assert correct(db, "서울 강남구 태헤란노 211")["address"] == "서울특별시 강남구 테헤란로 211"
    # 테헤란로2길에는 10번이 없고 1길에만 있음 -> 일/이 혼동으로 보고 1길 10으로 확정
    assert correct(db, "서울 강남구 테헤란로2길 10")["address"] == "서울특별시 강남구 테헤란로1길 10"
    # 1길 32, 2길 32 둘 다 있음 -> 들은 그대로 있는 쪽
    assert correct(db, "서울 강남구 테헤란로2길 32")["address"] == "서울특별시 강남구 테헤란로2길 32"
    # 건물번호를 고쳐야 맞는 주소는 확정하지 않고 후보로만
    r = correct(db, "서울 강남구 테헤란로 112")
    assert r["status"] == "ambiguous" and "서울특별시 강남구 테헤란로 111" in r["candidates"], r
    assert correct(db, "서울 강남구 테헤란로 99999") == {"status": "not_found", "address": None, "candidates": []}
    assert correct(db, "서울 강남구 없는로 12")["status"] == "not_found"
    assert correct(db, "전북 익산시 왕궁로 100")["address"] == "전북특별자치도 익산시 왕궁면 왕궁로 100"  # 읍면은 주소에 들어감


def test_jibun_address_resolves_to_road_address(db):
    """지번은 시군구 안의 법정동·리 이름으로 찾고, 그 지번 건물의 도로명주소로 돌려준다."""
    assert correct(db, "경북 구미시 인의동 844-5")["address"] == "경상북도 구미시 인동9길 7-3"
    assert correct(db, "경북 구미시 인의동 844번지 5호")["address"] == "경상북도 구미시 인동9길 7-3"
    assert correct(db, "경북 구미시 이니동 845")["address"] == "경상북도 구미시 인동9길 8"  # 연음으로 받아씀(인의동)
    assert correct(db, "구미시 이니동 844-5")["address"] == "경상북도 구미시 인동9길 7-3"  # 시도 생략 + 연음
    assert correct(db, "경북 구미시 선산읍 완전리 산 12")["address"] == "전북특별자치도 익산시 왕궁면 왕궁로 100"
    assert correct(db, "경북 구미시 인의동 9999")["status"] == "not_found"


def test_load_turns_off_without_db_file(tmp_path, db_path, monkeypatch):
    monkeypatch.undo()  # conftest의 "보정 끔"을 풀고 실제 load를 시험
    try:
        assert address.load(tmp_path / "none.db") is False and run(address.correct("서울 강남구 테헤란로 212")) is None
        assert address.load(db_path) is True
        assert run(address.correct("서울 강남구 테헤란로 212"))["status"] == "confirmed"
    finally:
        address._db = None


# --- record_order에 붙은 보정 ---

@pytest.fixture
def corrector(db, monkeypatch):
    monkeypatch.setattr(address, "_db", db)


def record(call, **values):
    return run(dispatch(call, "record_order", json.dumps(values, ensure_ascii=False), "c"))


def test_confirmed_address_is_recorded_in_standard_form(corrector):
    call = make_call()
    assert record(call, sender_address="서울 강남구 태헤란노 이백십일", sender_address_detail="3층")["ok"]
    assert call.order.sender_address == "서울특별시 강남구 테헤란로 211" and call.order.sender_address_detail == "3층"


def test_ambiguous_address_is_decided_by_server_without_asking(corrector, db):
    """애매해도 고객에게 다시 묻지 않고 가장 가까운 실제 주소로 정한다."""
    call = make_call()
    best = correct(db, "서울 강남구 테헤란로 112")["candidates"][0]
    assert record(call, receiver_address="서울 강남구 테헤란로 112", receiver_address_detail="101호")["ok"]
    assert call.order.receiver_address == best and call.order.receiver_address_detail == "101호"


def test_not_found_address_is_recorded_as_heard(corrector):
    call = make_call()
    assert record(call, sender_address="테헤란로 212")["ok"]  # 지역을 말하지 않아 찾지 못함
    assert call.order.sender_address == "테헤란로 212"


def test_without_db_address_is_recorded_as_heard():
    call = make_call()
    assert record(call, sender_address="서울 강남구 태헤란노 211")["ok"]
    assert call.order.sender_address == "서울 강남구 태헤란노 211"


# --- 그래프의 주소 확정 단계(address) ---

def test_address_stage_resolves_then_returns(corrector):
    """새 주소가 기록되면 address 단계를 거쳐(고객에게 묻지 않음) 들어온 단계로 돌아가고, 결과가 관제에 남는다."""
    call = make_call()
    assert record(call, sender_address="서울 강남구 태헤란노 211", sender_address_detail="")["ok"]
    assert [h["to"] for h in call.flow.history] == ["address", "collecting"] and call.flow.stage == "collecting"
    assert call.address_results["sender_address"] == {"status": "confirmed", "changed": True}
    assert call.snapshot()["address"] == call.address_results and not call.address_pending
    record(call, sender_address="서울특별시 강남구 테헤란로 211")  # 같은 주소면 다시 거치지 않음
    assert [h["to"] for h in call.flow.history] == ["address", "collecting"]


def test_address_stage_from_confirming_goes_back_when_detail_dropped(corrector):
    """마지막 확인에서 주소만 바꾸면 주소 확정 → 상세주소가 빠졌으니 다시 받기."""
    call = make_call()
    assert record(call, **FULL_ORDER)["ok"] and call.flow.stage == "confirming"
    assert record(call, receiver_address="서울 강남구 테헤란로 112")["ok"]
    assert [h["to"] for h in call.flow.history][-3:] == ["address", "confirming", "collecting"]
    assert call.order.receiver_address.startswith("서울특별시 강남구 테헤란로 11")  # 애매함 → 1등
    assert call.address_results["receiver_address"]["status"] == "ambiguous"


def test_address_stage_without_db_keeps_heard():
    call = make_call()
    assert record(call, sender_address="서울 강남구 태헤란노 211")["ok"]
    assert call.address_results["sender_address"] == {"status": "off", "changed": False}
