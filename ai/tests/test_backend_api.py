"""백엔드 API 클라이언트가 spec/backend-api.md대로 요청하고 응답을 해석하는지(가짜 HTTP 전송)."""

import json

import httpx2
import pytest
from conftest import CALLER, FULL_ORDER, run

from app.backend_api import BackendAPI, BackendError
from app.order import Order, Place

ORDER = Order(**{**FULL_ORDER, "sender_phone": CALLER, "receiver_phone": "01098765432"})


def api(handler):
    seen = []

    def wrapped(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return handler(request)

    return BackendAPI("http://backend", 3.0, transport=httpx2.MockTransport(wrapped)), seen


def body(request):
    return json.loads(request.content)


def test_caller_context_parses_recent_and_places_by_kind():
    def handler(req):
        return httpx2.Response(200, json={
            "recent_order": ORDER.model_dump(),
            "places": [
                {"kind": "origin", "name": "김철수", "phone": CALLER, "address": "서울", "address_detail": "1호"},
                {"kind": "destination", "name": "이영희", "phone": "0", "address": "부산", "address_detail": ""},
                {"kind": "nonsense", "name": "x", "phone": "0", "address": "x", "address_detail": ""},
            ]})

    client, seen = api(handler)
    ctx = run(client.caller_context(CALLER))
    assert ctx.recent == ORDER
    assert [p.address for p in ctx.places["origin"]] == ["서울"]
    assert [p.address for p in ctx.places["destination"]] == ["부산"]
    assert seen[0].method == "POST" and seen[0].url.path == "/internal/ai/callers/context"
    assert CALLER not in str(seen[0].url) and body(seen[0]) == {"phone": CALLER}  # 전화번호는 URL에 넣지 않는다


def test_caller_context_new_customer():
    client, _ = api(lambda req: httpx2.Response(200, json={"recent_order": None, "places": []}))
    ctx = run(client.caller_context(CALLER))
    assert ctx.recent is None and ctx.places == {"origin": [], "destination": []}


def test_create_order_sends_draft_and_idempotency_key():
    client, seen = api(lambda req: httpx2.Response(201, json={"order_no": "Q000123"}))
    assert run(client.create_order(CALLER, "live_1", ORDER, 3500, "live_1-1")) == "Q000123"
    req = seen[0]
    assert req.url.path == "/internal/ai/orders" and req.headers["Idempotency-Key"] == "live_1-1"
    assert body(req) == {"caller_phone": CALLER, "session_id": "live_1", "fare": 3500, **ORDER.model_dump()}


@pytest.mark.parametrize("status, expected", [(200, "ok"), (404, "not_found"), (409, "cancelled")])
def test_update_and_cancel_status_mapping(status, expected):
    client, seen = api(lambda req: httpx2.Response(status, json={}))
    assert run(client.update_order(CALLER, "Q000001", {"item": "책", "status": "x"})) == expected
    assert run(client.cancel_order(CALLER, "Q000001")) == expected
    assert seen[0].url.path == "/internal/ai/orders/Q000001/update"
    assert body(seen[0]) == {"caller_phone": CALLER, "changes": {"item": "책"}}  # 정해진 항목만
    assert seen[1].url.path == "/internal/ai/orders/Q000001/cancel"


def test_order_no_cannot_escape_path():
    client, seen = api(lambda req: httpx2.Response(404, json={}))
    run(client.cancel_order(CALLER, "../callers/places"))
    assert seen[0].url.raw_path.startswith(b"/internal/ai/orders/..%2Fcallers%2Fplaces/")


def test_save_places_and_lists():
    def handler(req):
        if req.url.path.endswith("/callers/places"):
            return httpx2.Response(200, json={"saved": 1})
        return httpx2.Response(200, json={"orders": [{"order_no": "Q1"}]})

    client, seen = api(handler)
    p = Place(name="김철수", phone=CALLER, address="서울", address_detail="")
    assert run(client.save_places(CALLER, [("origin", p)])) == 1
    assert body(seen[0]) == {"owner_phone": CALLER, "places": [{"kind": "origin", **p.model_dump()}]}
    assert run(client.list_orders(CALLER, 5)) == [{"order_no": "Q1"}]
    assert body(seen[1]) == {"caller_phone": CALLER, "limit": 5}
    assert run(client.recent_orders(10)) == [{"order_no": "Q1"}]
    assert seen[2].method == "GET" and seen[2].url.params["limit"] == "10"


def test_unexpected_status_raises():
    client, _ = api(lambda req: httpx2.Response(500, json={}))
    with pytest.raises(BackendError):
        run(client.caller_context(CALLER))
    with pytest.raises(BackendError):
        run(client.update_order(CALLER, "Q1", {"item": "x"}))
