"""기업·사원 배송지 검색 HTTP 계약(원본 tests/test_company_directory.py의 클라이언트 부분)과 가짜 백엔드 일치."""

import inspect

import httpx2
import pytest
from conftest import run
from test_backend_api import PIN, api

from backend_client.api import BackendAPI, BackendError
from backend_client.mock import MockBackend


def entry():
    return {"organizationSeq": 6, "organizationName": "주소기업", "membershipSeq": 26, "customerSeq": 26,
            "departmentSeq": None, "departmentName": None, "addressData": {**PIN, "name": "주소셋"}}


def test_company_http_new_contract_encoding_and_no_pin_reference():
    client, seen = api(lambda req: httpx2.Response(200, json={"data": [entry()], "hasNext": False, "total_count": 1}))
    page = run(client.search_company_places("주소기업 주소셋 &%", limit=5, offset=0))
    assert seen[0].url.path == "/api/companies/search"
    assert seen[0].url.params["q"] == "주소기업 주소셋 &%"
    assert "call_session_seq" not in seen[0].headers
    assert page.places[0].membership_seq == 26 and page.places[0].name == "주소셋"


@pytest.mark.parametrize("payload", [
    {"data": [], "hasNext": False},
    {"data": [], "hasNext": "false", "total_count": 0},
    {"data": [], "hasNext": True, "total_count": 2},
    {"data": [entry()], "hasNext": False, "total_count": 0},
    {"data": [{**entry(), "membershipSeq": True}], "hasNext": False, "total_count": 1},
    {"data": [{**entry(), "addressData": {}}], "hasNext": False, "total_count": 1},
])
def test_bad_company_response_is_failure_not_empty(payload):
    client, _ = api(lambda req: httpx2.Response(200, json=payload))
    with pytest.raises(BackendError, match="응답 형식"):
        run(client.search_company_places("주소기업"))


def test_mock_has_every_backend_api_method():
    public = {n for n, _ in inspect.getmembers(BackendAPI) if not n.startswith("_")}
    missing = {n for n in public if not hasattr(MockBackend(), n)}
    assert not missing, f"가짜 백엔드에 없는 API: {missing}"


def test_mock_faq_entries_match_original_interface():
    """원본 RAG(app/rag)가 부르는 faq_entries·initial_faq_entries. 원문을 준비하지 않으면 전체 삭제로 읽히지 않게 실패."""
    mock = MockBackend()
    with pytest.raises(BackendError):
        run(mock.faq_entries([1]))
    row = lambda i: {"faqEntrySeq": i, "question": f"질문 {i}", "answer": f"답 {i}", "updatedAt": "2026-11-01T00:00:00Z"}
    mock.faqs = {2: row(2), 1: row(1)}
    assert [e.faq_id for e in run(mock.initial_faq_entries())] == [1, 2]
    lookup = run(mock.faq_entries([2, 9]))
    assert [e.faq_id for e in lookup.entries] == [2] and list(lookup.missing_ids) == [9]


def test_no_coordinates_anywhere_in_requests():
    """백엔드 계약에서 위도·경도가 빠졌다(보내면 400, docs/be-contract/backend/address-coordinates-removal.md)."""
    from conftest import CALLER, GEO, INCOMING_AT
    from backend_client.api import parcel_body, result_body
    from backend_client.order import Order

    order = Order(sender_name="김철수", sender_phone=CALLER, sender_address="서울 예시로 1", sender_address_detail="",
                  receiver_name="이영희", receiver_phone="01098765432", receiver_address="부산 예시로 2",
                  receiver_address_detail="", small_box_count=1, item_price=1000, sender_geo=GEO, receiver_geo=GEO)
    body = result_body("INCOMPLETE", {"providerCallId": "live_x", "incomingAt": INCOMING_AT}, None, "김철수", CALLER,
                       None, None, [order])
    text = str(body) + str(parcel_body(order))
    assert "latitude" not in text and "longitude" not in text
    with pytest.raises(BackendError, match="400"):
        run(MockBackend().submit_result({"outcome": "INCOMPLETE", "call": {"providerCallId": "p"},
                                         "parcels": [{"origin": {"latitude": 1}}]}, "k"))


def test_mock_order_and_pin_apis_follow_contract_states():
    from backend_client.order import Place
    mock = MockBackend()
    seq = mock.add_customer("01011112222", "김고객", pins=[Place(name="받는분", phone="01033334444", address="서울 예시로 1", address_detail="")])
    call = run(mock.caller_context("01011112222", {"providerCallId": "c1", "incomingAt": "t"}, 0)).call_session_seq
    order = mock.add_order("01011112222", "COLLECTING", [("받는분", "서울 예시로 1")])
    assert run(mock.update_collecting_order(call, order, {"expectedVersion": 1})) == 2
    with pytest.raises(BackendError) as e:
        run(mock.submit_order(call, order, 1))
    assert e.value.code == "VERSION_CONFLICT"
    assert run(mock.submit_order(call, order, 2)) == {"status": "notPaid"}
    assert run(mock.cancel_order(call, order)) == "ok" and run(mock.cancel_order(call, order)) == "conflict"
    pins = run(mock.list_pins(call, seq))
    assert pins["total_count"] == 1 and pins["data"][0]["addressData"]["name"] == "받는분"
    assert run(mock.update_pin(call, 1, {"label": "집"})) == 2
    with pytest.raises(BackendError):
        run(mock.update_pin(call, 2, {"label": "집"}))
