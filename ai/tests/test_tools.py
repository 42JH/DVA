"""도구 단위 테스트(디스패처 경유): 정상 · 인수 오류 · 허용되지 않은 단계, 레지스트리·전화번호."""

import json

import pytest
from conftest import CALLER, FULL_ORDER, FakeDB, make_call, run

from app.dispatcher import dispatch
from app.live_session import function_tool_names, load_live_toml
from app.order import Place
from app.tools._base import TOOLS, normalize_phone


def call_tool(call, name, args, call_id="c1"):
    return run(dispatch(call, name, json.dumps(args, ensure_ascii=False), call_id))


def at(stage, db=None, **order):
    call = make_call(db)
    call.flow.stage = stage
    for k, v in order.items():
        setattr(call.order, k, v)
    return call


def filled_order():
    call = make_call()
    out = call_tool(call, "record_order", FULL_ORDER)
    assert out["ok"], out
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


def test_action_tools_require_customer_confirmed():
    for name in ("confirm_order", "modify_order", "cancel_order", "transfer_to_agent", "end_call", "save_places"):
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
    extra = call_tool(call, "record_order", {"hacker": "x"})
    assert extra["ok"] is False
    not_allowed = call_tool(call, "confirm_order", {"answer": "confirm", "customer_confirmed": True})
    assert not_allowed["ok"] is False and "쓸 수 없는" in not_allowed["error"]
    assert not_allowed["state"]["stage"] == "collecting_new"


def test_tool_exception_becomes_error_result():
    db = FakeDB()

    async def boom(*a, **k):
        raise RuntimeError("secret internal detail")

    db.insert_order = boom
    call = at("confirming", db, **filled_order().order.model_dump())
    out = call_tool(call, "confirm_order", {"answer": "confirm", "customer_confirmed": True})
    assert out == {**out, "ok": False, "error": "내부 오류"}
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


def test_record_order_not_allowed_in_after_order():
    out = call_tool(at("after_order"), "record_order", {"item": "옷"})
    assert out["ok"] is False


def test_confirm_order_submits_exact_draft_and_clears():
    db = FakeDB()
    call = make_call(db)
    call_tool(call, "record_order", FULL_ORDER)
    assert call.flow.stage == "confirming"
    out = call_tool(call, "confirm_order", {"answer": "confirm", "customer_confirmed": True})
    assert out["ok"] and out["order_no"] == "Q000001" and "Q000001" in out["say"]
    saved = db.orders[0]
    assert saved["sender_phone"] == "01012345678" and saved["receiver_address_detail"] == ""
    assert call.order.model_dump() == {k: None for k in call.order.model_dump()}  # 중복 접수 방지
    # 같은 확인이 또 와도 다시 접수되지 않는다(이미 다음 단계)
    again = call_tool(call, "confirm_order", {"answer": "confirm", "customer_confirmed": True})
    assert again["ok"] is False and len(db.orders) == 1


def test_confirm_order_requires_customer_confirmed():
    call = filled_order()
    out = call_tool(call, "confirm_order", {"answer": "confirm", "customer_confirmed": False})
    assert out["ok"] is False and call.flow.stage == "confirming"


def test_confirm_order_unclear_and_correct():
    call = filled_order()
    assert call_tool(call, "confirm_order", {"answer": "unclear", "customer_confirmed": False})["ok"] is False
    assert call_tool(call, "confirm_order", {"answer": "correct", "customer_confirmed": False})["ok"] is True
    assert call.flow.stage == "confirming"


def test_saved_places_only_callers_own():
    db = FakeDB()
    mine = Place(name="김철수", phone="01012345678", address="서울", address_detail="1호")
    db.places = {CALLER: [mine], "01099999999": [Place(name="남", phone="0", address="남의 집", address_detail="")]}
    call = make_call(db)
    out = call_tool(call, "find_saved_places", {})
    assert [p["address"] for p in out["places"]] == ["서울"]
    out = call_tool(call, "use_saved_place", {"place_id": 1, "role": "sender"})
    assert out["ok"] and call.order.sender_address == "서울"
    assert call_tool(call, "use_saved_place", {"place_id": 2, "role": "sender"})["ok"] is False
    assert call_tool(call, "use_saved_place", {"place_id": 1, "role": "boss"})["ok"] is False


def test_saved_places_without_caller():
    call = make_call(caller=None)
    assert call_tool(call, "find_saved_places", {})["ok"] is False


