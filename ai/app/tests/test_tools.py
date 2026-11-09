"""S3 도구·실행기·주소 서비스·취소. 실제 OpenAI·BE·카카오·RAG 없이(가짜 BE, 작은 주소DB, 가짜 카카오)."""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx2
import pytest
from conftest import CALLER, GEO, INCOMING_AT, run

from app.address.gazetteer import AddressDB
from app.address.matcher import correct
from app.domain.candidates import apply_pick
from app.domain.rules import normalize_phone, parse_pickup
from app.domain.state import ConversationState, Customer, FieldStatus, Geo, Items, Place, Source
from app.integrations.address import AddressService
from app.integrations.backend.gateway import BackendGateway
from app.policy.model import load_policy
from app.tests.address_sample_db import build_sample_db
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
def corrector(tmp_path):
    return AddressDB(build_sample_db(tmp_path / "address.db"))


@pytest.fixture
def address(corrector, fake_kakao):
    return AddressService(corrector)


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


def test_document_price_clears_when_a_box_is_added_and_accepts_box_value():
    c = ctx()
    out = call(c, "record_fields", {"document_count": 2})
    assert "item_price" not in out["missing"]
    assert c.state.current["item_price"].source == Source.SERVER

    call(c, "record_fields", {"item_price": 9000})
    assert c.state.current["item_price"].value == 1

    out = call(c, "record_fields", {"document_count": 2, "small_box_count": 1})
    assert "item_price" in out["facts"]["cleared"] and "item_price" in out["missing"]
    assert c.state.current["item_price"].value is None

    call(c, "record_fields", {"item_price": 30000})
    assert c.state.current["item_price"].value == 30000
    assert c.state.current["item_price"].source == Source.CUSTOMER


def test_address_confirmed_not_found_and_ambiguous(corrector, address):
    c = ctx(address=address)
    out = call(c, "record_fields", {"sender_address": "서울 강남구 태헤란노 이백십일", "sender_address_detail": "3층"})
    s = c.state
    assert s.field_of("sender_address").value == "서울특별시 강남구 테헤란로 211"
    assert s.field_of("sender_address").source == Source.RESOLVER and s.current.sender_geo == Geo(
        GEO.jibun_address, GEO.dong_name, GEO.postal_code)
    assert out["status"] == "ok" and s.field_of("sender_address_detail").value == "3층"
    out = call(c, "record_fields", {"receiver_address": "서울 강남구 없는로 12", "receiver_address_detail": "403호"})
    assert out["code"] == "ADDRESS_NOT_FOUND" and s.field_of("receiver_address").status == FieldStatus.INVALID
    assert s.field_of("receiver_address_detail").value == "403호"  # 상세주소는 기본주소와 독립 — 다시 묻지 않는다(결정 1)
    best, *rest = correct(corrector, "서울 강남구 대해남노 211").candidates  # 도로명을 많이 고쳐 확정하지 않는 주소
    out = call(c, "record_fields", {"receiver_address": "서울 강남구 대해남노 211", "receiver_address_detail": "101호"})
    f = s.field_of("receiver_address")
    assert f.value == best and f.candidates == tuple(rest) and out["facts"]["auto_selected"] == ["receiver_address"]


def test_changed_road_without_detail_clears_detail_but_number_fix_keeps_it(corrector, address):
    c = ctx(address=address)
    call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 211", "sender_address_detail": "3층"})
    out = call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 212"})  # 같은 도로의 번호 정정(결정 2)
    assert out["facts"]["changed"] == ["sender_address"] and "cleared" not in out["facts"]
    assert c.state.field_of("sender_address_detail").value == "3층"
    out = call(c, "record_fields", {"sender_address": "서울 송파구 올림픽로 300"})
    assert out["facts"]["cleared"] == ["sender_address_detail"]
    assert c.state.field_of("sender_address_detail").status == FieldStatus.EMPTY


def test_server_splits_detail_from_heard_sentence_and_converts_numerals(corrector, address):
    c = ctx(address=address)
    s = c.state
    out = call(c, "record_fields", {"sender_address": "경북 구미시 인동구길 칠다시삼 이백삼호요"})  # 한 문장 통째로
    assert s.field_of("sender_address").value == "경상북도 구미시 인동9길 7-3"
    assert s.field_of("sender_address_detail").value == "203호" and s.field_of("sender_address_detail").source == Source.RESOLVER
    assert set(out["facts"]["recorded"]) == {"sender_address", "sender_address_detail"}
    # 모델이 나눠 넘긴 상세의 수사도 서버가 숫자로. 기본주소에 꼬리가 있으면 서버가 뗀 상세가 우선(결정 3: 번호 뒤 이름도 상세)
    call(c, "record_fields", {"receiver_address": "서울 강남구 테헤란로 212 멀티캠퍼스 십팔층", "receiver_address_detail": "십팔층"})
    assert s.field_of("receiver_address").value == "서울특별시 강남구 테헤란로 212"
    assert s.field_of("receiver_address_detail").value == "멀티캠퍼스 18층"
    call(c, "record_fields", {"receiver_address_detail": "삼백십이동 사백삼호"})
    assert s.field_of("receiver_address_detail").value == "312동 403호"
    out = call(c, "record_fields", {"receiver_address": "서울 강남구 없는로 12 지하 이층"})  # 못 찾아도 상세는 남는다
    assert out["code"] == "ADDRESS_NOT_FOUND" and s.field_of("receiver_address_detail").value == "지하 2층"


