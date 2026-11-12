"""S3 도구·실행기·주소 서비스·취소. 실제 OpenAI·BE·카카오·RAG 없이(가짜 BE, 작은 주소DB, 가짜 카카오)."""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx2
import pytest
from conftest import CALLER, GEO, INCOMING_AT, run

from app.address.gazetteer import AddressDB
from app.address.matcher import correct
from app.domain.candidates import apply_pick, offer
from app.domain.rules import normalize_phone, parse_pickup
from app.domain.state import ConversationState, Customer, FieldStatus, Geo, Items, Place, Source, draft_snapshot
from app.domain.store import open_for_edit, snapshot_for_submit
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


def complete_sender_address(c: ToolContext) -> None:
    c.state.record("sender_address", "서울특별시 강남구 테헤란로 211")
    c.state.record("sender_address_detail", "")


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
    ("031 1234 5678", "03112345678"), ("1588-1234", None), ("일육공공 일이삼사", None),
    ("02-1234-56789", None), ("032-12-3456", None), ("070-1234-5678", "07012345678"),
    ("070-123-4567", None), ("019-1234-5678", "01912345678"), ("050-1234-5678", None),
    ("12345", None), ("0212", None),
    ("010-283-54286", "01028354286"),  # S0d 19:07: 잘못 받아쓴 번호도 11자리면 통과 — 자릿수 검사로는 못 잡고 되읽기로 잡는다
    ("공일공 하나다섯여섯일곱 여덟아홉팔이요", "01015678982"),
    ("공일공 하 나둘셋넷 다섯여섯일 곱여덟", "01012345678"),
    ("영일빵 일이삼사 사팔팔이요", "01012344882"),
    ("공일공 일이삼사 사팔팔", None),
    ("010-1234-4882이요", "01012344882"),
    ("02-1234-488이요", None),  # 두 해석 모두 기존 유선 번호 자릿수를 만족
    ("010-1234-4882 또는 4883", None),
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
    assert out["facts"]["receiver_phone_readback"] == "01098765432"
    assert s.field_of("sender_phone").source == Source.CALLER_ID  # 발신번호는 서버가 채운다
    assert out["fields"]["receiver_name"] == "valid" and "sender_phone" not in out["fields"]
    assert out["missing"][0] == "sender_address" and out["stage"] == "address"  # 등록 고객 성함은 이미 채워짐


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


def test_receiver_phone_correction_reasks_and_hides_unresolved_number_from_submission():
    from app.tests.test_domain import confirm_once, filled

    c = ctx()
    c.state = filled()
    parcel_id = confirm_once(c.state)
    open_for_edit(c.state, parcel_id)
    previous = c.state.field_of("receiver_phone").value

    unclear = call(c, "record_fields", {"receiver_phone": "02-1234-488이요"})
    assert unclear["code"] == "PHONE_AMBIGUOUS"
    assert unclear["facts"]["phone_question"] == "받는 분 연락처를 처음부터 한 자리씩 다시 말씀해 주세요."
    assert not unclear["can_proceed"]
    assert c.state.field_of("receiver_phone").value == previous
    assert "receiver_phone" not in draft_snapshot(c.state.current)
    assert snapshot_for_submit(c.state) == []

    short = call(c, "record_fields", {"receiver_phone": "끝 네 자리 사팔팔"})
    assert short["code"] == "PHONE_INVALID_DIGITS"
    assert short["facts"]["phone_question"] == "마지막 네 자리를 한 자리씩 다시 말씀해 주세요."

    corrected = call(c, "record_fields", {"receiver_phone": "끝 네 자리 사팔팔이요"})
    assert corrected["facts"]["receiver_phone_readback"] == previous[:-4] + "4882"
    assert not c.state.current.receiver_phone_pending
    assert corrected["can_proceed"]


def test_invalid_receiver_phone_closes_confirmation_and_same_number_can_reopen_it():
    from app.domain.confirm import issue_parcel_confirmation
    from app.tests.test_domain import filled

    c = ctx()
    c.state = filled()
    previous = c.state.field_of("receiver_phone").value
    pending = issue_parcel_confirmation(c.state, P, c.clock())
    assert pending
    call(c, "record_fields", {"receiver_phone": "4882"})
    assert c.state.pending is None
    assert issue_parcel_confirmation(c.state, P, c.clock()) is None

    recovered = call(c, "record_fields", {"receiver_phone": previous})
    assert recovered["facts"]["receiver_phone_readback"] == previous
    assert c.state.pending and c.state.pending.id != pending.id


def test_item_changes_preserve_unmentioned_counts_and_respect_explicit_removal():
    c = ctx()
    call(c, "record_fields", {"document_count": 10, "medium_box_count": 2})
    call(c, "record_fields", {"small_box_count": 2})
    assert c.state.field_of("items").value == Items(document_count=10, small_box_count=2, medium_box_count=2)
    call(c, "record_fields", {"medium_box_count": 0, "small_box_count": 3})
    assert c.state.field_of("items").value == Items(document_count=10, small_box_count=3)
    assert call(c, "record_fields", {"small_box_count": 0, "document_count": 0})["code"] == "ITEM_UNSPECIFIED"
    assert not c.state.field_of("items").valid
    assert call(c, "record_fields", {})["code"] == "NOTHING_TO_RECORD"