def test_save_places_requires_confirmation_and_saves_to_caller():
    db = FakeDB()
    call = filled_order()
    call.db = db
    call_tool(call, "confirm_order", {"answer": "confirm", "customer_confirmed": True})
    assert call.flow.stage == "save_offer" and len(call.save_candidates) == 2
    assert call_tool(call, "save_places", {"answer": "yes", "customer_confirmed": False})["ok"] is False
    out = call_tool(call, "save_places", {"answer": "yes", "customer_confirmed": True})
    assert out["saved"] == 2 and len(db.places[CALLER]) == 2 and call.flow.stage == "after_order"


def test_use_recent_receiver():
    db = FakeDB()
    run(db.insert_order(CALLER, "old", filled_order().order, 3500, "Q"))
    call = make_call(db)
    assert call.customer_type == "registered" and call.flow.stage == "collecting_registered"
    assert call_tool(call, "use_recent_receiver", {"answer": "maybe"})["ok"] is False
    out = call_tool(call, "use_recent_receiver", {"answer": "yes"})
    assert out["ok"] and call.order.receiver_name == "이영희"
    assert out["state"]["missing"][0] == "sender_name"
    assert call_tool(at("collecting_new"), "use_recent_receiver", {"answer": "yes"})["ok"] is False


def test_lookup_modify_cancel_scoped_to_caller():
    db = FakeDB()
    order = filled_order().order
    mine = run(db.insert_order(CALLER, "s", order, 3500, "Q"))
    other = run(db.insert_order("01099999999", "s", order, 3500, "Q"))
    call = at("modify", db)
    assert [o["order_no"] for o in call_tool(call, "lookup_orders", {})["orders"]] == [mine]
    args = {k: None for k in FULL_ORDER} | {"item": "책", "customer_confirmed": True}
    assert call_tool(call, "modify_order", args | {"order_no": other})["ok"] is False
    assert call_tool(call, "modify_order", args | {"order_no": mine, "customer_confirmed": False})["ok"] is False
    bad_phone = call_tool(call, "modify_order", args | {"order_no": mine, "receiver_phone": "010"})
    assert bad_phone["ok"] is False
    assert call_tool(call, "modify_order", args | {"order_no": mine.lower()})["ok"] is True
    assert db.orders[0]["item"] == "책"

    call = at("cancel", db)
    assert call_tool(call, "cancel_order", {"order_no": other, "customer_confirmed": True})["ok"] is False
    assert call_tool(call, "cancel_order", {"order_no": mine, "customer_confirmed": False})["ok"] is False
    assert call_tool(call, "cancel_order", {"order_no": mine, "customer_confirmed": True})["ok"] is True
    assert db.orders[0]["status"] == "cancelled" and db.orders[1]["status"] == "received"
    assert call_tool(at("collecting_new", db), "cancel_order", {"order_no": mine, "customer_confirmed": True})["ok"] is False


def test_next_request():
    call = at("after_order")
    out = call_tool(call, "next_request", {"intent": "lookup"})
    assert out["ok"] and call.flow.stage == "lookup"
    assert call_tool(call, "next_request", {"intent": "end"})["ok"] is False  # enum 밖
    assert call_tool(at("save_offer"), "next_request", {"intent": "lookup"})["ok"] is False


def test_transfer_to_agent():
    call = at("handoff")
    assert call_tool(call, "transfer_to_agent", {"customer_confirmed": False})["ok"] is False
    assert not call.refer_requested.is_set()
    assert call_tool(call, "transfer_to_agent", {"customer_confirmed": True})["ok"] is True
    assert call.refer_requested.is_set() and call.flow.stage == "ending"
    assert call_tool(at("after_order"), "transfer_to_agent", {"customer_confirmed": True})["ok"] is False


def test_end_call():
    call = at("after_order")
    assert call_tool(call, "end_call", {"customer_confirmed": False})["ok"] is False
    assert call_tool(call, "end_call", {"customer_confirmed": True})["ok"] is True
    assert call.hangup_requested.is_set() and call.flow.stage == "ending"
    assert call_tool(call, "end_call", {"customer_confirmed": True})["ok"] is False  # ending에서는 없음


def test_get_state():
    out = call_tool(make_call(), "get_state", {})
    assert out["ok"] and out["state"]["stage"] == "collecting_new" and "record_order" in out["state"]["tools"]
