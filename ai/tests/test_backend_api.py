"""백엔드 API 클라이언트가 spec/backend-api.md대로 요청하고 응답을 해석하는지(가짜 HTTP 전송)."""

import json

import httpx2
import pytest
from conftest import CALLER, GEO, INCOMING_AT, PICKUP_AT, run

from app.backend_api import BackendAPI, BackendError, result_body
from app.order import Order

ORDER = Order(sender_name="김철수", sender_phone=CALLER, sender_address="서울 강남구 테헤란로 212",
              sender_address_detail="1201호", receiver_name="이영희", receiver_phone="01098765432",
              receiver_address="부산 해운대구 센텀로 10", receiver_address_detail="", small_box_count=1,
              item_price=30000, sender_geo=GEO, receiver_geo=GEO)
CALL = {"providerCallId": "live_1", "callerPhoneNumber": CALLER, "incomingAt": INCOMING_AT}
PIN = {"name": "김철수", "phoneNumber": CALLER, "roadAddress": "서울 예시로 12", "jibunAddress": "서울 예시동 12",
       "detailAddress": "101호", "dongName": "예시동", "postalCode": "01234", "latitude": 37.5, "longitude": 127}


def api(handler, **kw):
    seen = []

    def wrapped(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return handler(request)

    kw = {"submit_retry_sec": 1.0, "retry_interval_sec": 0.01} | kw
    return BackendAPI("http://backend", 3.0, transport=httpx2.MockTransport(wrapped), **kw), seen


def body(request):
    return json.loads(request.content)


def context(data):
    return lambda req: httpx2.Response(200, json={"data": data, "meta": {"requestId": "r"}})


def test_caller_context_registered_with_pins():
    client, seen = api(context({
        "lookupStatus": "REGISTERED", "customer": {"customerSeq": 12, "name": "김철수", "phoneNumber": CALLER},
        "availableUsageTypes": ["PERSONAL", "COMPANY"],
        "personalPins": [{"personalPinSeq": 1, "label": "집", "addressData": PIN},
                         {"personalPinSeq": 2, "label": "중복", "addressData": PIN},
                         {"personalPinSeq": 3, "label": "불완전", "addressData": {"name": "x"}}],
        "companyPins": [{"companyPinSeq": 4, "addressData": {**PIN, "roadAddress": "회사로 1", "latitude": None}}]}))
    ctx = run(client.caller_context(CALLER))
    assert (ctx.status, ctx.customer_seq, ctx.name, ctx.usage_types) == ("REGISTERED", 12, "김철수", ["PERSONAL", "COMPANY"])
    assert [p.address for p in ctx.places] == ["서울 예시로 12", "회사로 1"]  # 같은 곳·불완전한 곳은 뺀다
    assert ctx.places[0].geo.postal_code == "01234" and ctx.places[0].address_detail == "101호"
    assert ctx.places[1].geo is None  # 좌표가 없으면 다시 찾게 비워 둔다
    assert seen[0].method == "POST" and seen[0].url.path == "/api/customers/context"
    assert CALLER not in str(seen[0].url) and body(seen[0]) == {"phoneNumber": CALLER}  # 전화번호는 URL에 넣지 않는다


@pytest.mark.parametrize("status", ["UNREGISTERED", "WITHDRAWN"])
def test_caller_context_unregistered_and_withdrawn(status):
    client, _ = api(context({"lookupStatus": status, "customer": None, "personalPins": [], "companyPins": []}))
    ctx = run(client.caller_context(CALLER))
    assert ctx.status == status and ctx.customer_seq is None and ctx.places == []


def test_result_body_complete_new_customer():
    b = result_body("COMPLETE", CALL, None, "김철수", CALLER, "credit", PICKUP_AT, [ORDER])
    assert b["customer"] == {"name": "김철수", "phoneNumber": CALLER} and "customerSeq" not in b
    p = b["parcels"][0]
    assert p["destination"] == {"name": "이영희", "phoneNumber": "01098765432", "roadAddress": ORDER.receiver_address,
                                "detailAddress": "", "jibunAddress": GEO.jibun_address, "dongName": GEO.dong_name,
                                "postalCode": GEO.postal_code, "latitude": GEO.latitude, "longitude": GEO.longitude}
    assert p["smallBoxCount"] == 1 and p["itemPrice"] == 30000 and "otherItemDescription" not in p
    assert (b["paymentMethodType"], b["pickupRequestedAt"]) == ("credit", PICKUP_AT)


def test_result_body_registered_and_partial():
    b = result_body("INCOMPLETE", CALL, 12, "무시", CALLER, None, None, [Order(receiver_name="박")])
    assert b == {"outcome": "INCOMPLETE", "call": CALL, "customerSeq": 12,
                 "parcels": [{"destination": {"name": "박"}}]}  # 모르는 값은 넣지 않는다(임의 기본값 없음)
    assert result_body("CANCELLED", CALL, None, None, CALLER, None, None, []) == {"outcome": "CANCELLED", "call": CALL}


def test_submit_result_sends_key_and_returns_data():
    data = {"orderSeq": 1, "version": 1, "status": "ACCEPTED", "callSessionSeq": 7, "parcelNo": "TEST0057"}
    client, seen = api(lambda req: httpx2.Response(201, json={"data": data, "meta": {}}))
    assert run(client.submit_result({"outcome": "COMPLETE"}, "uuid-1")) == data
    assert seen[0].url.path == "/api/orders" and seen[0].headers["Idempotency-Key"] == "uuid-1"


def test_submit_result_retries_uncertain_results_with_same_key_and_body():
    answers = iter([
        httpx2.ConnectError("x"),
        httpx2.Response(504, json={}),
        httpx2.Response(409, json={"error": {"code": "REQUEST_IN_PROGRESS", "message": "m"}}),
        httpx2.Response(202, json={"data": {"status": "SUBMITTING"}}),
        httpx2.Response(201, json={"data": {"status": "ACCEPTED", "parcelNo": "TEST0057"}}),
    ])

    def handler(req):
        a = next(answers)
        if isinstance(a, Exception):
            raise a
        return a

    client, seen = api(handler)
    assert run(client.submit_result({"outcome": "COMPLETE"}, "uuid-1"))["status"] == "ACCEPTED"
    assert len(seen) == 5 and {r.headers["Idempotency-Key"] for r in seen} == {"uuid-1"}
    assert {r.content for r in seen} == {seen[0].content}


def test_submit_result_gives_up_with_last_status_or_error():
    client, _ = api(lambda req: httpx2.Response(202, json={"data": {"status": "SUBMITTING"}}), submit_retry_sec=0.05)
    assert run(client.submit_result({}, "k"))["status"] == "SUBMITTING"  # 성공으로 보지 않는다

    def down(req):
        raise httpx2.ConnectError("x")

    client, _ = api(down, submit_retry_sec=0.05)
    with pytest.raises(BackendError):
        run(client.submit_result({}, "k"))


@pytest.mark.parametrize("status, code", [(422, "VALIDATION_FAILED"), (409, "INVALID_STATE"), (400, "INVALID_REQUEST")])
def test_submit_result_does_not_retry_rejections(status, code):
    client, seen = api(lambda req: httpx2.Response(status, json={"error": {"code": code, "message": "m"}}))
    with pytest.raises(BackendError, match=code):
        run(client.submit_result({}, "k"))
    assert len(seen) == 1


# --- 보류한 조회·수정·취소 도구(옛 계약) ---

@pytest.mark.parametrize("status, expected", [(200, "ok"), (404, "not_found"), (409, "cancelled")])
def test_update_and_cancel_status_mapping(status, expected):
    client, seen = api(lambda req: httpx2.Response(status, json={}))
    assert run(client.update_order(CALLER, "Q000001", {"receiver_name": "박", "status": "x"})) == expected
    assert run(client.cancel_order(CALLER, "Q000001")) == expected
    assert seen[0].url.path == "/internal/ai/orders/Q000001/update"
    assert body(seen[0]) == {"caller_phone": CALLER, "changes": {"receiver_name": "박"}}  # 정해진 항목만
    assert seen[1].url.path == "/internal/ai/orders/Q000001/cancel"


def test_order_no_cannot_escape_path():
    client, seen = api(lambda req: httpx2.Response(404, json={}))
    run(client.cancel_order(CALLER, "../callers/places"))
    assert seen[0].url.raw_path.startswith(b"/internal/ai/orders/..%2Fcallers%2Fplaces/")


def test_lists():
    client, seen = api(lambda req: httpx2.Response(200, json={"orders": [{"order_no": "Q1"}]}))
    assert run(client.list_orders(CALLER, 5)) == [{"order_no": "Q1"}]
    assert body(seen[0]) == {"caller_phone": CALLER, "limit": 5}
    assert run(client.recent_orders(10)) == [{"order_no": "Q1"}]
    assert seen[1].method == "GET" and seen[1].url.params["limit"] == "10"


def test_unexpected_status_raises():
    client, _ = api(lambda req: httpx2.Response(500, json={}))
    with pytest.raises(BackendError):
        run(client.caller_context(CALLER))
    with pytest.raises(BackendError):
        run(client.update_order(CALLER, "Q1", {"receiver_name": "x"}))
