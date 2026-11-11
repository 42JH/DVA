"""백엔드 API 클라이언트가 spec/backend-api.md대로 요청하고 응답을 해석하는지(가짜 HTTP 전송)."""

import json

import httpx2
import pytest
from conftest import CALLER, GEO, INCOMING_AT, PICKUP_AT, run

from backend_client.api import BackendAPI, BackendError, result_body
from backend_client.order import Order

ORDER = Order(sender_name="김철수", sender_phone=CALLER, sender_address="서울 강남구 테헤란로 212",
              sender_address_detail="1201호", receiver_name="이영희", receiver_phone="01098765432",
              receiver_address="부산 해운대구 센텀로 10", receiver_address_detail="", small_box_count=1,
              item_price=30000, sender_geo=GEO, receiver_geo=GEO)
CALL = {"providerCallId": "live_1", "callerPhoneNumber": CALLER, "incomingAt": INCOMING_AT}
PIN = {"name": "김철수", "phoneNumber": CALLER, "roadAddress": "서울 예시로 12", "jibunAddress": "서울 예시동 12",
       "detailAddress": "101호", "dongName": "예시동", "postalCode": "01234"}


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


@pytest.mark.parametrize("ids", [[12], [12, 15]])
def test_faq_answered_array_contract_uses_existing_events_api(ids):
    """사용자 제공 FAQ 사례 계약: 한 응대/이벤트, 배열만 사용, 발화 원문은 UTTERANCE 한 번씩."""
    events = []
    for i, (speaker, text) in enumerate((("CUSTOMER", "착불도 되나요?"), ("AI", "착불은 불가합니다.")), 1):
        events.append({"eventId": f"00000000-0000-4000-8000-00000000000{i}", "eventOrder": i,
                       "kind": "UTTERANCE", "occurredAt": f"2026-11-05T03:00:0{i}.000Z", "offsetSeconds": i,
                       "payload": {"utteranceOrder": i, "speaker": speaker, "utteranceText": text, "lastSentenceSeq": 1}})
    events.append({"eventId": "00000000-0000-4000-8000-000000000003", "eventOrder": 3,
                   "kind": "BUSINESS_RESULT", "occurredAt": "2026-11-05T03:00:02.000Z", "offsetSeconds": 2,
                   "payload": {"action": "FAQ_ANSWERED", "orderSeq": None, "unansweredQuestionSeq": None,
                               "summaryText": "FAQ 근거로 문의 안내 완료", "faqEntrySeqs": ids,
                               "questionUtteranceOrder": 1, "answerUtteranceOrder": 2}})
    expected = {"providerCallId": "live_1", "events": events}

    def handler(req):
        assert req.method == "POST" and req.url.path == "/api/ai/calls/120/events"
        assert req.headers["Authorization"] == "Bearer test-insights"
        assert body(req) == expected
        assert set(body(req)["events"][-1]["payload"]) == {
            "action", "orderSeq", "unansweredQuestionSeq", "summaryText", "faqEntrySeqs",
            "questionUtteranceOrder", "answerUtteranceOrder"}
        return httpx2.Response(204)

    client, seen = api(handler, insights_token="test-insights")

    async def scenario():
        try:
            await client.send_call_events(120, expected)
            await client.send_call_events(120, expected)
        finally:
            await client.close()

    run(scenario())
    assert len(seen) == 2 and seen[0].content == seen[1].content


