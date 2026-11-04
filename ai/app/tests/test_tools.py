"""S3 도구·실행기·주소 서비스·취소. 실제 OpenAI·BE·카카오·RAG 없이(가짜 BE, 작은 주소DB, 가짜 카카오)."""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx2
import pytest
from conftest import CALLER, GEO, INCOMING_AT, run

import address_resolver
from address_resolver.corrector import correct
from address_resolver.db import AddressDB
from address_resolver.tests.sample_db import build_sample_db
from app.domain.candidates import apply_pick
from app.domain.rules import normalize_phone, parse_pickup
from app.domain.state import ConversationState, Customer, FieldStatus, Geo, Items, Place, Source
from app.integrations.address import AddressService
from app.integrations.backend.gateway import BackendGateway
from app.policy.model import load_policy
from app.tools import MODEL_TOOLS, function_specs, run_tool
from app.tools.cancel import cancel_parcel
from app.tools.context import ToolContext
from backend_client.mock import MockBackend
from backend_client.order import CompanyPlace

P = load_policy()
KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 11, 3, 10, 0, tzinfo=KST)
TOMORROW = (NOW + timedelta(days=1)).isoformat()


def ctx(backend=None, address=None, **kw) -> ToolContext:
    customer = kw.pop("customer", Customer(customer_seq=12, name="김철수", caller_phone=CALLER))
    return ToolContext("live_test", ConversationState(customer=customer, intent="order"), P,
                       BackendGateway(backend or MockBackend()), address, now=lambda: NOW, clock=lambda: 100.0, **kw)


def call(c, name, args, call_id=None, **kw):
    return run(run_tool(c, name, json.dumps(args, ensure_ascii=False), call_id or f"c{len(c.outputs)}", **kw))


@pytest.fixture
def corrector(tmp_path, monkeypatch):
    db = AddressDB(build_sample_db(tmp_path / "address.db"))
    monkeypatch.setattr(address_resolver, "_db", db)
    return db


@pytest.fixture
def address(fake_kakao):
    return AddressService()


# --- 규칙 ---

@pytest.mark.parametrize("raw, expected", [
    ("공일공 일이삼사 오육칠팔", "01012345678"), ("공일공삼 하나하나오오사이팔", "01031155428"),
    ("공일공 일곱여덟아홉공 둘셋넷다섯", "01078902345"), ("010-1234-5678", "01012345678"),
    ("+82 10 1234 5678", "01012345678"), ("0101234567", None), ("02-123-4567", "021234567"),
    ("031 1234 5678", "03112345678"), ("1588-1234", "15881234"), ("일육공공 일이삼사", "16001234"),
    ("12345", None), ("0212", None),
    ("010-283-54286", "01028354286"),  # S0d 19:07: 잘못 받아쓴 번호도 11자리면 통과 — 자릿수 검사로는 못 잡고 되읽기로 잡는다
])
def test_normalize_phone(raw, expected):
    assert normalize_phone(raw) == expected


@pytest.mark.parametrize("raw, code", [
    (TOMORROW, None), ((NOW + timedelta(minutes=59)).isoformat(), "PICKUP_TOO_SOON"),
    ((NOW + timedelta(minutes=60)).isoformat(), None), ((NOW - timedelta(minutes=1)).isoformat(), "PICKUP_IN_PAST"),
    ("2026-11-04T10:00:00", "PICKUP_INVALID_FORMAT"), ("내일 오후", "PICKUP_INVALID_FORMAT"),
])
def test_parse_pickup_p1(raw, code):
    value, got = parse_pickup(raw, NOW, P.pickup.min_lead_minutes)
    assert got == code and (value is None) == (code is not None)


# --- 실행기 ---

def test_every_model_tool_has_strict_spec_and_no_choice_tools():
    specs = function_specs()
    assert {s["name"] for s in specs} == {"record_fields", "find_destination", "lookup_orders", "search_manual",
                                         "get_state"}
    assert all(s["strict"] and s["parameters"]["additionalProperties"] is False for s in specs)
    assert not {"confirm", "choose", "set_intent", "cancel_order"} & set(MODEL_TOOLS)  # delegation.md §2