def test_address_service_down_keeps_heard_value_without_geo(corrector, monkeypatch):
    def broken(db, text):
        raise RuntimeError("db")
    monkeypatch.setattr("app.address.matcher.resolve", broken)
    c = ctx(address=AddressService(corrector))
    out = call(c, "record_fields", {"receiver_address": "부산 해운대구 센텀로 10"})
    assert c.state.field_of("receiver_address").value == "부산 해운대구 센텀로 10"
    assert out["facts"]["geo_missing"] == ["receiver_address"] and c.state.current.receiver_geo is None


def test_late_address_result_does_not_overwrite_newer_value(corrector, fake_kakao):
    class Slow(AddressService):
        async def resolve(self, heard):
            await asyncio.sleep(0.05)
            return await super().resolve(heard)

    c = ctx(address=Slow(corrector))

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
    # 저장 대상은 상태에만 두고 담을 때 묻지 않고 저장한다(2026-11-06)
    assert "address_save" not in out["facts"] and c.state.address_offer == {"sender": True, "receiver": True}


def test_same_values_after_release_reopen_readback_but_not_while_awaiting_fix(corrector, address):
    """no·change로 확인 대기를 푼 뒤(운영 통화 56c133c8): 고친 값이 기록되기 전 같은 값은 NOTHING_CHANGED만,
    고친 값이 기록된 뒤 같은 값을 다시 말하면 되읽기로 대기를 다시 연다. 대기가 있으면 되읽기를 또 주지 않는다."""
    from app.domain.confirm import release
    c = ctx(address=address)
    call(c, "record_fields", {"sender_name": "김철수", "sender_address": "서울 강남구 테헤란로 211",
                              "sender_address_detail": "3층"})
    call(c, "record_fields", {"receiver_name": "이영희", "receiver_phone": "01098765432",
                              "receiver_address": "서울 강남구 테헤란로 212", "receiver_address_detail": "",
                              "small_box_count": 1, "item_price": 30000})
    again = call(c, "record_fields", {"receiver_name": "이영희"})
    assert again["code"] == "NOTHING_CHANGED" and "readback" not in again.get("facts", {})  # 대기 유지, 되읽기 반복 없음
    assert release(c.state, c.state.pending.id) and c.state.awaiting_fix and c.state.pending is None
    same = call(c, "record_fields", {"receiver_name": "이영희"})
    assert same["code"] == "NOTHING_CHANGED" and c.state.pending is None                   # 고칠 값을 기다린다
    fixed = call(c, "record_fields", {"client_comment": "승용차"})
    assert c.state.pending and "readback" in fixed["facts"] and not c.state.awaiting_fix    # 정정 기록 → 새 되읽기
    release(c.state, c.state.pending.id)
    c.state.awaiting_fix = False                                                             # 정정이 다른 경로로 끝난 뒤
    reopened = call(c, "record_fields", {"receiver_name": "이영희"})
    assert reopened["code"] == "NOTHING_CHANGED" and reopened["facts"]["readback"]["receiver_name"] == "이영희"
    assert c.state.pending is not None


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


def test_lookup_orders_refuses_other_customer_and_states_scope():
    """운영 통화 c156341e: 다른 번호로 접수된 택배를 찾자 본인 주문을 '그 번호로 접수된 건'이라 안내함.
    다른 번호·다른 고객 접수는 BE를 부르지 않고 거절하고, 모든 조회 결과에 '이 번호만'이라는 범위를 싣는다."""
    from app.tools.lookup import OTHER_CUSTOMER, SCOPE
    db = MockBackend()
    cust = registered(db)
    db.add_order(CALLER, "COLLECTING", [("이영희", "부산 해운대구 센텀로 10")])
    db.add_order("01099990000", "ACCEPTED", [("김일", "남의 택배")])
    c = ctx(db, customer=cust)
    out = call(c, "lookup_orders", {"receiver_name": None, "other_customer": True})
    assert out == {"status": "rejected", "code": "ORDER_OTHER_CUSTOMER", "facts": {"found": 0, "scope": OTHER_CUSTOMER}}
    assert c.state.selected_order is None and c.state.candidates is None
    assert "다른 고객의 접수 정보는 안내드릴 수 없" in OTHER_CUSTOMER
    assert call(c, "lookup_orders", {"receiver_name": "김일"})["facts"] == {"found": 0, "scope": SCOPE}  # 남의 주문은 안 보임
    assert call(c, "lookup_orders", {"receiver_name": "이영희"})["facts"]["scope"] == SCOPE