@pytest.mark.parametrize("reason", ["KB_NO_ANSWER", "KB_UNAVAILABLE", None, "OMITTED"])
def test_unanswered_reason_contract_fbbaca1_preserves_body_on_retry(reason):
    """develop-backend fbbaca1: 선택 reason을 그대로 보내며 재전송도 같은 본문·인증을 사용한다."""
    payload = {"eventId": "8d4e5cb5-d474-4e8a-904a-868304187e03", "callSessionSeq": 120,
               "providerCallId": "rtc_example_120", "questionText": "주말에도 수거하나요?",
               "occurredAt": "2026-11-04T10:01:20+09:00", "offsetSeconds": 80}
    if reason != "OMITTED":
        payload["reason"] = reason
    requests = []

    def handler(req):
        assert req.method == "POST" and req.url.path == "/api/ai/unanswered-questions"
        assert req.headers["Authorization"] == "Bearer test-insights"
        assert body(req) == payload
        requests.append(req.content)
        return httpx2.Response(201 if len(requests) == 1 else 200, json={"data": {"unansweredQuestionSeq": 51}})

    client, _ = api(handler, insights_token="test-insights")

    async def scenario():
        try:
            assert await client.send_unanswered(payload) == 51
            assert await client.send_unanswered(payload) == 51
        finally:
            await client.close()

    run(scenario())
    assert requests[0] == requests[1]


REGISTERED = {
    "lookupStatus": "REGISTERED", "customer": {"customerSeq": 12, "name": "김철수", "phoneNumber": CALLER,
                                               "address": {**PIN, "name": "과거이름"}},
    "availableUsageTypes": ["PERSONAL", "COMPANY"], "callSessionSeq": 20,
    "availablePaymentMethods": ["billing", "credit"],
    "personalPins": [{"personalPinSeq": 1, "label": "집", "addressData": PIN},
                     {"personalPinSeq": 2, "label": "중복", "addressData": PIN},
                     {"personalPinSeq": 3, "label": "불완전", "addressData": {"name": "x"}}],
    "companyPins": [{"companyPinSeq": 4, "addressData": {**PIN, "roadAddress": "회사로 1", "postalCode": None}}]}
CALL_ID = {"providerCallId": "live_1", "incomingAt": INCOMING_AT}


def history(rows):
    return {"data": [{"orderSeq": i + 1, "orderParcelSeq": i + 1, "createdAt": "2026-10-30T00:00:00Z", "address": r}
                     for i, r in enumerate(rows)], "hasNext": False}


def test_caller_context_registered_with_pins_call_and_recent_addresses():
    def handler(req):
        if req.url.path == "/api/customers/context":
            return httpx2.Response(200, json={"data": REGISTERED, "meta": {"requestId": "r"}})
        if req.url.params["direction"] == "ORIGIN":
            return httpx2.Response(200, json=history([PIN]))
        return httpx2.Response(200, json=history([{**PIN, "roadAddress": "부산 도착로 1"}, {**PIN, "roadAddress": "부산 도착로 1"},
                                                  {**PIN, "roadAddress": "대구 도착로 2", "name": None}]))

    client, seen = api(handler)
    ctx = run(client.caller_context(CALLER, CALL_ID, recent_limit=5))
    assert (ctx.status, ctx.customer_seq, ctx.name, ctx.usage_types) == ("REGISTERED", 12, "김철수", ["PERSONAL", "COMPANY"])
    assert ctx.call_session_seq == 20 and ctx.payment_methods == ["billing", "credit"]
    assert [p.address for p in ctx.places] == ["서울 예시로 12"]  # 기업 PIN은 사용하지 않는다
    assert ctx.places[0].geo.postal_code == "01234" and ctx.places[0].address_detail == "101호"
    assert ctx.default_origin.name == "김철수" and ctx.default_origin.phone == CALLER
    assert seen[0].method == "POST" and seen[0].url.path == "/api/customers/context"
    assert CALLER not in str(seen[0].url) and body(seen[0]) == {"phoneNumber": CALLER, "call": CALL_ID}
    # 이전 접수 주소: 통화 번호 헤더, 출발지 1건·도착지 최근 N건(같은 곳·불완전한 곳은 뺀다)
    assert ctx.recent_origin.address == "서울 예시로 12" and [p.address for p in ctx.recent_destinations] == ["부산 도착로 1"]
    assert [(r.url.path, r.url.params["direction"], r.url.params["limit"], r.headers["call_session_seq"])
            for r in seen[1:]] == [("/api/customers/12/addresses", "ORIGIN", "1", "20"),
                                   ("/api/customers/12/addresses", "DESTINATION", "5", "20")]