def test_executor_allowed_before_validation_args_cache_timeout_and_exception(monkeypatch):
    c = ctx()
    assert call(c, "record_fields", {"bad": 1}, allowed=["get_state"])["code"] == "TOOL_NOT_ALLOWED"  # 위험 4
    assert call(c, "nope", {})["code"] == "TOOL_NOT_ALLOWED"
    out = call(c, "record_fields", {"bad": 1})
    assert (out["status"], out["code"]) == ("needs_input", "TOOL_ARGS_INVALID") and out["needs"][0]["field"] == "bad"
    first = call(c, "record_fields", {"receiver_name": "이영희"}, "same")
    assert call(c, "record_fields", {"receiver_name": "박민수"}, "same") == first  # 같은 call_id 재수신(F15)
    assert c.state.field_of("receiver_name").value == "이영희"

    async def slow(ctx_, args):
        await asyncio.sleep(1)

    async def boom(ctx_, args):
        raise RuntimeError("x")

    tool = MODEL_TOOLS["get_state"]
    monkeypatch.setitem(MODEL_TOOLS, "get_state", tool.__class__(tool.name, tool.description, tool.args, slow))
    c.tool_budget_sec = 0.05
    assert call(c, "get_state", {})["code"] == "TOOL_TIMEOUT"
    monkeypatch.setitem(MODEL_TOOLS, "get_state", tool.__class__(tool.name, tool.description, tool.args, boom))
    assert call(c, "get_state", {})["code"] == "INTERNAL_ERROR"


# --- record_fields ---

def test_record_normalizes_reports_and_summarizes():
    c = ctx()
    out = call(c, "record_fields", {"receiver_name": " 이영희 ", "receiver_phone": "공일공 구팔칠육 오사삼이",
                                    "small_box_count": 2, "item_price": 30000})
    s = c.state
    assert out["status"] == "ok" and s.field_of("receiver_phone").value == "01098765432"
    assert s.field_of("items").value == Items(small_box_count=2)
    assert out["facts"]["phones_to_read"] == ["receiver_phone"]
    assert s.field_of("sender_phone").source == Source.CALLER_ID  # 발신번호는 서버가 채운다
    assert out["fields"]["receiver_name"] == "valid" and "sender_phone" not in out["fields"]
    assert out["missing"][0] == "sender_address" and out["stage"] == "sender"  # 등록 고객 성함은 이미 채워짐


def test_bad_phone_and_pickup_not_saved_other_values_are():
    c = ctx()
    c.state.record("receiver_phone", "01098765432")
    out = call(c, "record_fields", {"receiver_name": "이영희", "receiver_phone": "공일공 일이삼"})
    assert out["status"] == "needs_input" and out["code"] == "PHONE_INVALID_DIGITS"
    assert {n["reason"] for n in out["needs"]} == {"PHONE_INVALID_DIGITS"}
    assert out["facts"]["recorded"] == ["receiver_name"]  # 부분 반영을 명시(위험 3)
    f = c.state.field_of("receiver_phone")
    assert (f.value, f.status, f.attempts) == ("01098765432", FieldStatus.VALID, 1)  # 정정 실패: 기존 값 유지
    assert call(c, "record_fields", {"pickup_at": TOMORROW})["facts"]["pickup"]["at"] == TOMORROW  # 수거 일시는 받지 않는다


def test_items_replaced_as_whole_and_unspecified():
    """물품은 매번 전체 구성으로 교체(S5 실통화: "중형 두 개" → "중형 아니라 소형" 정정에서 중형이 남으면 안 된다)."""
    c = ctx()
    call(c, "record_fields", {"medium_box_count": 2})
    call(c, "record_fields", {"small_box_count": 2})
    assert c.state.field_of("items").value == Items(small_box_count=2)
    assert call(c, "record_fields", {"small_box_count": 0, "document_count": 0})["code"] == "ITEM_UNSPECIFIED"
    assert call(c, "record_fields", {})["code"] == "NOTHING_TO_RECORD"