def test_additional_box_without_a_size_blocks_old_readback_until_resolved():
    from app.domain.confirm import commit_parcel, issue_parcel_confirmation
    from app.tests.test_domain import filled

    c = ctx()
    c.state = filled(items=Items(document_count=10, small_box_count=1))
    previous = issue_parcel_confirmation(c.state, c.policy, 100)
    c.item_utterance = (1, "전자제품도 하나 보낼게요")
    out = call(c, "record_fields", {"box_size_needed": "전자제품도 하나 보낼게요"})
    assert out["code"] == "ITEM_BOX_SIZE_NEEDED" and out["box_size_pending"]
    assert out["fields"]["items"] == "pending_choice" and not out["can_proceed"]
    assert c.state.pending is None and commit_parcel(c.state, c.policy, previous.id) is None
    assert "readback" not in call(c, "record_fields", {"item_price": 40000})["facts"]
    c.item_utterance = (2, "그건 소형 박스 하나요")
    args = {"small_box_count": 1, "add_item_counts": ["small_box_count"]}
    out = call(c, "record_fields", args)
    assert "readback" in out["facts"]
    call(c, "record_fields", args)
    assert c.state.current["items"].value == Items(document_count=10, small_box_count=2)
    assert not c.state.current.box_size_pending


def test_limits_apply_after_merging_existing_counts():
    c = ctx()
    initial = Items(document_count=100, medium_box_count=10)
    c.state.record("items", initial)
    c.state.record("item_price", 10000)
    out = call(c, "record_fields", {"small_box_count": 1, "document_count": 1, "item_price": 20000,
                                    "add_item_counts": ["document_count"]})
    assert {need["reason"] for need in out["needs"]} == {"ITEM_BOX_LIMIT", "ITEM_DOCUMENT_LIMIT"}
    assert c.state.current["items"].value == initial
    assert c.state.current["item_price"].value == 10000
    out = call(c, "record_fields", {"medium_box_count": 9, "small_box_count": 1, "document_count": 100})
    assert out["status"] == "ok" and not c.state.current.item_issues


def test_documents_only_value_does_not_carry_over_when_goods_are_added():
    from app.domain.state import draft_snapshot
    from app.tests.test_domain import filled

    c = ctx()
    c.state = filled(items=Items(document_count=10))
    out = call(c, "record_fields", {"item_price": 80000})
    assert "readback" in out["facts"]
    assert draft_snapshot(c.state.current)["item_price"] == 1
    out = call(c, "record_fields", {"small_box_count": 1})
    assert out["missing"] == ["item_price"] and "item_price" not in draft_snapshot(c.state.current)
    out = call(c, "record_fields", {"item_price": 100000})
    assert draft_snapshot(c.state.current)["item_price"] == 100000
    out = call(c, "record_fields", {"document_count": 20})
    assert draft_snapshot(c.state.current)["item_price"] == 100000
    out = call(c, "record_fields", {"small_box_count": 0})
    assert draft_snapshot(c.state.current)["item_price"] == 1


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


def test_changed_address_without_detail_clears_detail(corrector, address):
    c = ctx(address=address)
    call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 211", "sender_address_detail": "3층"})
    out = call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 211"})  # 같은 주소를 다시 말함: 유지
    assert "cleared" not in out.get("facts", {}) and c.state.field_of("sender_address_detail").value == "3층"
    out = call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 212"})  # 같은 도로의 번호만 바뀌어도 비운다
    assert out["facts"]["cleared"] == ["sender_address_detail"] and "sender_address_detail" in out["missing"]
    assert c.state.field_of("sender_address_detail").status == FieldStatus.EMPTY
    call(c, "record_fields", {"sender_address_detail": "5층"})
    out = call(c, "record_fields", {"sender_address": "서울 송파구 올림픽로 300"})
    assert out["facts"]["cleared"] == ["sender_address_detail"]
    out = call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 211", "sender_address_detail": "7층"})
    assert "cleared" not in out["facts"] and c.state.field_of("sender_address_detail").value == "7층"
    # 서버가 문장에서 뗀 상세가 같이 오면 지우지 않고 그 상세로 바꾼다
    out = call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 212 구층"})
    assert "cleared" not in out["facts"] and c.state.field_of("sender_address_detail").value == "9층"


@pytest.mark.parametrize(("has_pin", "receiver_provided"), [(False, True), (True, True), (True, False)])
def test_sender_address_change_finishes_before_receiver_questions(address, has_pin, receiver_provided):
    from app.domain.address_book import request_sender_address_change

    c = ctx(address=address)
    origin = Place("김철수", CALLER, "서울특별시 강남구 테헤란로 212", "1201호", source=Source.PROFILE)
    c.state.customer.origin_place = origin
    c.state.origin_offered = c.state.origin_mentioned_in_greeting = True
    if has_pin:
        c.state.customer.places = (Place("이영희", CALLER, origin.address, "5층", source=Source.PIN),)

    out = call(c, "get_state", {})
    assert out["origin_confirm"] == "registered" and out["missing"] == []
    request_sender_address_change(c.state)
    out = call(c, "get_state", {})
    assert out["stage"] == "address" and out["missing"] == ["sender_address"]

    out = call(c, "record_fields", {"sender_address": "서울 강남구 없는로 12"})
    assert out["code"] == "ADDRESS_NOT_FOUND" and out["missing"] == ["sender_address"]

    fields = {"sender_address": "서울 강남구 테헤란로 211"}
    if receiver_provided:
        fields.update(receiver_name="이영희", receiver_address=origin.address)
    out = call(c, "record_fields", fields)
    assert out["sender_change_next"] == "sender_address_detail"
    assert out["missing"] == ["sender_address_detail"] and not c.state.candidates
    assert "confirm_route" not in out["facts"]
    assert (out["fields"]["receiver_name"] == "valid") is receiver_provided
    assert call(c, "get_state", {})["missing"] == ["sender_address_detail"]

    out = call(c, "record_fields", {"sender_address_detail": ""})
    assert out["fields"]["sender_address_detail"] == "valid" and "sender_change_next" not in out
    assert out["missing"][0] == ("receiver_phone" if receiver_provided else "receiver_name")
    if has_pin and receiver_provided:
        assert out["status"] == "needs_choice" and c.state.candidates
    elif receiver_provided:
        assert "confirm_route" in out["facts"]
    else:
        assert not c.state.candidates