def test_caller_context_survives_address_history_failure_and_skips_it_without_call():
    def handler(req):
        if req.url.path == "/api/customers/context":
            return httpx2.Response(200, json={"data": REGISTERED, "meta": {}})
        return httpx2.Response(503, json={"error": {"code": "SERVICE_UNAVAILABLE"}})

    client, _ = api(handler)
    ctx = run(client.caller_context(CALLER, CALL_ID))
    assert ctx.customer_seq == 12 and ctx.recent_origin is None and ctx.recent_destinations == []
    client, seen = api(context({**REGISTERED, "callSessionSeq": None}))
    run(client.caller_context(CALLER))
    assert len(seen) == 1 and body(seen[0]) == {"phoneNumber": CALLER}  # 통화 번호가 없으면 이력을 읽지 않는다


@pytest.mark.parametrize("status", ["UNREGISTERED", "WITHDRAWN"])
def test_caller_context_unregistered_and_withdrawn(status):
    client, seen = api(context({"lookupStatus": status, "customer": None, "personalPins": [], "companyPins": [],
                                "callSessionSeq": 21, "availablePaymentMethods": []}))
    ctx = run(client.caller_context(CALLER, CALL_ID))
    assert ctx.status == status and ctx.customer_seq is None and ctx.places == [] and ctx.payment_methods == []
    assert ctx.call_session_seq == 21 and len(seen) == 1


def test_result_body_complete_new_customer():
    b = result_body("COMPLETE", CALL, None, "김철수", CALLER, "credit", PICKUP_AT, [ORDER])
    assert b["customer"] == {"name": "김철수", "phoneNumber": CALLER} and "customerSeq" not in b
    p = b["parcels"][0]
    assert p["destination"] == {"name": "이영희", "phoneNumber": "01098765432", "roadAddress": ORDER.receiver_address,
                                "detailAddress": "", "jibunAddress": GEO.jibun_address, "dongName": GEO.dong_name,
                                "postalCode": GEO.postal_code}
    assert p["smallBoxCount"] == 1 and p["itemPrice"] == 30000 and "otherItemDescription" not in p
    assert (b["paymentMethodType"], b["pickupRequestedAt"]) == ("credit", PICKUP_AT)
    assert "totalAmount" not in b and "notifiedPrice" not in p  # 배송비를 모르면 넣지 않는다


def test_result_body_fares_and_total():
    b = result_body("COMPLETE", CALL, 12, None, CALLER, "billing", PICKUP_AT, [ORDER, ORDER], [4000, 5000])
    assert [p["notifiedPrice"] for p in b["parcels"]] == [4000, 5000] and b["totalAmount"] == 9000
    b = result_body("INCOMPLETE", CALL, 12, None, CALLER, None, None, [ORDER, ORDER], [4000, None])
    assert b["parcels"][0]["notifiedPrice"] == 4000 and "totalAmount" not in b  # 하나라도 모르면 합계를 보내지 않는다


def test_result_body_registered_and_partial():
    b = result_body("INCOMPLETE", CALL, 12, "무시", CALLER, None, None, [Order(receiver_name="박")])
    assert b == {"outcome": "INCOMPLETE", "call": CALL, "customerSeq": 12,
                 "parcels": [{"destination": {"name": "박"}}]}  # 모르는 값은 넣지 않는다(임의 기본값 없음)
    assert result_body("CANCELLED", CALL, None, None, CALLER, None, None, []) == {"outcome": "CANCELLED", "call": CALL}


@pytest.mark.parametrize("code", [201, 200])  # 같은 키의 재요청은 기존 주문의 현재 결과(200)
def test_submit_result_sends_key_and_returns_data(code):
    data = {"orderSeq": 1, "version": 2, "status": "notPaid", "totalAmount": 5000, "callSessionSeq": 7,
            "parcelNo": None, "paymentRequest": {"paymentRequestId": "x", "amount": 5000}}
    client, seen = api(lambda req: httpx2.Response(code, json={"data": data, "meta": {}}))
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


# --- 신규 고객 등록과 개인 주소록 ---