def test_address_confirmed_not_found_and_ambiguous(corrector, address):
    c = ctx(address=address)
    out = call(c, "record_fields", {"sender_address": "서울 강남구 태헤란노 이백십일", "sender_address_detail": "3층"})
    s = c.state
    assert s.field_of("sender_address").value == "서울특별시 강남구 테헤란로 211"
    assert s.field_of("sender_address").source == Source.RESOLVER and s.current.sender_geo == Geo(
        GEO.jibun_address, GEO.dong_name, GEO.postal_code)
    assert out["status"] == "ok" and s.field_of("sender_address_detail").value == "3층"
    out = call(c, "record_fields", {"receiver_address": "테헤란로 212", "receiver_address_detail": "403호"})
    assert out["code"] == "ADDRESS_NOT_FOUND" and s.field_of("receiver_address").status == FieldStatus.INVALID
    assert s.field_of("receiver_address_detail").status == FieldStatus.EMPTY  # 못 찾은 주소의 상세주소도 믿지 않는다
    best, *rest = correct(corrector, "서울 강남구 테헤란로 112")["candidates"]
    out = call(c, "record_fields", {"receiver_address": "서울 강남구 테헤란로 112", "receiver_address_detail": "101호"})
    f = s.field_of("receiver_address")
    assert f.value == best and f.candidates == tuple(rest) and out["facts"]["auto_selected"] == ["receiver_address"]


def test_changed_address_without_detail_clears_detail(corrector, address):
    c = ctx(address=address)
    call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 211", "sender_address_detail": "3층"})
    out = call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 212"})
    assert out["facts"]["changed"] == ["sender_address"] and out["facts"]["cleared"] == ["sender_address_detail"]
    assert c.state.field_of("sender_address_detail").status == FieldStatus.EMPTY


def test_address_service_down_keeps_heard_value_without_geo(monkeypatch):
    def broken(text):
        raise RuntimeError("db")
    monkeypatch.setattr(address_resolver, "correct_blocking", broken)
    c = ctx(address=AddressService())
    out = call(c, "record_fields", {"receiver_address": "부산 해운대구 센텀로 10"})
    assert c.state.field_of("receiver_address").value == "부산 해운대구 센텀로 10"
    assert out["facts"]["geo_missing"] == ["receiver_address"] and c.state.current.receiver_geo is None


def test_late_address_result_does_not_overwrite_newer_value(corrector, fake_kakao):
    class Slow(AddressService):
        async def resolve(self, heard):
            await asyncio.sleep(0.05)
            return await super().resolve(heard)

    c = ctx(address=Slow())

    async def race():
        first = asyncio.create_task(run_tool(c, "record_fields", json.dumps({"sender_address": "서울 강남구 테헤란로 211"}), "a"))
        await asyncio.sleep(0.01)
        async with c.lock:
            c.state.record("sender_address", "서울특별시 강남구 테헤란로 212")  # 그사이 다른 값(정정)
        return await first

    out = run(race())
    assert out["code"] == "RESULT_SUPERSEDED" and c.state.field_of("sender_address").value.endswith("212")


def test_full_parcel_opens_readback_with_facts(corrector, address):
    c = ctx(address=address)
    call(c, "record_fields", {"sender_name": "김철수", "sender_address": "서울 강남구 테헤란로 211",
                              "sender_address_detail": "3층"})
    out = call(c, "record_fields", {"receiver_name": "이영희", "receiver_phone": "01098765432",
                                    "receiver_address": "서울 강남구 테헤란로 212", "receiver_address_detail": "",
                                    "small_box_count": 1, "item_price": 30000})
    assert out["can_proceed"] is True and c.state.pending is not None and c.state.pending.issued_t == 100.0
    facts = out["facts"]["readback"]
    assert "sender_phone" not in facts and facts["receiver_phone"] == "01098765432"  # 발신번호는 읽지 않는다


# --- find_destination ---

def place(name, address_, source=Source.PIN, detail="101호"):
    return Place(name, "01098765432", address_, detail, Geo("x", "y", "00000"), source)


