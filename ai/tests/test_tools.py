"""도구 단위 테스트(디스패처 경유): 정상 · 인수 오류 · 허용되지 않은 단계, 레지스트리·전화번호."""

import json

import pytest
from conftest import CALLER, FULL_ORDER, FakeBackend, make_call, run

from app.dispatcher import dispatch
from app.live_session import function_tool_names, load_live_toml
from app.order import Order
from app.tools._base import TOOLS, normalize_phone


def call_tool(call, name, args, call_id="c1"):
    return run(dispatch(call, name, json.dumps(args, ensure_ascii=False), call_id))


def at(stage, db=None, **order):
    call = make_call(db)
    call.flow.stage = stage
    for k, v in order.items():
        setattr(call.order, k, v)
    return call


# --- 레지스트리 ---

def test_all_tool_schemas_are_strict():
    for t in TOOLS.values():
        spec = t.spec()
        assert spec["strict"] is True
        params = spec["parameters"]
        assert params["additionalProperties"] is False
        assert set(params["required"]) == set(params["properties"])


def test_live_toml_function_tools_exist():
    names = function_tool_names(load_live_toml())
    assert names and all(n in TOOLS for n in names)
    assert set(names) == set(TOOLS)  # 등록된 도구를 모두 쓴다


def test_action_tools_require_customer_confirmed():
    for name in ("modify_order", "cancel_order"):
        assert "customer_confirmed" in TOOLS[name].args.model_fields


# --- 전화번호 ---

@pytest.mark.parametrize("raw, expected", [
    ("공일공 일이삼사 오육칠팔", "01012345678"),
    ("010-1234-5678", "01012345678"),
    ("+82 10 1234 5678", "01012345678"),
    ("0101234567", None),            # 010은 11자리
    ("02-123-4567", "021234567"),
    ("031 1234 5678", "03112345678"),
    ("1588-1234", "15881234"),
    ("일육공공 일이삼사", "16001234"),
    ("12345", None),
    ("0212", None),
])
def test_normalize_phone(raw, expected):
    assert normalize_phone(raw) == expected


# --- 디스패처 공통 ---

def test_unknown_tool_and_bad_args_and_not_allowed():
    call = make_call()
    assert call_tool(call, "nope", {})["error"].startswith("없는 도구")
    bad = call_tool(call, "record_order", {"sender_name": 123})
    assert bad["ok"] is False and bad["error"] == "인수 오류"
    assert call_tool(call, "record_order", {"hacker": "x"})["ok"] is False
    not_allowed = call_tool(call, "cancel_order", {"order_no": "Q000001", "customer_confirmed": True})
    assert not_allowed["ok"] is False and "쓸 수 없는" in not_allowed["error"]
    assert not_allowed["state"]["stage"] == "collecting"


def test_tool_exception_becomes_error_result():
    db = FakeBackend()

    async def boom(*a, **k):
        raise RuntimeError("secret internal detail")

    db.list_orders = boom
    out = call_tool(at("lookup", db), "lookup_orders", {})
    assert out["ok"] is False and out["error"] == "내부 오류"
    assert "secret" not in json.dumps(out, ensure_ascii=False)


# --- 도구별 ---

def test_record_order():
    call = make_call()
    out = call_tool(call, "record_order", {"sender_name": "김철수", "sender_phone": "공일공 일이삼사 오육칠팔"})
    assert out["ok"] and call.order.sender_phone == "01012345678"
    assert out["state"]["missing"][0] == "sender_address"


def test_record_order_invalid_phone_not_saved_but_rest_recorded():
    call = make_call()
    out = call_tool(call, "record_order", {"sender_name": "김철수", "sender_phone": "공일공 일이삼"})
    assert out["ok"] is False and "sender_phone" in out["error"]
    assert call.order.sender_name == "김철수" and call.order.sender_phone is None


def test_record_order_not_allowed_outside_collecting_and_confirming():
    for stage in ("after_order", "recent_offer", "save_offer", "ending"):
        assert call_tool(at(stage), "record_order", {"item": "옷"})["ok"] is False


def test_record_order_address_change_clears_detail():
    call = make_call()
    call_tool(call, "record_order", {"receiver_address": "부산", "receiver_address_detail": "1호"})
    call_tool(call, "record_order", {"receiver_address": "부산"})
    assert call.order.receiver_address_detail == "1호"  # 같은 주소면 그대로
    call_tool(call, "record_order", {"receiver_address": "대구"})
    assert call.order.receiver_address_detail is None


def test_lookup_modify_cancel_scoped_to_caller():
    db = FakeBackend()
    order = Order(**{**FULL_ORDER, "sender_phone": CALLER, "receiver_phone": "01098765432"})
    mine = run(db.create_order(CALLER, "s", order, 3500, None))
    other = run(db.create_order("01099999999", "s", order, 3500, None))
    call = at("modify", db)
    assert [o["order_no"] for o in call_tool(call, "lookup_orders", {})["orders"]] == [mine]
    args = {k: None for k in FULL_ORDER} | {"item": "책", "customer_confirmed": True}
    assert call_tool(call, "modify_order", args | {"order_no": other})["ok"] is False  # 다른 발신번호의 주문
    assert call_tool(call, "modify_order", args | {"order_no": mine, "customer_confirmed": False})["ok"] is False
    assert call_tool(call, "modify_order", args | {"order_no": mine, "receiver_phone": "010"})["ok"] is False
    assert call_tool(call, "modify_order", args | {"order_no": mine.lower()})["ok"] is True
    assert db.orders[0]["item"] == "책"

    call = at("cancel", db)
    assert call_tool(call, "cancel_order", {"order_no": other, "customer_confirmed": True})["ok"] is False
    assert call_tool(call, "cancel_order", {"order_no": mine, "customer_confirmed": False})["ok"] is False
    assert call_tool(call, "cancel_order", {"order_no": mine, "customer_confirmed": True})["ok"] is True
    assert db.orders[0]["status"] == "cancelled" and db.orders[1]["status"] == "received"


def test_lookup_without_caller():
    call = make_call(caller=None)
    call.flow.stage = "lookup"
    assert call_tool(call, "lookup_orders", {})["ok"] is False


def test_get_state():
    out = call_tool(make_call(), "get_state", {})
    assert out["ok"] and out["state"]["stage"] == "collecting" and "record_order" in out["state"]["tools"]