@pytest.mark.parametrize("status, expected", [(201, 33), (409, None)])  # 이미 등록된 번호는 None
def test_create_customer(status, expected):
    client, seen = api(lambda req: httpx2.Response(status, json={"data": {"customerSeq": 33}, "meta": {}}))
    assert run(client.create_customer("김철수", CALLER)) == expected
    assert seen[0].url.path == "/api/customers" and body(seen[0]) == {"name": "김철수", "phoneNumber": CALLER}


def test_create_pin_sends_sender_address_with_call_header():
    client, seen = api(lambda req: httpx2.Response(201, json={"data": {}, "meta": {}}))
    run(client.create_pin(20, 33, ORDER, "sender", "보내는 곳"))
    assert seen[0].url.path == "/api/customers/33/pins" and seen[0].headers["call_session_seq"] == "20"
    assert body(seen[0]) == {"label": "보내는 곳", "addressData": {
        "name": "김철수", "phoneNumber": CALLER, "roadAddress": ORDER.sender_address, "detailAddress": "1201호",
        "jibunAddress": GEO.jibun_address, "dongName": GEO.dong_name, "postalCode": GEO.postal_code}}
    client, _ = api(lambda req: httpx2.Response(403, json={"error": {"code": "FORBIDDEN"}}))
    with pytest.raises(BackendError):
        run(client.create_pin(20, 33, ORDER, "sender", "보내는 곳"))


# --- 통화 중 조회·취소(통화 고객 범위, call_session_seq 헤더) ---

def detail(order_seq, status, parcels):
    return {"orderSeq": order_seq, "status": status, "version": 3, "totalAmount": 9000, "parcels": [
        {"orderParcelSeq": seq, "status": st, "destination": {"name": name, "roadAddress": addr}}
        for seq, st, name, addr in parcels]}


def test_find_parcels_reads_details_without_name_in_url():
    def handler(req):
        if req.url.path == "/api/orders":
            return httpx2.Response(200, json={"data": [{"orderSeq": 101}, {"orderSeq": 100}], "hasNext": False})
        if req.url.path == "/api/orders/101":
            order = detail(101, "notPaid", [(301, "ACTIVE", "박민수", "대구로 1"),
                                            (302, "CANCELLED", "최지우", "서울로 2")])
            order["parcels"][0]["origin"] = {"roadAddress": "부산로 3", "detailAddress": "201호", "phoneNumber": CALLER}
            order["parcels"][0]["destination"].update(detailAddress="", phoneNumber=CALLER)
            return httpx2.Response(200, json={"data": order})
        return httpx2.Response(404, json={"error": {"code": "NOT_FOUND"}})

    client, seen = api(handler)
    parcels = run(client.find_parcels(20, 5))
    assert parcels == [
        {"order_seq": 101, "order_parcel_seq": 301, "receiver_name": "박민수", "receiver_address": "대구로 1",
         "status": "notPaid", "details": {"sender_address": "부산로 3", "sender_address_detail": "201호",
                                           "receiver_address": "대구로 1", "receiver_address_detail": ""}},
        {"order_seq": 101, "order_parcel_seq": 302, "receiver_name": "최지우", "receiver_address": "서울로 2",
         "status": "CANCELLED", "details": {"receiver_address": "서울로 2"}}]  # 취소한 상세는 CANCELLED, 없는 주문(404)은 뺀다
    assert dict(seen[0].url.params) == {"limit": "5"}  # 받는 분 이름(개인정보)을 URL에 넣지 않는다
    assert all(r.headers["call_session_seq"] == "20" for r in seen)
    assert run(client.parcel(20, 101, 302))["status"] == "CANCELLED" and run(client.parcel(20, 9, 1)) is None


@pytest.mark.parametrize("status, expected", [(204, "ok"), (404, "not_found"), (409, "conflict")])
def test_cancel_parcels_mapping(status, expected):
    client, seen = api(lambda req: httpx2.Response(status) if status == 204 else httpx2.Response(status, json={}))
    assert run(client.cancel_parcels(20, 100, [300])) == expected
    assert seen[0].method == "POST" and seen[0].url.path == "/api/orders/100/parcels/cancel"
    assert body(seen[0]) == {"orderParcelSeqs": [300]} and seen[0].headers["call_session_seq"] == "20"