@pytest.mark.parametrize("direct_address", ["same", "new_with_detail", "invalid_with_detail"])
def test_spoken_address_answers_pending_origin_choice(address, direct_address):
    from app.domain.address_book import begin_sender_name_change, prefill_sender

    c = ctx(address=address)
    st = c.state
    st.customer.origin_place = Place("김철수", CALLER, "서울특별시 강남구 테헤란로 212", "1201호", source=Source.PROFILE)
    prefill_sender(st, full=True)
    begin_sender_name_change(st)
    assert call(c, "record_fields", {"sender_name": "박영희"})["sender_change_next"] == "ask_address_change"

    fields = {"sender_address": {"same": "서울 강남구 테헤란로 212",
                                "new_with_detail": "서울 강남구 테헤란로 211",
                                "invalid_with_detail": "서울 강남구 없는로 12"}[direct_address]}
    if direct_address != "same":
        fields["sender_address_detail"] = "3층"
    out = call(c, "record_fields", fields)
    if direct_address == "same":
        assert st.origin_answer is True and not st.current.sender_address_change
        assert st.current["sender_address_detail"].value == "1201호"
    else:
        assert st.origin_answer is False and st.current.sender_address_change
        assert st.current["sender_address_detail"].value == "3층"
    if direct_address == "invalid_with_detail":
        assert out["code"] == "ADDRESS_NOT_FOUND" and out["missing"] == ["sender_address"]
        assert not st.current["sender_address"].valid
        out = call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 211"})
        assert st.current["sender_address_detail"].value == "3층"
    assert out["sender_change_next"] == "ask_name_save"
    assert "address_detail_question" not in out


def test_ordinary_sender_and_receiver_use_same_short_detail_question(address):
    c = ctx(address=address)
    out = call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 211",
                                    "receiver_name": "이영희", "receiver_phone": CALLER,
                                    "receiver_address": "서울 강남구 테헤란로 212"})
    assert out["missing"][0] == "sender_address_detail"
    assert out["address_detail_question"] == "상세주소를 알려주시겠어요?"
    out = call(c, "record_fields", {"sender_address_detail": ""})
    assert out["missing"][0] == "receiver_address_detail"
    assert out["address_detail_question"] == "상세주소를 알려주시겠어요?"


def test_registered_name_scope_after_receiver_and_after_another_correction():
    from dataclasses import replace

    from app.domain.address_book import save_offer

    c = ctx()
    call(c, "record_fields", {"receiver_name": "이영희"})
    out = call(replace(c, sender_name_scope="once"), "record_fields", {"sender_name": "박영희"})
    assert "sender_change_next" not in out and "name" not in save_offer(c.state)
    assert not c.state.current.sender_name_for_parcel  # 접수 초반 주소 확인을 다시 열지 않는다.
    out = call(replace(c, sender_name_scope="save"), "record_fields", {"sender_name": "최영희"})
    assert "sender_change_next" not in out and save_offer(c.state)["name"]
    out = call(c, "record_fields", {"sender_name": "한영희"})
    assert out["sender_change_next"] == "ask_name_save" and "name" not in save_offer(c.state)


def test_sender_name_scope_starts_after_first_registration():
    from app.domain.address_book import save_offer

    customer = Customer(status="UNREGISTERED", caller_phone=CALLER)
    c = ctx(customer=customer)
    out = call(c, "record_fields", {"sender_name": "김철수"})
    assert "sender_change_next" not in out and not save_offer(c.state)

    customer.status, customer.customer_seq, customer.name = "REGISTERED", 12, "김철수"
    out = call(c, "record_fields", {"sender_name": "박영희"})
    assert out["sender_change_next"] == "ask_name_save" and "name" not in save_offer(c.state)


def test_explicit_destination_waits_for_sender_and_is_not_carried_to_another_draft(address):
    from app.domain.address_book import request_sender_address_change
    from app.domain.state import copy_draft

    c = ctx(address=address)
    st = c.state
    st.customer.places = (Place("이영희", CALLER, "서울특별시 강남구 테헤란로 212", "5층", source=Source.PIN),)
    request_sender_address_change(st)
    out = call(c, "find_destination", {"name": "이영희"})
    assert out["missing"] == ["sender_address"] and st.candidates is None
    assert "labels" not in out.get("facts", {}) and st.current.deferred_destination
    assert copy_draft(st.current).deferred_destination is None
    out = call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 211"})
    assert out["missing"] == ["sender_address_detail"] and st.candidates is None
    assert call(c, "get_state", {"include_values": True}).get("facts", {}).get("candidates") is None
    out = call(c, "record_fields", {"sender_address_detail": ""})
    assert out["status"] == "needs_choice" and st.candidates.kind == "destination"
    assert st.current.deferred_destination is None
    assert call(c, "get_state", {})["destination_choices"] == list(st.candidates.labels)


@pytest.mark.parametrize(("tool", "name_field"), [("record_fields", "receiver_name"), ("find_destination", "name")])
def test_ordinary_order_offers_destination_only_after_sender_address(address, tool, name_field):
    c = ctx(address=address)
    c.state.customer.places = (Place("이영희", CALLER, "서울특별시 강남구 테헤란로 212", "5층", source=Source.PIN),)

    out = call(c, tool, {name_field: "이영희"})
    assert out["status"] == "ok" and out["missing"][0] == "sender_address"
    assert "destination_choices" not in out and "labels" not in out.get("facts", {})
    assert c.state.candidates is None and c.state.current.deferred_destination

    out = call(c, "record_fields", {"sender_address": "서울 강남구 테헤란로 211"})
    assert out["missing"] == ["sender_address_detail"]
    assert out["address_detail_question"] == "상세주소를 알려주시겠어요?"
    assert "candidates" not in call(c, "get_state", {"include_values": True}).get("facts", {})

    out = call(c, "record_fields", {"sender_address_detail": ""})
    assert out["status"] == "needs_choice" and out["destination_choices"] == out["facts"]["labels"]
    assert apply_pick(c.state, out["destination_choices"][0])
    assert c.state.current["receiver_address_detail"].value == "5층"


