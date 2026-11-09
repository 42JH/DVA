"""BE 계약 테스트(overview.md §7). 픽스처 = BE 원문 예시 그대로(fixtures/be_contract/<원문 커밋>/).

BE 문서가 바뀌면: 새 커밋 폴더에 예시를 추가하고 VERSIONS에 넣는다 → 실패하는 테스트가 영향 범위다.
확인하는 것: 원문 응답 예시를 해석한다 · 모르는 필드는 무시한다 · 쓰는 필드가 없으면 BE_CONTRACT_VIOLATION ·
요청 본문은 원문에 있는 필드만 쓰고 좌표를 보내지 않는다 · 가짜 BE(MockBackend)도 같은 오류 분류를 낸다.
"""

import json
from pathlib import Path

import httpx2
import pytest
from conftest import CALLER, GEO, INCOMING_AT, PICKUP_AT, run

from app.integrations.backend.gateway import BackendFailure, BackendGateway
from backend_client.api import BackendAPI, result_body
from backend_client.mock import MockBackend
from backend_client.order import Order

FIXTURES = Path(__file__).parent / "fixtures" / "be_contract"
VERSIONS = ["a629c60"]  # docs/be-contract/README.md: origin/develop-backend a629c60 (2026-11-03)
CALL_ID = {"providerCallId": "live_1", "incomingAt": INCOMING_AT}
ORDER = Order(sender_name="김철수", sender_phone=CALLER, sender_address="서울 강남구 테헤란로 212",
              sender_address_detail="1201호", receiver_name="이영희", receiver_phone="01098765432",
              receiver_address="부산 해운대구 센텀로 10", receiver_address_detail="", small_box_count=1,
              item_price=30000, sender_geo=GEO, receiver_geo=GEO)


def fixture(version: str, name: str) -> dict:
    return json.loads((FIXTURES / version / name).read_text(encoding="utf-8"))


def client(routes: dict[str, dict | int]) -> tuple[BackendAPI, list]:
    """경로 → 응답 본문(200) 또는 상태 코드."""
    seen = []

    def handler(req: httpx2.Request) -> httpx2.Response:
        seen.append(req)
        r = routes[req.url.path]
        return httpx2.Response(r, json={"error": {"code": "X"}}) if isinstance(r, int) else httpx2.Response(200, json=r)

    return BackendAPI("http://be", 3.0, transport=httpx2.MockTransport(handler)), seen


def with_unknown_fields(obj):
    """모든 객체에 모르는 필드를 더한다(BE가 필드를 추가해도 동작해야 한다)."""
    if isinstance(obj, dict):
        return {**{k: with_unknown_fields(v) for k, v in obj.items()}, "zzUnknownField": {"x": 1}}
    if isinstance(obj, list):
        return [with_unknown_fields(v) for v in obj]
    return obj


@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("extra", [False, True])
def test_caller_context_and_address_history_examples(version, extra):
    ctx_body, hist = fixture(version, "caller_context.response.json"), fixture(version, "address_history.response.json")
    if extra:
        ctx_body, hist = with_unknown_fields(ctx_body), with_unknown_fields(hist)
    api, seen = client({"/api/customers/context": ctx_body, "/api/customers/12/addresses": hist})
    ctx = run(api.caller_context(CALLER, CALL_ID))
    assert (ctx.status, ctx.customer_seq, ctx.call_session_seq, ctx.payment_methods) == ("REGISTERED", 12, 7, ["billing"])
    assert [p.address for p in ctx.places] == ["서울 예시로 12"] and ctx.places[0].geo.postal_code == "01234"
    assert ctx.recent_origin is not None and ctx.recent_origin.address == "예시로 12"
    assert all(r.headers.get("call_session_seq") == "7" for r in seen[1:])


@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("extra", [False, True])
def test_company_search_and_orders_list_examples(version, extra):
    search, orders = fixture(version, "company_search.response.json"), fixture(version, "orders_list.response.json")
    if extra:
        search, orders = with_unknown_fields(search), with_unknown_fields(orders)
    detail = {"data": {"orderSeq": 123, "status": "COLLECTING", "parcels": [
        {"orderParcelSeq": 1, "status": "COLLECTING", "destination": {"name": "이영희", "roadAddress": "부산 센텀로 10"}}]}}
    api, _ = client({"/api/companies/search": search, "/api/orders": orders, "/api/orders/123": detail})
    page = run(api.search_company_places("예시기업"))
    assert page.places and page.places[0].organization_name == "예시기업" and page.total_count == search["total_count"]
    parcels = run(api.find_parcels(7, 5))
    assert parcels == [{"order_seq": 123, "order_parcel_seq": 1, "receiver_name": "이영희",
                        "receiver_address": "부산 센텀로 10", "status": "COLLECTING",
                        "details": {"receiver_address": "부산 센텀로 10"}}]


@pytest.mark.parametrize("version", VERSIONS)
def test_submit_response_example(version):
    resp = fixture(version, "orders_submit.response.json")
    api, seen = client({"/api/orders": resp})
    data = run(api.submit_result({"outcome": "CANCELLED", "call": {}}, "0b7e6a52-6f0e-4a3b-9a3e-5a1f8f0c2d11"))
    assert data["status"] == "ACCEPTED" and data["parcelNo"] == "TEST0057"
    assert seen[0].headers["Idempotency-Key"] == "0b7e6a52-6f0e-4a3b-9a3e-5a1f8f0c2d11"


# 원문(B/orders.md·ai-order-billing-integration.md·address-coordinates-removal.md)에 있는 필드 — docs/contracts/be-api.md §8
SUBMIT_FIELDS = {"outcome", "call", "customerSeq", "customer", "paymentMethodType", "pickupRequestedAt", "totalAmount",
                 "parcels"}