def test_order_lookup_and_cancel_errors_raise():
    client, _ = api(lambda req: httpx2.Response(500, json={}))
    for coro in (client.find_parcels(20, 5), client.order_detail(20, 1), client.cancel_parcels(20, 1, [2])):
        with pytest.raises(BackendError):
            run(coro)


# --- 보류한 수정 도구·관제 화면(옛 계약) ---

@pytest.mark.parametrize("status, expected", [(200, "ok"), (404, "not_found"), (409, "cancelled")])
def test_update_status_mapping(status, expected):
    client, seen = api(lambda req: httpx2.Response(status, json={}))
    assert run(client.update_order(CALLER, "Q000001", {"receiver_name": "박", "status": "x"})) == expected
    assert seen[0].url.path == "/internal/ai/orders/Q000001/update"
    assert body(seen[0]) == {"caller_phone": CALLER, "changes": {"receiver_name": "박"}}  # 정해진 항목만


def test_order_no_cannot_escape_path():
    client, seen = api(lambda req: httpx2.Response(404, json={}))
    run(client.update_order(CALLER, "../callers/places", {}))
    assert seen[0].url.raw_path.startswith(b"/internal/ai/orders/..%2Fcallers%2Fplaces/")


def test_monitor_list():
    client, seen = api(lambda req: httpx2.Response(200, json={"orders": [{"order_no": "Q1"}]}))
    assert run(client.recent_orders(10)) == [{"order_no": "Q1"}]
    assert seen[0].method == "GET" and seen[0].url.params["limit"] == "10"


def test_unexpected_status_raises():
    client, _ = api(lambda req: httpx2.Response(500, json={}))
    with pytest.raises(BackendError):
        run(client.caller_context(CALLER))
    with pytest.raises(BackendError):
        run(client.update_order(CALLER, "Q1", {"receiver_name": "x"}))


def test_persona_calls_use_service_token_and_map_404_409():
    def handler(req):
        if req.url.path == "/api/ai/config":
            if req.url.params["status"] == "PENDING":
                return httpx2.Response(404, json={"error": {"code": "NOT_FOUND"}})
            return httpx2.Response(200, json={"data": {"aiPersonaVersionSeq": 3, "status": "ACTIVE"}, "meta": {}})
        if body(req)["applicationId"] == "old":
            return httpx2.Response(409, json={"error": {"code": "VERSION_CONFLICT"}})
        return httpx2.Response(500)

    client, seen = api(handler, persona_token="secret-token")
    assert run(client.persona_config("ACTIVE"))["aiPersonaVersionSeq"] == 3
    assert run(client.persona_config("PENDING")) is None
    assert run(client.persona_result({"applicationId": "old"})) is None
    with pytest.raises(BackendError):
        run(client.persona_result({"applicationId": "new"}))
    assert all(r.headers["authorization"] == "Bearer secret-token" for r in seen)


def test_order_calls_do_not_send_persona_token():
    client, seen = api(context({"lookupStatus": "UNREGISTERED"}), persona_token="secret-token")
    run(client.caller_context(CALLER))
    assert "authorization" not in seen[0].headers


DIRECTORY = {"data": [], "hasNext": False, "total_count": 0}


def business_calls(client):
    run(client.caller_context(CALLER))
    run(client.create_customer("김철수", CALLER))
    assert run(client.customer_detail(12))["customerSeq"] == 12
    run(client.update_customer(12, 20, {"name": "김철수", "address": {"roadAddress": "서울 예시로 12"}}))
    run(client.search_company_places("예시"))


def business_handler(req):
    if req.url.path == "/api/companies/search":
        return httpx2.Response(200, json=DIRECTORY)
    if req.url.path == "/api/customers":
        return httpx2.Response(201, json={"data": {"customerSeq": 12}})
    if req.method == "PATCH":
        return httpx2.Response(204)
    if req.method == "GET":
        return httpx2.Response(200, json={"data": {"customerSeq": 12}, "meta": {"requestId": "r"}})
    return context({"lookupStatus": "UNREGISTERED"})(req)