def test_partial_destination_address_retry_preserves_recipient_and_uses_new_address(address):
    from app.domain.candidates import apply_destination_change

    c = ctx(address=address)
    complete_sender_address(c)
    original = place("이영희", "서울특별시 강남구 테헤란로 212")
    other_pin = place("이영희", "서울특별시 강남구 테헤란로 211", detail="4층")
    c.state.customer.places = (original, other_pin)
    offer(c.state, "destination", ("이영희",), (original,))
    apply_destination_change(c.state, 0, "address")

    out = call(c, "record_fields", {"receiver_address": "서울 강남구 없는로 12"})
    assert out["code"] == "ADDRESS_NOT_FOUND" and out["missing"][0] == "receiver_address"
    assert out["fields"]["receiver_name"] == out["fields"]["receiver_phone"] == "valid"
    assert c.state.current.receiver_geo is None
    assert call(c, "find_destination", {"place": other_pin.address})["code"] == "DEST_CHANGE_USE_RECORD"

    out = call(c, "record_fields", {"receiver_address": other_pin.address, "receiver_address_detail": ""})
    assert out["status"] == "ok" and "destination_choices" not in out
    draft = c.state.current
    assert draft["receiver_name"].value == original.name and draft["receiver_phone"].value == original.phone
    assert draft["receiver_address"].value == other_pin.address and draft["receiver_address_detail"].value == ""
    assert draft.receiver_geo is not None and draft.destination_partial_change is None


@pytest.mark.parametrize("heard", ["이번에는 다른 주소", "딴 데로 보내 주세요", "배송지만 바꿀게요",
                                    "이사 간 집으로요", "지난번에 보낸 데 말고요", "3층"])
def test_partial_destination_does_not_record_intent_when_resolver_times_out(heard):
    from app.domain.candidates import apply_destination_change
    from app.integrations.address import AddressResult

    class TimedOutAddress:
        async def resolve(self, text):
            return AddressResult("error", text, (), None)

    c = ctx(address=TimedOutAddress())
    complete_sender_address(c)
    pin = place("이영희", "서울특별시 강남구 테헤란로 212")
    offer(c.state, "destination", ("이영희",), (pin,))
    apply_destination_change(c.state, 0, "address")

    out = call(c, "record_fields", {"receiver_address": heard})
    assert out["code"] == "RECEIVER_ADDRESS_VALUE_REQUIRED" and out["missing"][0] == "receiver_address"
    assert "address_detail_question" not in out and c.state.current["receiver_address"].value is None
    assert c.state.current["receiver_phone"].value == pin.phone


def test_partial_destination_validates_buffered_intent_and_accepts_resolved_place():
    from dataclasses import replace

    from app.domain.candidates import apply_destination_change
    from app.integrations.address import AddressResult
    from app.tools.record import RecordArgs, record_fields

    road = "서울특별시 강남구 테헤란로 152"

    class Address:
        async def resolve(self, text):
            if text == "강남파이낸스센터":
                return AddressResult("confirmed", road, (), None)
            return AddressResult("error", text, (), None)

    c = ctx(address=Address())
    complete_sender_address(c)
    pin = place("이영희", "서울특별시 강남구 테헤란로 212")
    offer(c.state, "destination", ("이영희",), (pin,))
    c.state.candidates = replace(c.state.candidates, destination_clarification="recipient")

    out = call(c, "record_fields", {"receiver_address": "이번에는 다른 주소"})
    assert out["destination_change_question"] == "받는 분은 이영희 님 그대로 하시는 거죠?"
    buffered = c.state.candidates.destination_buffer
    apply_destination_change(c.state, 0, "address")
    replay = run(record_fields(c, RecordArgs(**buffered), expected_draft=c.state.current))
    assert replay.code == "RECEIVER_ADDRESS_VALUE_REQUIRED"

    spoken_address = "구미시 인동구길 이십이 다시 일"
    out = call(c, "record_fields", {"receiver_address": spoken_address})
    assert out["missing"][0] == "receiver_address_detail"
    assert c.state.current["receiver_address"].value == spoken_address

    out = call(c, "record_fields", {"receiver_address": "강남파이낸스센터"})
    assert out["missing"][0] == "receiver_address_detail" and c.state.current["receiver_address"].value == road


def test_no_destination_match_keeps_early_receiver_name(address):
    c = ctx(address=address)
    call(c, "record_fields", {"receiver_phone": CALLER, "sender_address": "서울 강남구 테헤란로 211"})

    out = call(c, "find_destination", {"name": "이영희"})
    assert out["status"] == "ok" and out["missing"][0] == "sender_address_detail"
    assert out["facts"]["recorded"] == ["receiver_name"] and c.state.current["receiver_name"].value == "이영희"

    out = call(c, "record_fields", {"sender_address_detail": ""})
    assert out["missing"][0] == "receiver_address" and "receiver_name" not in out["missing"]