CALL_FIELDS = {"providerCallId", "callerPhoneNumber", "incomingAt"}
PARCEL_FIELDS = {"origin", "destination", "originPin", "documentCount", "smallBoxCount", "mediumBoxCount", "bigBoxCount",
                 "otherItemDescription", "clientComment", "itemPrice", "notifiedPrice"}  # 수량 4종: B/orders.md
ADDRESS_FIELDS = {"name", "phoneNumber", "roadAddress", "jibunAddress", "detailAddress", "dongName", "postalCode"}


@pytest.mark.parametrize("version", VERSIONS)
def test_submit_request_uses_only_documented_fields(version):
    example = fixture(version, "orders_submit.request.json")
    assert set(example) <= SUBMIT_FIELDS and set(example["call"]) == CALL_FIELDS  # 원문 예시도 같은 필드 집합 안
    call = {"providerCallId": "live_1", "callerPhoneNumber": CALLER, "incomingAt": INCOMING_AT}
    every = ORDER.model_copy(update={"document_count": 1, "medium_box_count": 2, "big_box_count": 3,
                                     "other_item": "이불", "client_comment": "문 앞"})
    for body in (result_body("COMPLETE", call, None, "김철수", CALLER, "credit", PICKUP_AT, [ORDER, every], [4000, 5000]),
                 result_body("INCOMPLETE", call, 12, None, CALLER, None, None, [Order(receiver_name="박")])):
        assert set(body) <= SUBMIT_FIELDS and set(body["call"]) == CALL_FIELDS
        for p in body.get("parcels", []):
            assert set(p) <= PARCEL_FIELDS
            for role in ("origin", "destination"):
                assert set(p.get(role, {})) <= ADDRESS_FIELDS  # 좌표(latitude·longitude)는 400 — 보내지 않는다


@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("drop", ["data", "lookupStatus"])
def test_missing_used_field_is_contract_violation(version, drop):
    body = fixture(version, "caller_context.response.json")
    body = {k: v for k, v in body.items() if k != drop} if drop == "data" else \
        {**body, "data": {k: v for k, v in body["data"].items() if k != drop}}
    api, _ = client({"/api/customers/context": body})
    with pytest.raises(BackendFailure) as e:
        run(BackendGateway(api).read("caller_context", api.caller_context, CALLER, CALL_ID))
    assert e.value.code == "BE_CONTRACT_VIOLATION"


@pytest.mark.parametrize("status, kind", [(409, "state"), (403, "forbidden"), (400, "contract"), (503, "unavailable")])
def test_http_errors_are_classified(status, kind):
    api, _ = client({"/api/customers/context": status})
    with pytest.raises(BackendFailure) as e:
        run(BackendGateway(api).read("caller_context", api.caller_context, CALLER, CALL_ID))
    assert e.value.kind == kind and e.value.http_status == status


def test_mock_backend_failures_classify_like_real_backend():
    """가짜 BE도 원문 오류(상태·코드)를 같은 분류로 낸다: 같은 통화 두 번째 주문 409, 좌표 400, 다른 고객 주소 403."""
    mock = MockBackend()
    gw = BackendGateway(mock)
    ctx = run(mock.caller_context(CALLER, CALL_ID))
    call = {"providerCallId": "live_1", "callerPhoneNumber": CALLER, "incomingAt": INCOMING_AT}
    first = run(gw.write("submit", mock.submit_result, {"outcome": "CANCELLED", "call": call}, "k1"))
    assert first["status"] in ("CANCELLED", "NO_ORDER")
    with pytest.raises(BackendFailure) as e:
        run(gw.write("submit", mock.submit_result, {"outcome": "CANCELLED", "call": call}, "k2"))
    assert (e.value.kind, e.value.error_code) == ("state", "INVALID_STATE")
    with pytest.raises(BackendFailure) as e:
        run(gw.read("history", mock.address_history, ctx.call_session_seq, 999, "ORIGIN", 1))
    assert (e.value.kind, e.value.http_status) == ("forbidden", 403)


def test_latest_spec_7da8876_submit_analysis_and_events_shapes(tmp_path):
    """spec/ai-integration-current.md(BE 7da8876) 예시와 같은 필드 집합을 만든다."""
    from app.calls.results import ResultService
    from app.persistence.outbox import Outbox
    from app.tests.test_domain import P as POLICY
    from app.tests.test_domain import confirm_once, fare, filled
    from app.tests.test_results import session

    example = fixture("7da8876", "orders_submit.request.json")
    assert "pickupRequestedAt" not in example and set(example) <= SUBMIT_FIELDS
    analysis_example = fixture("7da8876", "analysis.request.json")
    db = MockBackend()
    st = filled()
    st.customer.customer_seq = db.add_customer(CALLER, "김철수")
    st.customer.initial_status = "REGISTERED"
    st.customer.call_session_seq = run(db.caller_context(CALLER, {"providerCallId": "live_1",
                                                                    "incomingAt": INCOMING_AT})).call_session_seq
    confirm_once(st)
    s = session(st)
    rs = ResultService(BackendGateway(db), Outbox(tmp_path / "o.sqlite3"), POLICY, fare)
    run(rs.finish(s))
    body = db.results[-1]["body"]
    assert set(body) <= SUBMIT_FIELDS and body["pickupRequestedAt"].endswith("+09:00")  # 시간대 포함(ai-call-follow-up.md)
    assert set(body["parcels"][0]) <= PARCEL_FIELDS
    assert set(db.analyses[st.customer.call_session_seq]) == set(analysis_example)  # 7개 값 + 필수 필드, result 없음
    event_example = fixture("7da8876", "events.request.json")["events"][0]
    sent = next(iter(db.events[st.customer.call_session_seq].values()))
    assert set(sent) == set(event_example)