def test_lookup_orders_gives_status_meaning_not_pickup():
    """통화 293: COLLECTING을 '수거 진행 중'으로 안내함 → 서버가 상태의 뜻을 같이 준다(수거·배송·결제 언급 없음)."""
    from app.tools.lookup import ORDER_STATUS_TEXT, status_text
    db = MockBackend()
    cust = registered(db)
    db.add_order(CALLER, "COLLECTING", [("홍길동", "부산 해운대구 센텀로 10")])
    [order] = call(ctx(db, customer=cust), "lookup_orders", {"receiver_name": "홍길동"})["facts"]["orders"]
    assert order["status"] == "COLLECTING" and order["status_text"].startswith("접수 미완료")
    statuses = ("COLLECTING", "notPaid", "PAID", "SUBMITTING", "ACCEPTED", "SUBMISSION_FAILED", "CANCELLED")
    assert set(ORDER_STATUS_TEXT) == set(statuses)  # BE 계약의 주문 상태 전부
    assert not any(w in text for text in ORDER_STATUS_TEXT.values() for w in ("수거", "배송", "결제 완료", "결제 전"))
    assert ORDER_STATUS_TEXT["ACCEPTED"] == "접수 완료"
    assert status_text("SOMETHING_NEW") == status_text(None) == "확인 필요"  # 모르는 상태는 추측하지 않는다


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
    from app.address.parse import split_gil
    assert split_gil("구미시 인동구길 7-3") == "구미시 인동 구길 7-3" and split_gil("서울 강남구 테헤란로 212") is None
    r = run(address.resolve("경북 구미 인동구길 7-3"))  # Live가 9를 "구"로 붙여 씀(2026-11-03 통화)
    assert (r.status, r.address) == ("confirmed", "경상북도 구미시 인동9길 7-3")
    assert run(address.resolve("구미시 없는구길 99")).status == "not_found"


def test_building_name_after_comma_retried_only_when_not_found(corrector, address):
    from app.address.parse import cut_trailing
    assert cut_trailing("구미시 인동9길 7-3, 무슨빌라") == ["구미시 인동9길 7-3"] and cut_trailing("서울 강남구 테헤란로 212") is None
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


def test_name_only_address_asks_to_confirm_district_and_dong(corrector, address):
    """'올리브영 OO점'처럼 이름만 말한 주소는 기록하되 facts.confirm_area로 구·동만 확인시킨다(S15P31D109-165). 번호가 있으면 없다."""
    c = ctx(address=address)
    out = call(c, "record_fields", {"receiver_address": "송파구 롯데월드타워"})
    assert out["status"] == "ok" and out["facts"]["confirm_area"] == {"receiver_address": "송파구 신천동"}
    assert c.state.field_of("receiver_address").value == "서울특별시 송파구 올림픽로 300"
    out = call(c, "record_fields", {"receiver_address": "서울 강남구 테헤란로 212"})
    assert "confirm_area" not in out["facts"]


def test_place_not_in_book_is_recorded_as_receiver_address(corrector, address):
    """주소록·기업에 없는 장소(상호·지점 이름)는 find_destination이 받는 곳 주소로 찾아 기록한다 — 운영 통화 a97347a8에서
    모델이 DEST_NONE 뒤 주소로 넘기지 않아 '다이소 구미 인동점'을 못 찾았다. 이름만으로 찾았으니 구·동 확인을 붙인다."""
    c = ctx(address=address)
    out = call(c, "find_destination", {"name": "한태원", "place": "송파구 롯데월드타워", "detail": "3층"})
    assert out["status"] == "ok" and out["facts"]["found"] == 0 and out["facts"]["confirm_area"] == {"receiver_address": "송파구 신천동"}
    s = c.state
    assert (s.field_of("receiver_name").value, s.field_of("receiver_address").value, s.field_of("receiver_address_detail").value)         == ("한태원", "서울특별시 송파구 올림픽로 300", "3층")
    out = call(c, "find_destination", {"organization": "없는기업", "place": "없는로 12"})  # 기업명도 붙여 찾는다
    assert out["code"] == "ADDRESS_NOT_FOUND" and s.field_of("receiver_address").value == "서울특별시 송파구 올림픽로 300"


def test_address_in_several_regions_asks_region(corrector, address):
    """같은 주소가 여러 시군구에 있으면 기록하지 않고 지역을 되묻는다(ADDRESS_REGION_NEEDED). 모델은 heard와 지역을 합쳐 다시 넘긴다."""
    c = ctx(address=address)
    out = call(c, "record_fields", {"receiver_address": "중앙로 232"})
    assert out["code"] == "ADDRESS_REGION_NEEDED" and out["needs"][0]["heard"] == "중앙로 232"
    assert set(out["needs"][0]["regions"]) == {"서울특별시 양천구", "경기도 고양시 덕양구"}
    assert c.state.field_of("receiver_address").status == FieldStatus.INVALID
    out = call(c, "record_fields", {"receiver_address": "양천구 중앙로 232"})
    assert out["status"] == "ok" and c.state.field_of("receiver_address").value == "서울특별시 양천구 중앙로 232"