@pytest.mark.parametrize("receiver_corrected", [False, True])
def test_delayed_no_match_keeps_name_only_for_current_receiver(receiver_corrected):
    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()

        class SlowCompanySearch(MockBackend):
            async def search_company_places(self, *args, **kwargs):
                started.set()
                await release.wait()
                return await super().search_company_places(*args, **kwargs)

        c = ctx(SlowCompanySearch())
        old = asyncio.create_task(run_tool(c, "find_destination", json.dumps({"name": "이영희"}), "old"))
        await started.wait()
        async with c.lock:
            complete_sender_address(c)
        if receiver_corrected:
            await run_tool(c, "record_fields", json.dumps({"receiver_name": "박민수"}), "new")
        release.set()
        out = await old
        assert out["code"] == ("RESULT_SUPERSEDED" if receiver_corrected else "DEST_NONE")
        assert c.state.current["receiver_name"].value == ("박민수" if receiver_corrected else "이영희")

    run(scenario())


@pytest.mark.parametrize(("detail", "expected"), [(None, None), ("", ""), ("삼층", "3층")])
def test_find_destination_preserves_new_receiver_detail_state(address, detail, expected):
    c = ctx(address=address)
    fields = {"place": "서울 강남구 테헤란로 212", "name": "이영희"}
    if detail is not None:
        fields["detail"] = detail
    out = call(c, "find_destination", fields)
    field = c.state.current["receiver_address_detail"]
    assert field.value == expected and field.valid is (detail is not None)
    assert ("receiver_address_detail" in out["missing"]) is (detail is None)


@pytest.mark.parametrize("change", ["new_search", "new_draft", "lookup"])
def test_stale_destination_search_cannot_replace_newer_choices(address, change):
    from app.domain.state import copy_draft

    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()

        class SlowAddress:
            async def resolve(self, heard):
                started.set()
                await release.wait()
                return await address.resolve(heard)

        c = ctx(address=SlowAddress())
        complete_sender_address(c)
        c.state.customer.places = (Place("이영희", CALLER, "서울특별시 강남구 테헤란로 212", "5층", source=Source.PIN),)
        old = asyncio.create_task(run_tool(c, "find_destination",
                                           json.dumps({"place": "서울 강남구 테헤란로 211"}), "old"))
        await started.wait()
        async with c.lock:
            if change == "new_draft":
                c.state.current = copy_draft(c.state.current)
            elif change == "lookup":
                c.state.intent = "lookup"
                offer(c.state, "order", ("최근 택배",), ({"id": 1},))
        if change != "lookup":
            newer = await run_tool(c, "find_destination", json.dumps({"name": "이영희"}), "new")
            assert newer["status"] == "needs_choice"
        release.set()
        assert (await old)["code"] == "RESULT_SUPERSEDED"
        if change == "lookup":
            assert c.state.candidates.kind == "order" and c.state.candidates.labels == ("최근 택배",)
        else:
            assert c.state.candidates.items[0].name == "이영희"

    run(scenario())


def test_server_splits_detail_from_heard_sentence_and_converts_numerals(corrector, address):
    c = ctx(address=address)
    s = c.state
    out = call(c, "record_fields", {"sender_address": "경북 구미시 인동구길 칠다시삼 이백삼호요"})  # 한 문장 통째로
    assert s.field_of("sender_address").value == "경상북도 구미시 인동9길 7-3"
    # 출처는 CUSTOMER: 고객이 말한 상세를 서버가 갈랐을 뿐이라 저장된 값(PIN·PROFILE)과 구분한다
    assert s.field_of("sender_address_detail").value == "203호" and s.field_of("sender_address_detail").source == Source.CUSTOMER
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
    first = call(c, "record_fields", {"sender_name": "김철수", "sender_address": "서울 강남구 테헤란로 211",
                                      "sender_address_detail": "3층"})
    assert "confirm_route" not in first["facts"]  # 받는 곳 주소가 아직 없다
    out = call(c, "record_fields", {"receiver_name": "이영희", "receiver_phone": "01098765432",
                                    "receiver_address": "서울 강남구 테헤란로 212", "receiver_address_detail": "",
                                    "small_box_count": 1, "item_price": 30000})
    assert out["can_proceed"] is True and c.state.pending is not None and c.state.pending.issued_t == 100.0
    facts = out["facts"]["readback"]
    # 되읽기는 성함·동 이름만(S15P31D109-164). 되읽기가 열리면 confirm_route는 따로 주지 않는다
    assert set(facts) == {"sender_name", "from", "receiver_name", "to"} and facts["receiver_name"] == "이영희"
    assert "confirm_route" not in out["facts"]
    # 저장 대상은 상태에만 두고 담을 때 묻지 않고 저장한다(2026-11-06)
    assert "address_save" not in out["facts"] and c.state.address_offer == {"sender": True, "receiver": True}


def test_both_addresses_known_confirms_route_by_dong(corrector, address):
    """두 주소가 갖춰진 결과에 confirm_route(동 이름)를 준다(S15P31D109-164). 주소가 바뀌지 않은 뒤 호출에는 주지 않는다."""
    c = ctx(address=address)
    call(c, "record_fields", {"sender_name": "김철수", "sender_address": "서울 강남구 테헤란로 211"})
    out = call(c, "record_fields", {"receiver_address": "서울 강남구 테헤란로 212"})
    route = out["facts"]["confirm_route"]
    assert set(route) == {"from", "to"} and route["from"] == c.state.current.sender_geo.dong_name
    assert "readback" not in out["facts"]
    assert "confirm_route" not in call(c, "record_fields", {"receiver_name": "이영희"})["facts"]


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
    complete_sender_address(c)
    out = call(c, "find_destination", {"name": "김엄마"})
    assert out["status"] == "needs_choice" and len(out["facts"]["labels"]) == 1
    assert "맞나요" in out["facts"]["guidance"]  # 후보 1건은 질문으로 확인하게 한다
    assert apply_pick(c.state, out["facts"]["labels"][0])
    s = c.state
    assert s.field_of("receiver_name").value == "김엄마" and s.field_of("receiver_name").source == Source.PIN
    assert s.current.receiver_geo is not None and s.candidates is None