def test_customer_and_company_calls_send_business_token_only():
    client, seen = api(business_handler, business_token="biz-token", persona_token="persona", insights_token="ins")
    business_calls(client)
    assert [(r.method, r.url.path) for r in seen] == [
        ("POST", "/api/customers/context"), ("POST", "/api/customers"), ("GET", "/api/customers/12"),
        ("PATCH", "/api/customers/12"),
        ("GET", "/api/companies/search")]
    assert all(r.headers["authorization"] == "Bearer biz-token" and "cookie" not in r.headers for r in seen)
    assert seen[3].headers["call_session_seq"] == "20"  # 기존 통화 헤더 유지
    assert json.loads(seen[3].content) == {"name": "김철수", "address": {"roadAddress": "서울 예시로 12"}}  # 한 번의 PATCH


def test_business_token_unset_sends_no_authorization():
    client, seen = api(business_handler)
    business_calls(client)
    assert all("authorization" not in r.headers for r in seen)


def test_persona_and_insights_keep_their_tokens_with_business_token():
    def handler(req):
        if req.url.path == "/api/ai/config":
            return httpx2.Response(200, json={"data": {}})
        return httpx2.Response(204)
    client, seen = api(handler, business_token="biz-token", persona_token="persona", insights_token="ins")
    run(client.persona_config("ACTIVE"))
    run(client.send_call_events(1, {}))
    assert [r.headers["authorization"] for r in seen] == ["Bearer persona", "Bearer ins"]


def test_customer_detail_404_is_none():
    client, _ = api(lambda req: httpx2.Response(404, json={"error": {"code": "NOT_FOUND"}}))
    assert run(client.customer_detail(12)) is None


def test_401_raises_once_without_retry():
    client, seen = api(lambda req: httpx2.Response(401, json={"error": {"code": "UNAUTHORIZED"}}),
                       business_token="wrong")
    with pytest.raises(BackendError) as e:
        run(client.caller_context(CALLER))
    assert e.value.status == 401 and len(seen) == 1


@pytest.mark.parametrize("status, code, ok", [(201, None, True), (409, "DUPLICATE_RESOURCE", True),
                                              (409, "INVALID_STATE", False), (403, "FORBIDDEN", False)])
def test_create_pin_only_duplicate_409_is_success(status, code, ok):
    """B/pins.md: 중복 주소·사용 불가 상태 모두 409 — 중복(DUPLICATE_RESOURCE)만 그대로 성공."""
    client, seen = api(lambda req: httpx2.Response(status, json={"error": {"code": code}} if code else {"data": {}}))
    if ok:
        run(client.create_pin(20, 12, ORDER, "receiver", "집"))
    else:
        with pytest.raises(BackendError) as e:
            run(client.create_pin(20, 12, ORDER, "receiver", "집"))
        assert (e.value.status, e.value.code) == (status, code)
    assert seen[0].headers["call_session_seq"] == "20" and "latitude" not in body(seen[0])["addressData"]


def test_submit_result_rechecks_503_with_same_key():
    """B/ai-order-billing-integration.md §8: 503은 성공 안내 없이 같은 키로 결과 확인."""
    replies = [httpx2.Response(503, json={"error": {"code": "DEPENDENCY_UNAVAILABLE"}}),
               httpx2.Response(201, json={"data": {"status": "ACCEPTED"}})]
    client, seen = api(lambda req: replies.pop(0))
    assert run(client.submit_result({"outcome": "CANCELLED"}, "uuid-1"))["status"] == "ACCEPTED"
    assert len(seen) == 2 and {r.headers["Idempotency-Key"] for r in seen} == {"uuid-1"}


def test_persona_without_token_does_not_send_bearer_none():
    client, seen = api(lambda req: httpx2.Response(200, json={"data": {}}))
    with pytest.raises(BackendError, match="AI_PERSONA_TOKEN"):
        run(client.persona_config("ACTIVE"))
    assert seen == []