def test_personal_place_found_first_and_pick_applies():
    c = ctx(customer=Customer(caller_phone=CALLER, places=(place("이영희", "부산 해운대구 센텀로 10"),
                                                           place("김엄마", "대구 수성구 달구벌대로 2450"))))
    out = call(c, "find_destination", {"name": "김엄마"})
    assert out["status"] == "needs_choice" and len(out["facts"]["labels"]) == 1
    assert apply_pick(c.state, out["facts"]["labels"][0])
    s = c.state
    assert s.field_of("receiver_name").value == "김엄마" and s.field_of("receiver_name").source == Source.PIN
    assert s.current.receiver_geo is not None and s.candidates is None


def company(name="주소하나", organization="주소기업", seq=26):
    return CompanyPlace(name=name, phone="01098765432", address="서울 중구 세종대로 110", address_detail="", geo=None,
                        organization_seq=6, organization_name=organization, membership_seq=seq, customer_seq=seq)


def test_company_search_many_more_none_and_failure():
    db = MockBackend()
    db.company_places = [company(), company("주소둘", seq=27), company("다른사람", "다른기업", seq=28)]
    c = ctx(db)
    out = call(c, "find_destination", {"organization": "주소기업"})
    assert out["code"] == "DEST_MANY" and len(out["facts"]["labels"]) == 2
    assert c.state.candidates.items[0].source == Source.COMPANY
    assert call(c, "find_destination", {"name": "없는분"})["needs"] == [{"field": "receiver_place", "reason": "DEST_NONE"}]
    db.company_places = [company(f"직원{i}", seq=30 + i) for i in range(5)]
    assert call(c, "find_destination", {"organization": "주소기업"})["code"] == "DEST_TOO_MANY"

    class Down(MockBackend):
        async def search_company_places(self, *a, **kw):
            raise httpx2.ConnectError("down")
    out = call(ctx(Down()), "find_destination", {"organization": "주소기업"})
    assert (out["status"], out["code"]) == ("unavailable", "BE_UNAVAILABLE")  # 빈 결과로 오인하지 않는다


# --- 조회·취소 ---

def registered(db):
    db.add_customer(CALLER, "김철수")
    seq = run(db.caller_context(CALLER, {"providerCallId": "live_test", "incomingAt": INCOMING_AT})).call_session_seq
    return Customer(customer_seq=12, caller_phone=CALLER, call_session_seq=seq)


def test_lookup_orders_scope_name_and_selection():
    db = MockBackend()
    cust = registered(db)
    db.add_order(CALLER, "COLLECTING", [("이영희", "부산 해운대구 센텀로 10"), ("박민수", "서울 중구 세종대로 110")])
    db.add_order("01099990000", "COLLECTING", [("이영희", "남의 택배")])
    c = ctx(db, customer=cust)
    out = call(c, "lookup_orders", {"receiver_name": "이영희"})
    assert out["status"] == "ok" and out["facts"]["found"] == 1 and c.state.selected_order["receiver_name"] == "이영희"
    out = call(c, "lookup_orders", {"receiver_name": None})
    assert out["status"] == "needs_choice" and len(c.state.candidates.labels) == 2
    assert call(c, "lookup_orders", {"receiver_name": "없음"})["code"] == "ORDER_NOT_FOUND_BY_NAME"
    assert call(ctx(db), "lookup_orders", {})["code"] == "CALL_NOT_REGISTERED"  # 고객 범위 없으면 조회 안 함


def _order(db, status="COLLECTING"):
    cust = registered(db)
    order_seq = db.add_order(CALLER, status, [("이영희", "부산 해운대구 센텀로 10")])
    return cust, order_seq, db.orders[-1]["parcels"][0]["orderParcelSeq"]


def test_cancel_done_then_duplicate_is_noop():
    db = MockBackend()
    cust, o, p = _order(db)
    c = ctx(db, customer=cust)
    out = run(cancel_parcel(c, o, p))
    assert out.status == "ok" and out.facts["outcome"] == "done" and c.state.cancel_done
    again = run(cancel_parcel(c, o, p))
    assert again.status == "ok" and again.facts["outcome"] == "done"  # 같은 대상 다시: BE를 부르지 않는다