def test_narrowing_offered_candidates_to_one_applies_the_pick():
    """후보 여럿을 제시한 뒤 고객이 지역으로 고른 말을 모델이 find_destination으로 넘기면 재제시하지 않고 바로 적용한다
    (통화 d9b5208e: 재제시 뒤 Decision pick이 하한에 걸려 받는 곳이 비었다)."""
    pins = (place("박지호", "경상북도 구미시 인의로 1"), place("박지호", "서울특별시 양천구 신정로 2", detail="403호"),
            place("박지호", "경상북도 구미시 인의로 3"))
    c = ctx(customer=Customer(caller_phone=CALLER, places=pins))
    complete_sender_address(c)
    assert call(c, "record_fields", {"receiver_name": "박지호"})["code"] == "DEST_MANY"
    out = call(c, "find_destination", {"name": "박지호", "place": "양천구"})
    s = c.state
    assert out["code"] == "DEST_PICKED" and s.candidates is None and "receiver_address" not in out["missing"]
    assert s.field_of("receiver_address").value == "서울특별시 양천구 신정로 2"
    assert s.field_of("receiver_address_detail").value == "403호" and s.field_of("receiver_address").source == Source.PIN
    # 제시된 후보가 없을 때 1건이 나오면 지금처럼 확인을 거친다
    assert call(c, "find_destination", {"name": "박지호", "place": "양천구"})["status"] == "needs_choice"


def test_place_resolves_to_address_then_book_confirms_or_new_receiver(corrector, fake_kakao):
    """상호·도로명 → 실제 주소 → 그 주소의 핀이면 확인, 없으면 그 주소로 새 받는 분(통화 67d29423)."""
    same = "서울특별시 송파구 올림픽로 300"
    c = ctx(address=AddressService(corrector),
            customer=Customer(caller_phone=CALLER, places=(place("김철수", same), place("이영희", same, detail="501호"),
                                                           place("박지점", "경상북도 구미시 인동9길 7-3"))))
    complete_sender_address(c)
    assert call(c, "find_destination", {"place": "송파구 올림픽로 삼백"})["code"] == "DEST_MANY"  # 같은 주소의 두 분
    out = call(c, "find_destination", {"name": "박민수", "place": "송파구 올림픽로 삼백"})
    s = c.state
    assert out["code"] == "DEST_NEW_RECEIVER" and s.candidates is None
    assert s.field_of("receiver_name").value == "박민수" and s.field_of("receiver_name").source == Source.CUSTOMER
    assert s.field_of("receiver_address").value == same and s.field_of("receiver_address").source == Source.RESOLVER
    assert s.current.receiver_geo is not None and s.field_of("receiver_address_detail").status == FieldStatus.EMPTY
    assert "receiver_phone" in out["missing"] and "receiver_address" not in out["missing"]
    # 같은 도로의 다른 건물번호는 핀과 다른 곳: 핀 주소를 쓰지 않고 해석한 주소로
    out = call(c, "find_destination", {"place": "구미시 인동9길 8"})
    assert out["code"] == "DEST_NEW_RECEIVER" and s.field_of("receiver_address").value == "경상북도 구미시 인동9길 8"
    # 나중에 같은 건물의 핀이 있어도 이미 기록한 받는 분이 다르면 핀으로 바꾸지 않는다.
    assert call(c, "find_destination", {"place": "구미시 인동9길 7-3"})["code"] == "DEST_NEW_RECEIVER"
    assert s.field_of("receiver_name").value == "박민수" and s.candidates is None


@pytest.mark.parametrize("name", ["박민수", "김철수민"])
@pytest.mark.parametrize(("tool", "address_field"), [("record_fields", "receiver_address"), ("find_destination", "place")])
def test_same_address_does_not_offer_a_different_recipient(address, tool, address_field, name):
    road = "서울특별시 강남구 테헤란로 212"
    c = ctx(address=address)
    complete_sender_address(c)
    c.state.customer.places = (place("김철수", road),)
    call(c, "record_fields", {"receiver_name": name})

    # 한 번 더 호출해도 다른 받는 분을 자동 선택할 후보가 생기지 않는다.
    for _ in range(2):
        out = call(c, tool, {address_field: road})
        assert out["status"] == "ok" and c.state.candidates is None
        assert out["missing"][:2] == ["receiver_phone", "receiver_address_detail"]
    draft = c.state.current
    assert draft["receiver_name"].value == name and not draft["receiver_phone"].valid
    assert draft["receiver_address"].value == road and not draft["receiver_address_detail"].valid


def test_destination_search_cannot_replace_recorded_recipient_with_search_name(address):
    road = "서울특별시 강남구 테헤란로 212"
    c = ctx(address=address)
    complete_sender_address(c)
    c.state.customer.places = (place("김철수", road),)
    call(c, "record_fields", {"receiver_name": "박민수"})

    out = call(c, "find_destination", {"name": "김철수", "place": road})
    assert out["code"] == "DEST_RECIPIENT_USE_RECORD" and c.state.candidates is None
    assert c.state.current["receiver_name"].value == "박민수" and not c.state.current["receiver_phone"].valid


def test_destination_search_respects_same_name_and_allows_address_first(address):
    road = "서울특별시 강남구 테헤란로 212"
    pins = (place("김철수", road), place("박민수 님", road, detail="2층"))
    c = ctx(address=address)
    complete_sender_address(c)
    c.state.customer.places = pins

    out = call(c, "find_destination", {"place": road})
    assert out["code"] == "DEST_MANY" and c.state.candidates.items == pins
    out = call(c, "record_fields", {"receiver_name": "박 민수"})
    assert out["status"] == "needs_choice" and c.state.candidates.items == (pins[1],)
    assert call(c, "find_destination", {"place": road})["code"] == "DEST_PICKED"
    assert c.state.current["receiver_address_detail"].value == "2층"


