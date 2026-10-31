"""도구 단위 테스트(디스패처 경유): 정상 · 인수 오류 · 허용되지 않은 단계, 레지스트리·전화번호."""

import json

import pytest
from conftest import FULL_ORDER, FakeBackend, make_call, run
from test_flow import orders_db

from app import address
from app.dispatcher import dispatch
from app.live_session import function_tool_names, load_live_toml
from app.tools._base import TOOLS, normalize_phone

SERVER_ONLY = {"cancel_order", "modify_order"}  # 서버만 부르거나(취소) 쓰지 않는(수정 보류) 도구


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
    assert set(names) == set(TOOLS) - SERVER_ONLY  # 백엔드 모델은 서버 전용 도구를 고를 수 없다


def test_action_tools_require_customer_confirmed():
    for name in ("modify_order", "cancel_order"):
        assert "customer_confirmed" in TOOLS[name].args.model_fields
    assert "operation_id" in TOOLS["cancel_order"].args.model_fields  # 쓰기마다 작업 번호


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
    not_allowed = call_tool(call, "cancel_order", {"order_seq": 1, "order_parcel_seq": 2, "customer_confirmed": True,
                                                   "operation_id": "op"})
    assert not_allowed["ok"] is False and "쓸 수 없는" in not_allowed["error"]
    assert not_allowed["state"]["stage"] == "A_NEW_ORDER"


def test_tool_exception_becomes_error_result(monkeypatch):
    async def boom(text):
        raise RuntimeError("secret internal detail")

    monkeypatch.setattr(address, "correct", boom)
    out = call_tool(make_call(), "record_order", {"sender_address": "서울"})
    assert out["ok"] is False and out["error"] == "내부 오류"
    assert "secret" not in json.dumps(out, ensure_ascii=False)


# --- 도구별 ---

def test_record_order():
    call = make_call()
    out = call_tool(call, "record_order", {"sender_name": "김철수", "sender_phone": "공일공 일이삼사 오육칠팔"})
    assert out["ok"] and call.order.sender_phone == "01012345678"
    assert out["state"]["stage"] == "A_REGISTER_SENDER" and out["state"]["missing"][0] == "sender_address"


def test_record_order_invalid_phone_not_saved_but_rest_recorded():
    call = make_call()
    out = call_tool(call, "record_order", {"receiver_name": "이영희", "receiver_phone": "공일공 일이삼"})
    assert out["ok"] is False and "receiver_phone" in out["error"]
    assert call.order.receiver_name == "이영희" and call.order.receiver_phone is None


def test_record_order_not_allowed_outside_order_steps():
    for stage in ("HUB", "C_CHOICE", "D_AFTER_ANSWER", "RAG", "END_CALL"):
        assert call_tool(at(stage), "record_order", {"other_item": "옷"})["ok"] is False


def test_record_order_items_and_call_fields():
    call = make_call()
    out = call_tool(call, "record_order", {"small_box_count": 2, "other_item": "", "item_price": 50000,
                                           "client_comment": "문 앞", "pickup_at": FULL_ORDER["pickup_at"],
                                           "customer_name": " 박영수 "})
    assert out["ok"] and call.order.has("item") and call.order.item_price == 50000
    assert call.order.client_comment == "문 앞" and call.customer_name == "박영수"
    assert call.pickup_at == FULL_ORDER["pickup_at"] and {"pickup_at", "customer_name"} <= set(out["recorded"])
    assert call_tool(call, "record_order", {"small_box_count": -1})["ok"] is False  # 범위 밖은 스키마에서 거절


def test_pickup_time_must_be_future_with_timezone():
    call = make_call()
    for bad in ("2020-01-01T10:00:00+09:00", "2099-01-01T10:00:00", "내일 오전"):
        out = call_tool(call, "record_order", {"pickup_at": bad})
        assert out["ok"] is False and "수거" in out["retry"] and call.pickup_at is None
    call_tool(call, "record_order", {"pickup_at": "2099-01-01T01:00:00Z"})
    assert call.pickup_at == "2099-01-01T10:00:00+09:00"  # 한국 시간으로


def test_record_order_address_change_clears_detail():
    call = make_call()
    call_tool(call, "record_order", {"receiver_address": "부산", "receiver_address_detail": "1호"})
    call_tool(call, "record_order", {"receiver_address": "부산"})
    assert call.order.receiver_address_detail == "1호"  # 같은 주소면 그대로
    call_tool(call, "record_order", {"receiver_address": "대구"})
    assert call.order.receiver_address_detail is None


def test_lookup_is_scoped_to_caller_and_filters_by_receiver():
    call = at("C_FIND_RECENT", orders_db())
    out = call_tool(call, "lookup_orders", {"receiver_name": "이영희"})
    assert out["ok"] and out["found"] == 1 and call.lookup["orders"][0]["receiver_name"] == "이영희"
    call = at("C_FIND_RECENT", orders_db())
    call_tool(call, "lookup_orders", {"receiver_name": None})
    assert [o["receiver_name"] for o in call.lookup["orders"]] == ["박민수", "이영희"]  # 다른 고객의 주문은 없다


def test_lookup_without_caller_is_a_failure():
    call = make_call(caller=None)
    call.flow.stage = "C_FIND_RECENT"
    out = call_tool(call, "lookup_orders", {"receiver_name": "이영희"})
    assert call.lookup["failed"] and "다시 한 번 확인해 드릴까요" in out["state"]["next"]


def test_cancel_is_scoped_to_caller_and_needs_confirmation():
    db = orders_db()
    call = at("C_CANCEL", db)
    seqs = [(o["orderSeq"], o["parcels"][0]["orderParcelSeq"]) for o in db.orders]
    args = {"order_seq": seqs[2][0], "order_parcel_seq": seqs[2][1], "customer_confirmed": True, "operation_id": "op1"}
    assert call_tool(call, "cancel_order", args)["ok"] is False  # 다른 고객의 주문
    assert db.orders[2]["parcels"][0]["status"] == "ACTIVE"
    mine = {"order_seq": seqs[1][0], "order_parcel_seq": seqs[1][1]}
    assert call_tool(call, "cancel_order", {**args, **mine, "customer_confirmed": False})["ok"] is False
    assert call_tool(call, "cancel_order", {**args, **mine, "operation_id": "op2"})["ok"] is True
    assert db.orders[1]["parcels"][0]["status"] == "CANCELLED" and call.running_ops["op2"]["status"] == "done"


def test_get_state():
    out = call_tool(make_call(), "get_state", {})
    assert out["ok"] and out["state"]["stage"] == "A_NEW_ORDER" and "record_order" in out["state"]["tools"]


def test_match_pins_only_in_matching_steps():
    assert call_tool(make_call(), "match_pins", {"name": "이영희"})["ok"] is False
    call = at("B_DEST_MATCH", FakeBackend())
    call.set_pin_role("destination")
    out = call_tool(call, "match_pins", {"name": "이영희"})
    assert out["ok"] and out["state"]["stage"] == "B_DEST_MATCH"  # 핀이 없고 이름만 말했으면 주소를 묻는다
    out = call_tool(call, "match_pins", {"place": "대구 중구 동성로 1"})
    assert out["ok"] and out["state"]["stage"] == "A_RECEIVER_HUB"  # 이름·주소로도 없으면 새 받는 분