def test_cancel_locked_and_uncertain_then_recheck():
    db = MockBackend()
    cust, o, p = _order(db, "PAID")
    out = run(cancel_parcel(ctx(db, customer=cust), o, p))
    assert (out.status, out.code) == ("rejected", "CANCEL_LOCKED")

    class Flaky(MockBackend):
        fail = True

        async def cancel_parcels(self, *a):
            if Flaky.fail:
                Flaky.fail = False
                await super().cancel_parcels(*a)  # BE에서는 처리됐는데
                raise httpx2.ReadTimeout("응답 유실")   # 응답을 못 받음
            return await super().cancel_parcels(*a)

    db = Flaky()
    cust, o, p = _order(db)
    c = ctx(db, customer=cust)
    first = run(cancel_parcel(c, o, p))
    assert (first.status, first.code) == ("unknown", "CANCEL_OUTCOME_UNKNOWN")  # 완료라고 말하지 않는다
    second = run(cancel_parcel(c, o, p))
    assert second.status == "ok" and second.facts.get("already_done") is True  # 다시 보내기 전에 조회로 확인


# --- search_manual · get_state ---

def rag_result(status="found", score=1.0):
    evidence = [{"chunk_id": "c1", "source_id": "s1", "title": "요금", "content": "소형 4,950원"}] if status == "found" else []
    return {"context": {"question": "소형 요금?", "status": status, "evidence": evidence},
            "reranked": [{"reranker_score": score}]}


def test_search_manual():
    async def rag(q):
        return rag_result()

    async def none(q):
        return rag_result("no_evidence")

    async def broken(q):
        raise RuntimeError("down")

    out = call(ctx(rag=rag), "search_manual", {"question": "소형 요금은?"})
    assert out["status"] == "ok" and out["facts"]["answerable"] is True
    assert call(ctx(rag=rag, rag_min_score=2.0), "search_manual", {"question": "q"})["code"] == "KB_LOW_SCORE"
    assert call(ctx(rag=none), "search_manual", {"question": "q"})["code"] == "KB_NO_EVIDENCE"
    assert call(ctx(), "search_manual", {"question": "q"})["code"] == "KB_UNAVAILABLE"
    assert call(ctx(rag=broken), "search_manual", {"question": "q"})["code"] == "KB_UNAVAILABLE"


def test_get_state_changes_nothing():
    c = ctx()
    v = c.state.state_version
    out = call(c, "get_state", {})
    assert out["status"] == "ok" and out["stage"] == "sender" and c.state.state_version == v


def test_record_rejected_after_order_submitted():
    c = ctx()
    c.state.order_submitted = True  # 접수 후 수정·추가 없음
    out = call(c, "record_fields", {"receiver_name": "이영희"})
    assert out["status"] == "rejected" and out["code"] == "ORDER_SUBMITTED" and c.state.current is None


def test_attached_korean_gil_number_retried_only_when_not_found(corrector, address):
    from app.integrations.address import split_gil
    assert split_gil("구미시 인동구길 7-3") == "구미시 인동 구길 7-3" and split_gil("서울 강남구 테헤란로 212") is None
    r = run(address.resolve("경북 구미 인동구길 7-3"))  # Live가 9를 "구"로 붙여 씀(2026-11-03 통화)
    assert (r.status, r.address) == ("confirmed", "경상북도 구미시 인동9길 7-3")
    assert run(address.resolve("구미시 없는구길 99")).status == "not_found"