def test_unlisted_recipient_uses_collection_without_implicit_company_search():
    class PersonalOrder(MockBackend):
        async def search_company_places(self, *args, **kwargs):
            raise AssertionError("개인 택배의 새 받는 분을 기업 주소에서 찾지 않는다")

    c = ctx(PersonalOrder())
    complete_sender_address(c)
    c.state.customer.places = (place("김철수", "서울특별시 강남구 테헤란로 212"),)
    call(c, "record_fields", {"receiver_name": "박민수"})

    out = call(c, "find_destination", {"name": "박민수"})
    assert out["status"] == "ok" and out["missing"][0] == "receiver_phone" and c.state.candidates is None


def test_pin_labels_name_and_region_then_detail():
    from backend_client.order import pin_labels
    from app.tools.lookup import _to_be
    a = place("김철수", "경상북도 구미시 인동9길 22-1", detail="502호")
    b = place("유민국", "경상북도 구미시 인동9길 22-1", detail="501호")
    assert pin_labels([_to_be(a), _to_be(b)]) == ["김철수 구미시 y", "유민국 구미시 y"]
    # 같은 이름·지역이면 상세주소로 구별
    c_ = place("유민국", "경상북도 구미시 인동9길 22-1", detail="502호")
    assert pin_labels([_to_be(b), _to_be(c_)]) == ["유민국 구미시 y 501호", "유민국 구미시 y 502호"]
    # geo 없음: 도로명으로
    no_geo = Place("이영희", "01000000000", "서울특별시 강남구 테헤란로 212", "3층", None, Source.PIN)
    assert pin_labels([_to_be(no_geo)]) == ["이영희 강남구 테헤란로"]


def test_record_receiver_checks_address_book_without_request(corrector, fake_kakao):
    """발송 주소를 받은 상태에서는 받는 분 성함이나 주소로 바로 주소록 핀을 확인한다."""
    pins = (place("김엄마", "대구광역시 수성구 달구벌대로 2450"), place("김철수", "서울특별시 송파구 올림픽로 300"))
    c = ctx(address=AddressService(corrector), customer=Customer(customer_seq=12, caller_phone=CALLER, places=pins))
    complete_sender_address(c)
    out = call(c, "record_fields", {"receiver_name": "김엄마"})
    assert out["status"] == "needs_choice" and out["facts"]["labels"] == ["김엄마 수성구 y"]
    assert c.state.field_of("receiver_name").value == "김엄마" and "receiver_name" in out["facts"]["recorded"]
    assert apply_pick(c.state, "김엄마 수성구 y")
    assert c.state.field_of("receiver_phone").value == "01098765432" and c.state.current.receiver_geo is not None
    # 주소록에 없는 이름은 그대로 진행
    c = ctx(address=AddressService(corrector), customer=Customer(customer_seq=12, caller_phone=CALLER, places=pins))
    assert call(c, "record_fields", {"receiver_name": "없는분"})["status"] == "ok" and c.state.candidates is None
    # 이미 들은 성함이 핀과 다르면 주소가 같아도 그 핀을 권하지 않는다
    assert call(c, "record_fields", {"receiver_address": "송파구 올림픽로 삼백"})["status"] == "ok"
    # 성함 전에 주소를 들으면 실제 주소로 대조: 같은 건물이면 확인, 다른 건물번호면 그대로
    c = ctx(address=AddressService(corrector), customer=Customer(customer_seq=12, caller_phone=CALLER, places=pins))
    complete_sender_address(c)
    out = call(c, "record_fields", {"receiver_address": "송파구 올림픽로 삼백"})
    assert out["status"] == "needs_choice" and out["facts"]["labels"] == ["김철수 송파구 y"]
    c.state.candidates = None
    assert call(c, "record_fields", {"receiver_address": "구미시 인동9길 8"})["status"] == "ok" and c.state.candidates is None


def company(name="주소하나", organization="주소기업", seq=26):
    return CompanyPlace(name=name, phone="01098765432", address="서울 중구 세종대로 110", address_detail="", geo=None,
                        organization_seq=6, organization_name=organization, membership_seq=seq, customer_seq=seq)


def test_company_search_many_more_none_and_failure():
    db = MockBackend()
    db.company_places = [company(), company("주소둘", seq=27), company("다른사람", "다른기업", seq=28)]
    c = ctx(db)
    complete_sender_address(c)
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
    assert out["facts"]["lookup_order"]["receiver_address"] == "부산 해운대구 센텀로 10"
    out = call(c, "lookup_orders", {"receiver_name": None})
    assert out["status"] == "needs_choice" and len(c.state.candidates.labels) == 2
    assert "lookup_order" not in out["facts"]
    assert call(c, "lookup_orders", {"receiver_name": "없음"})["code"] == "ORDER_NOT_FOUND_BY_NAME"
    assert call(ctx(db), "lookup_orders", {})["code"] == "CALL_NOT_REGISTERED"  # 고객 범위 없으면 조회 안 함