def order_api_handler(req):
    path, m = req.url.path, req.method
    if path == "/api/ai/faqs":
        return httpx2.Response(503)  # 요청 헤더만 본다
    if m == "POST" and path.endswith("cancel"):
        return httpx2.Response(204)
    if m == "PATCH":
        return httpx2.Response(200, json={"data": {"version": 5}})
    if path.endswith("/submit"):
        return httpx2.Response(200, json={"data": {"status": "notPaid"}})
    if path == "/api/orders" and m == "POST":
        return httpx2.Response(201, json={"data": {"status": "ACCEPTED"}})
    if path.endswith("/pins") and m == "POST":
        return httpx2.Response(201, json={"data": {"personalPinSeq": 1, "version": 1}})
    if path.endswith("/pins"):
        return httpx2.Response(200, json={"data": [], "hasNext": False, "total_count": 0})
    if path == "/api/orders/7":
        return httpx2.Response(200, json={"data": {"orderSeq": 7, "parcels": []}})
    return httpx2.Response(200, json={"data": []})


def order_api_calls(client):
    run(client.find_parcels(20, 3))
    run(client.submit_result({"outcome": "COMPLETE"}, "uuid-1"))
    run(client.order_detail(20, 7))
    assert run(client.update_collecting_order(20, 7, {"expectedVersion": 4, "paymentMethodType": "billing"})) == 5
    assert run(client.cancel_order(20, 7)) == "ok"
    assert run(client.cancel_parcels(20, 7, [101])) == "ok"
    assert run(client.submit_order(20, 7, 4)) == {"status": "notPaid"}
    run(client.address_history(20, 33, "ORIGIN", 1))
    assert run(client.list_pins(20, 33))["total_count"] == 0
    run(client.create_pin(20, 33, ORDER, "receiver", "집"))
    assert run(client.update_pin(20, 9, {"label": "회사"})) == 5
    for call in (client.initial_faq_entries(), client.faq_entries([1])):
        with pytest.raises(BackendError):
            run(call)


def test_order_pin_faq_calls_send_business_token():
    """요청한 12개 API에 Authorization: Bearer <AI_BUSINESS_TOKEN>. 통화 헤더·Idempotency-Key·본문은 그대로."""
    client, seen = api(order_api_handler, business_token="biz-token", persona_token="persona", insights_token="ins")
    order_api_calls(client)
    assert [(r.method, r.url.path) for r in seen] == [
        ("GET", "/api/orders"), ("POST", "/api/orders"), ("GET", "/api/orders/7"), ("PATCH", "/api/orders/7"),
        ("POST", "/api/orders/7/cancel"), ("POST", "/api/orders/7/parcels/cancel"), ("POST", "/api/orders/7/submit"),
        ("GET", "/api/customers/33/addresses"), ("GET", "/api/customers/33/pins"), ("POST", "/api/customers/33/pins"),
        ("PATCH", "/api/pins/9"), ("GET", "/api/ai/faqs"), ("GET", "/api/ai/faqs")]
    assert all(r.headers["authorization"] == "Bearer biz-token" and "cookie" not in r.headers for r in seen)
    faq = seen[-2:]
    assert all("call_session_seq" not in r.headers for r in faq + [seen[1]])  # FAQ·통화 결과는 통화 헤더 없음
    assert all(r.headers["call_session_seq"] == "20" for r in seen[:-2] if r is not seen[1])
    assert seen[1].headers["Idempotency-Key"] == "uuid-1" and body(seen[1]) == {"outcome": "COMPLETE"}
    assert body(seen[3]) == {"expectedVersion": 4, "paymentMethodType": "billing"}
    assert seen[4].content == b"" and body(seen[5]) == {"orderParcelSeqs": [101]}
    assert body(seen[6]) == {"expectedVersion": 4} and body(seen[10]) == {"label": "회사"}


def test_order_pin_faq_calls_without_business_token_send_no_authorization():
    client, seen = api(order_api_handler)
    order_api_calls(client)
    assert len(seen) == 13 and all("authorization" not in r.headers for r in seen)
