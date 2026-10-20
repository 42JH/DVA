"""분기 로직을 LLM 없이 검증: 시나리오마다 "보고(도구 호출) 순서 → 기대하는 단계"를 데이터로 적는다.
분기를 추가하면 SCENARIOS에 한 건을 추가한다."""

import json

import pytest
from conftest import CALLER, CFG, FULL_ORDER, TEXTS, FakeDB, make_call, run

from app.dispatcher import dispatch
from app.flow import engine
from app.order import Order

SENDER = {k: v for k, v in FULL_ORDER.items() if k.startswith("sender")}
REST = {k: v for k, v in FULL_ORDER.items() if not k.startswith("sender")}
YES = {"customer_confirmed": True}
CONFIRM = {"answer": "confirm", "customer_confirmed": True}


def registered_db():
    db = FakeDB()
    run(db.insert_order(CALLER, "old", Order(**{**FULL_ORDER, "sender_phone": CALLER}), 3500, "Q"))
    return db


# (이름, DB 준비, [(도구, 인수, 기대 단계, 기대 ok)])
SCENARIOS = [
    ("신규 고객: 접수 → 주소 저장 → 추가 주문 → 종료", FakeDB, [
        ("record_order", SENDER, "collecting_new", True),
        ("record_order", REST, "confirming", True),
        ("confirm_order", CONFIRM, "save_offer", True),
        ("save_places", {"answer": "yes", **YES}, "after_order", True),
        ("next_request", {"intent": "new_order"}, "collecting_new", True),
        ("end_call", YES, "ending", True),
    ]),
    ("등록 고객: 최근 받는 분 사용 → 접수 → 저장 거절", registered_db, [
        ("use_recent_receiver", {"answer": "yes"}, "collecting_registered", True),
        ("record_order", SENDER | {"item": "책"}, "confirming", True),
        ("confirm_order", CONFIRM, "save_offer", True),
        ("save_places", {"answer": "no", "customer_confirmed": False}, "after_order", True),
    ]),
    ("확인 단계: 정정 후 접수, 애매한 답은 그대로", FakeDB, [
        ("record_order", FULL_ORDER, "confirming", True),
        ("confirm_order", {"answer": "unclear", "customer_confirmed": False}, "confirming", False),
        ("confirm_order", {"answer": "correct", "customer_confirmed": False}, "confirming", True),
        ("record_order", {"item": "서류"}, "confirming", True),
        ("confirm_order", CONFIRM, "save_offer", True),
    ]),
    ("허용되지 않은 도구는 거절하고 단계 유지", FakeDB, [
        ("confirm_order", CONFIRM, "collecting_new", False),
        ("save_places", {"answer": "yes", **YES}, "collecting_new", False),
        ("transfer_to_agent", YES, "collecting_new", False),
    ]),
    ("접수 중 조회 하위 흐름 → other로 원래 단계 복귀", registered_db, [
        ("record_order", {"sender_name": "김철수"}, "collecting_registered", True),
        ("next_request", {"intent": "lookup"}, "lookup", True),
        ("lookup_orders", {}, "lookup", True),
        ("next_request", {"intent": "other"}, "collecting_registered", True),
    ]),
    ("확인 중 취소 하위 흐름 → 취소 후 확인 단계로 복귀", registered_db, [
        ("use_recent_receiver", {"answer": "no"}, "collecting_registered", True),
        ("record_order", FULL_ORDER, "confirming", True),
        ("next_request", {"intent": "cancel"}, "cancel", True),
        ("cancel_order", {"order_no": "Q000001", **YES}, "confirming", True),
    ]),
    ("수정 흐름 안에서 취소로 바꿔도 복귀 단계는 처음 단계", registered_db, [
        ("next_request", {"intent": "modify"}, "modify", True),
        ("next_request", {"intent": "cancel"}, "cancel", True),
        ("next_request", {"intent": "other"}, "collecting_registered", True),
    ]),
    ("상담원 전환: 거절하면 복귀, 동의하면 종료", FakeDB, [
        ("next_request", {"intent": "handoff"}, "handoff", True),
        ("next_request", {"intent": "other"}, "collecting_new", True),
        ("next_request", {"intent": "handoff"}, "handoff", True),
        ("transfer_to_agent", YES, "ending", True),
    ]),
    ("어느 단계에서든 고객 확인 후 종료", FakeDB, [
        ("record_order", {"sender_name": "김철수"}, "collecting_new", True),
        ("end_call", {"customer_confirmed": False}, "collecting_new", False),
        ("end_call", YES, "ending", True),
        ("get_state", {}, "ending", True),
    ]),
]


@pytest.mark.parametrize("name, make_db, steps", SCENARIOS, ids=[s[0] for s in SCENARIOS])
def test_scenario(name, make_db, steps):
    call = make_call(make_db())
    for i, (tool, args, stage, ok) in enumerate(steps):
        out = run(dispatch(call, tool, json.dumps(args, ensure_ascii=False), f"c{i}"))
        assert (out["ok"], call.flow.stage) == (ok, stage), f"{i}번째 {tool}: {out}"
        assert out["state"]["stage"] == stage


def test_definitions_valid_and_every_stage_reachable():
    reachable = {s.name for s in engine.STAGES.values() if s.start_if}
    for _ in range(len(engine.STAGES)):
        for s in engine.STAGES.values():
            for t in s.transitions:
                if s.name in reachable and t.target != engine.RETURN:
                    reachable.add(t.target)
            if s.enter_on and (engine.ANY in s.enter_from or reachable & set(s.enter_from)):
                reachable.add(s.name)
    assert reachable == set(engine.STAGES)


def test_validate_catches_missing_tool_and_text():
    bad = engine.Stage(name="bad", description="x", tools=("no_such_tool",))
    engine.STAGES["bad"] = bad
    try:
        with pytest.raises(engine.FlowError, match="no_such_tool"):
            engine.validate({"get_state"}, TEXTS, make_call().text_vars())
    finally:
        del engine.STAGES["bad"]


def test_progress_text_within_limit_with_longest_values():
    call = make_call()
    for f in FULL_ORDER:
        setattr(call.order, f, "가" * 120)
    call.flow.stage = "confirming"
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert len(text) <= CFG.progress.max_chars
    assert "되읽" in text  # 다음에 할 일은 잘리지 않는다


def test_progress_text_contains_next_question_and_values():
    call = make_call()
    call.order.sender_name = "김철수"
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert "김철수" in text and TEXTS.fields["sender_phone"] in text