def test_previous_call_lookup_stays_in_latest_own_order_and_asks_only_if_ambiguous():
    db = MockBackend()
    cust = registered(db)
    db.add_order(CALLER, "ACCEPTED", [("박민수", "더 오래된 주소")])
    db.add_order(CALLER, "ACCEPTED", [("박민수", "최근 주소"), ("이영희", "두 번째 받는 곳")])
    db.add_order("01099990000", "ACCEPTED", [("박민수", "다른 고객 주소")])
    c = ctx(db, customer=cust)
    c.state.intent = "lookup"
    out = call(c, "lookup_orders", {"scope": "previous_call"})
    assert out["status"] == "needs_choice"
    assert [o["receiver_name"] for o in out["facts"]["orders"]] == ["박민수", "이영희"]
    assert all("번" not in o["label"] for o in out["facts"]["orders"])
    out = call(c, "lookup_orders", {"scope": "previous_call", "receiver_name": "박민수"})
    assert out["facts"]["lookup_order"]["receiver_address"] == "최근 주소"


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


def test_cancel_lookup_respects_call_scope_and_rejected_lookup_discards_target():
    db = MockBackend()
    customer = registered(db)
    db.add_order(CALLER, "notPaid", [("홍길동", "주소"), ("김민지", "다른 주소")])
    c = ctx(db, customer=customer)
    c.state.intent = "cancel"
    c.draft_intake = True
    result = call(c, "lookup_orders", {"scope": "current_call"})
    assert result["facts"]["found"] == 0 and c.state.pending is None

    result = call(c, "lookup_orders", {"scope": "previous_call", "receiver_name": "김민지", "whole_order": True})
    assert result["facts"]["found"] == 1 and result["facts"]["cancel_target"]["parcel_count"] == 2
    assert c.state.pending.snapshot["whole_order"]
    denied = call(c, "lookup_orders", {"other_customer": True})
    assert denied["code"] == "ORDER_OTHER_CUSTOMER" and "cancel_target" not in denied["facts"]
    assert c.state.pending is None and c.state.selected_order is None


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
    assert "facts" not in out  # 값은 고객이 물었을 때(include_values)만


def test_get_state_values_on_request():
    """고객이 물으면 고르기 전 후보·고른 뒤 기록 값을 서버 상태로 준다. 발신번호·기업 사원 연락처·상세주소는 주지 않는다."""
    pins = (place("박지호", "경상북도 구미시 인의로 1"), place("박지호", "서울특별시 양천구 신정로 2", detail="403호"))
    c = ctx(customer=Customer(caller_phone=CALLER, places=pins))
    complete_sender_address(c)
    labels = call(c, "find_destination", {"name": "박지호"})["facts"]["labels"]
    v = c.state.state_version
    before = call(c, "get_state", {"include_values": True})["facts"]
    assert [x["address_detail"] for x in before["candidates"]] == ["101호", "403호"]
    assert {x["phone"] for x in before["candidates"]} == {"01098765432"} and c.state.state_version == v
    assert apply_pick(c.state, labels[1])
    cur = call(c, "get_state", {"include_values": True})["facts"]["current"]
    assert cur["receiver_address_detail"] == {"value": "403호", "from": "pin"}
    assert cur["receiver_phone"] == {"value": "01098765432", "from": "pin"}
    assert "sender_phone" not in cur and c.state.field_of("sender_phone").valid  # 발신번호는 읽지 않는다
    company = ctx()
    complete_sender_address(company)
    offer(company.state, "destination", ("세종대로 김부장",),
          (Place("김부장", "01011112222", "서울 중구 세종대로 110", "5층", None, Source.COMPANY),))
    cand = call(company, "get_state", {"include_values": True})["facts"]["candidates"][0]
    assert cand == {"label": "세종대로 김부장", "name": "김부장", "address": "서울 중구 세종대로 110"}


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


def test_address_in_several_regions_asks_region(corrector, address):
    """같은 주소가 여러 시군구에 있으면 기록하지 않고 지역을 되묻는다(ADDRESS_REGION_NEEDED). 모델은 heard와 지역을 합쳐 다시 넘긴다."""
    c = ctx(address=address)
    out = call(c, "record_fields", {"receiver_address": "중앙로 232"})
    assert out["code"] == "ADDRESS_REGION_NEEDED" and out["needs"][0]["heard"] == "중앙로 232"
    assert set(out["needs"][0]["regions"]) == {"서울특별시 양천구", "경기도 고양시 덕양구"}
    assert c.state.field_of("receiver_address").status == FieldStatus.INVALID
    out = call(c, "record_fields", {"receiver_address": "양천구 중앙로 232"})
    assert out["status"] == "ok" and c.state.field_of("receiver_address").value == "서울특별시 양천구 중앙로 232"


def test_place_name_leads_address_detail(address):
    """건물명으로 찾은 기본주소는 도로명주소로, 상세주소는 검색이 찾은 이름을 앞에 붙여 기록한다."""
    c = ctx(address=address)
    s = c.state
    call(c, "record_fields", {"receiver_address": "서울 포스코 센타"})
    assert s.field_of("receiver_address").value == "서울특별시 강남구 테헤란로 212"
    call(c, "record_fields", {"receiver_address_detail": "3층"})
    assert s.field_of("receiver_address_detail").value == "포스코센터 3층"
    call(c, "record_fields", {"receiver_address_detail": "포스코센터 5층"})  # 이미 이름으로 시작하면 두 번 붙이지 않는다
    assert s.field_of("receiver_address_detail").value == "포스코센터 5층"
    call(c, "record_fields", {"receiver_address_detail": ""})  # 상세주소 없음 → 이름만
    assert s.field_of("receiver_address_detail").value == "포스코센터"
    call(c, "record_fields", {"sender_address": "서울 포스코 센타", "sender_address_detail": "2층"})  # 같은 호출
    assert s.field_of("sender_address_detail").value == "포스코센터 2층"
    call(c, "record_fields", {"receiver_address": "서울 강남구 테헤란로 211"})  # 번호로 다시 받으면 이름을 떼고
    call(c, "record_fields", {"receiver_address_detail": "3층"})
    assert s.field_of("receiver_address_detail").value == "3층"