def test_spoken_ending_read_both_ways_and_db_decides(corrector, address, monkeypatch):
    """기본주소를 받아쓴 그대로 넘김(backend_rules.md) → 말끝 "이요"는 두 해석을 다 찾아 실제 주소인 쪽."""
    from app.integrations.address import endings
    assert endings("테헤란로 이일이요") == ["테헤란로 이일", "테헤란로 이일이"]  # 일(받침) + 이요 / 이일이 + 요
    assert endings("테헤란로 이백십이요") == ["테헤란로 이백십", "테헤란로 이백십이"]
    assert endings("인동 구길 사이요") == ["인동 구길 사이"]  # 받침 없는 글자 뒤 "이요"는 "요"만
    assert endings("테헤란로 이백십일입니다") == ["테헤란로 이백십일"] and endings("테헤란로 212") == []
    r = run(address.resolve("서울 강남구 테헤란로 이백십이요"))  # 210은 없고 212는 있음
    assert (r.status, r.address) == ("confirmed", "서울특별시 강남구 테헤란로 212")
    r = run(address.resolve("서울 강남구 테헤란로 이백십일이요"))  # 이백십일(211)·이백십일이(보정기도 212로 읽음) 둘 다 있음
    assert (r.status, r.address, r.alternatives) == ("ambiguous", "서울특별시 강남구 테헤란로 211", ("서울특별시 강남구 테헤란로 212",))
    assert run(address.resolve("경북 구미 인동구길 칠 다시 삼이요")).address == "경상북도 구미시 인동9길 7-3"  # 말끝 + 붙인 길
    # 두 해석이 다 실제 주소면 확정하지 않고 후보 둘
    real = {"서울 강남구 테헤란로 이일": "서울특별시 강남구 테헤란로 21", "서울 강남구 테헤란로 이일이": "서울특별시 강남구 테헤란로 212"}
    monkeypatch.setattr(address_resolver, "correct_blocking", lambda t: {"status": "confirmed", "address": real[t],
                        "candidates": [real[t]]} if t in real else {"status": "not_found", "address": None, "candidates": []})
    r = run(address.resolve("서울 강남구 테헤란로 이일이요"))
    assert r.status == "ambiguous" and (r.address, r.alternatives) == (real["서울 강남구 테헤란로 이일"],
                                                                       (real["서울 강남구 테헤란로 이일이"],))


def test_building_name_after_comma_retried_only_when_not_found(corrector, address):
    from app.integrations.address import retries
    assert retries("구미시 인동9길 7-3, 무슨빌라") == ["구미시 인동9길 7-3"] and retries("서울 강남구 테헤란로 212") == []
    r = run(address.resolve("경북 구미시 인동9길 7-3, 리버뷰 신안 인스빌"))  # Live가 건물 이름을 붙여 넘김(2026-11-03 통화)
    assert (r.status, r.address) == ("confirmed", "경상북도 구미시 인동9길 7-3")
    assert run(address.resolve("구미시 없는구길 99, 어딘가")).status == "not_found"



def test_pickup_default_moves_to_next_morning_and_customer_range_is_checked():
    """업무 규칙 a: 기본 = 지금 + 1시간(10분 올림), 09시 전 → 당일 09시, 17시 넘음 → 익일 09시. 조정은 09~17시·1시간 이후·3일 이내."""
    from app.domain.pickup import check_pickup, default_pickup, rule_of
    r = rule_of(P.pickup)
    at = lambda h, m=0, d=3: datetime(2026, 11, d, h, m, tzinfo=KST)  # noqa: E731
    assert default_pickup(at(10, 3), r) == ("2026-11-03T11:10:00+09:00", False)
    assert default_pickup(at(6), r) == ("2026-11-03T09:00:00+09:00", False)
    assert default_pickup(at(16), r) == ("2026-11-03T17:00:00+09:00", False)  # 17시 정각 허용
    assert default_pickup(at(16, 30), r) == ("2026-11-04T09:00:00+09:00", True)  # 금일 불가 → 익일 09시
    now = at(10)
    assert check_pickup(at(10, 30).isoformat(), now, r) == "PICKUP_TOO_SOON"
    assert check_pickup(at(18, 0, 4).isoformat(), now, r) == "PICKUP_OUT_OF_HOURS"
    assert check_pickup(at(10, 0, 7).isoformat(), now, r) == "PICKUP_TOO_FAR"
    assert check_pickup(at(10, 0, 6).isoformat(), now, r) is None


def test_record_rejects_pickup_out_of_hours_with_allowed_range():
    c = ctx()
    out = call(c, "record_fields", {"pickup_at": (NOW + timedelta(days=1)).replace(hour=20).isoformat()})
    assert out["code"] == "PICKUP_OUT_OF_HOURS" and "09:00~17:00" in out["facts"]["pickup"]["allowed"]
    assert not c.state.pickup_at.valid
