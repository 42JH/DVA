"""분기 로직을 LLM 없이 검증: spec/scenario.md의 시나리오마다 "보고 순서 → 단계 경로"를 데이터로 적는다.
보고는 두 종류: 백엔드 도구 호출(tool)과 서버의 고객 말 판별 결과(say). 분기를 추가하면 SCENARIOS에 한 건을 추가한다."""

import json

import pytest
from conftest import CALLER, CFG, FULL_ORDER, TEXTS, FakeBackend, make_call, run

from app.dispatcher import dispatch
from app.flow import engine
from app.listener import apply_answer, stage_choices
from app.order import Order, Place

SENDER = {k: v for k, v in FULL_ORDER.items() if k.startswith("sender")}
RECEIVER = {k: v for k, v in FULL_ORDER.items() if k.startswith("receiver")}
ITEM = {"item": "옷"}

ORIGIN = Place(name="김철수", phone=CALLER, address="서울 강남구 테헤란로 212", address_detail="1201호")
ORIGIN2 = Place(name="김철수", phone=CALLER, address="경기 성남시 판교로 1", address_detail="")
DEST = Place(name="이영희", phone="01098765432", address="부산 해운대구 센텀로 10", address_detail="")
DEST2 = Place(name="이영희", phone="01098765432", address="서울 마포구 월드컵로 5", address_detail="301호")


def new_db():
    return FakeBackend()


def saved_db(origins=(ORIGIN,), dests=(DEST, DEST2)):
    """저장된 배송지만 있는 등록 고객(최근 배송 없음)."""
    db = FakeBackend()
    db.places[CALLER] = [("origin", p) for p in origins] + [("destination", p) for p in dests]
    return db


def recent_db():
    """최근 배송이 있고 그 배송지가 저장돼 있는 등록 고객."""
    db = saved_db(dests=(DEST,))
    order = Order(**{**FULL_ORDER, "sender_phone": CALLER, "receiver_phone": DEST.phone, "receiver_name": DEST.name,
                     "receiver_address": DEST.address, "receiver_address_detail": DEST.address_detail,
                     "sender_address": ORIGIN.address, "sender_address_detail": ORIGIN.address_detail})
    run(db.create_order(CALLER, "old", order, 4950, None))
    return db


def tool(name, args, stage):
    return ("tool", name, args, stage)


def say(answer, stage, intent="none"):
    return ("say", answer, intent, stage)


# (이름, DB 준비, [보고], 기대 단계 경로)
SCENARIOS = [
    ("신규 접수, 저장 동의", new_db, [
        tool("record_order", SENDER, "collecting"),
        tool("record_order", RECEIVER | ITEM, "confirming"),
        say("confirm", "save_offer"),
        say("yes", "after_order"),
        say("no_more", "ending"),
    ], ["collecting", "address", "collecting", "address", "collecting", "confirming", "submitted", "save_offer",
        "after_order", "ending"]),
    ("신규 접수, 저장 거절", new_db, [
        tool("record_order", FULL_ORDER, "confirming"),
        say("confirm", "save_offer"),
        say("no", "after_order"),
        say("none", "ending", intent="end"),
    ], ["collecting", "address", "collecting", "confirming", "submitted", "save_offer", "after_order", "ending"]),
    ("등록, 최근 배송 그대로", recent_db, [
        say("yes", "collecting"),
        tool("record_order", ITEM, "confirming"),
        say("confirm", "after_order"),
        say("no_more", "ending"),
    ], ["recent_offer", "collecting", "confirming", "submitted", "after_order", "ending"]),
    ("등록, 저장된 배송지로", saved_db, [
        say("dest_1", "find_origin"),
        say("origin_1", "collecting"),
        tool("record_order", ITEM, "confirming"),
        say("confirm", "after_order"),
        say("no_more", "ending"),
    ], ["find_destination", "collecting", "find_origin", "collecting", "confirming", "submitted", "after_order",
        "ending"]),
    ("등록, 받는 곳 못 찾음(두 번)", saved_db, [
        say("not_found", "find_destination"),
        say("not_found", "collecting"),
        tool("record_order", {**RECEIVER, "receiver_name": "박민수"}, "find_origin"),
        say("origin_1", "collecting"),
        tool("record_order", ITEM, "confirming"),
        say("confirm", "save_offer"),
    ], ["find_destination", "collecting", "address", "collecting", "find_origin", "collecting", "confirming",
        "submitted", "save_offer"]),
    ("등록, 출발지만 바뀜", saved_db, [
        say("dest_1", "find_origin"),
        say("different", "collecting"),
        tool("record_order", {**SENDER, "sender_address": "인천 연수구 송도동 1"} | ITEM, "confirming"),
        say("confirm", "save_offer"),
    ], ["find_destination", "collecting", "find_origin", "collecting", "address", "collecting", "confirming",
        "submitted", "save_offer"]),
    ("마지막 확인에서 정정", new_db, [
        tool("record_order", FULL_ORDER, "confirming"),
        say("correct", "confirming"),
        tool("record_order", {"item": "서류"}, "confirming"),
        say("confirm", "save_offer"),
    ], ["collecting", "address", "collecting", "confirming", "submitted", "save_offer"]),
    ("정정하다 빠진 항목이 생김(주소만 바꿈)", new_db, [
        tool("record_order", FULL_ORDER, "confirming"),
        tool("record_order", {"receiver_address": "대구 중구 동성로 1"}, "collecting"),
        tool("record_order", {"receiver_address_detail": "2층"}, "confirming"),
    ], ["collecting", "address", "collecting", "confirming", "address", "confirming", "collecting", "confirming"]),
    ("추가 주문(신규, 저장 거절)", new_db, [
        tool("record_order", FULL_ORDER, "confirming"),
        say("confirm", "save_offer"),
        say("no", "after_order"),
        say("more", "collecting"),
        tool("record_order", FULL_ORDER | {"item": "책"}, "confirming"),
        say("confirm", "save_offer"),
        say("no", "after_order"),
        say("no_more", "ending"),
    ], ["collecting", "address", "collecting", "confirming", "submitted", "save_offer", "after_order", "collecting",
        "address", "collecting", "confirming", "submitted", "save_offer", "after_order", "ending"]),
    ("추가 주문(저장 동의로 등록 고객이 됨 → 최근 배송부터)", new_db, [
        tool("record_order", FULL_ORDER, "confirming"),
        say("confirm", "save_offer"),
        say("yes", "after_order"),
        say("more", "recent_offer"),
        say("yes", "collecting"),
        tool("record_order", {"item": "책"}, "confirming"),
        say("confirm", "after_order"),
    ], ["collecting", "address", "collecting", "confirming", "submitted", "save_offer", "after_order",
        "recent_offer", "collecting", "confirming", "submitted", "after_order"]),
    ("접수 중 취소 요청", recent_db, [
        say("no", "find_destination"),
        say("new", "collecting"),
        say("none", "cancel", intent="cancel"),
        tool("cancel_order", {"order_no": "Q000001", "customer_confirmed": True}, "collecting"),
    ], ["recent_offer", "find_destination", "collecting", "cancel", "collecting"]),
    ("상담원 연결: 아니오면 복귀, 예면 종료", new_db, [
        say("none", "handoff", intent="handoff"),
        say("no", "collecting"),
        tool("record_order", FULL_ORDER, "confirming"),
        say("none", "handoff", intent="handoff"),
        say("yes", "ending"),
    ], ["collecting", "handoff", "collecting", "address", "collecting", "confirming", "handoff", "ending"]),
]


def report(call, step, i=0):
    kind, a, b, _ = step
    if kind == "tool":
        out = run(dispatch(call, a, json.dumps(b, ensure_ascii=False), f"c{i}"))
        assert out["ok"], out
        return out
    assert a in stage_choices(call), f"{call.flow.stage}에 없는 답 {a}"
    return run(apply_answer(call, a, b))


@pytest.mark.parametrize("name, make_db, steps, expected_path", SCENARIOS, ids=[s[0] for s in SCENARIOS])
def test_scenario(name, make_db, steps, expected_path):
    call = make_call(make_db())
    first = call.flow.history[0]["from"] if call.flow.history else call.flow.stage
    for i, step in enumerate(steps):
        report(call, step, i)
        assert call.flow.stage == step[3], f"{i}번째 {step}"
    assert [first] + [h["to"] for h in call.flow.history] == expected_path


# --- 시작 ---

@pytest.mark.parametrize("make_db, caller, stage", [
    (new_db, CALLER, "collecting"),
    (new_db, None, "collecting"),
    (recent_db, CALLER, "recent_offer"),
    (saved_db, CALLER, "find_destination"),
    (lambda: saved_db(dests=()), CALLER, "collecting"),  # 저장된 받는 곳이 없으면 찾을 것이 없다
])
def test_start_stage(make_db, caller, stage):
    assert make_call(make_db(), caller=caller).flow.stage == stage


def test_registered_order_asks_destination_first():
    call = make_call(saved_db(dests=()))
    assert engine.missing(call)[:4] == ["receiver_address", "receiver_address_detail", "receiver_name", "receiver_phone"]
    assert engine.missing(make_call(new_db()))[0] == "sender_name"


# --- 판별 결과별 분기 ---

def test_find_destination_choices_and_variants():
    call = make_call(saved_db())
    choices = stage_choices(call)
    assert "이영희, 부산 해운대구 센텀로 10" in choices["dest_1"] and "dest_3" not in choices
    run(apply_answer(call, "name_only", "none"))
    assert engine.next_text(call) == TEXTS.stages["find_destination.need_region"]
    run(apply_answer(call, "ambiguous", "none"))
    assert engine.next_text(call) == TEXTS.stages["find_destination.need_detail"]
    run(apply_answer(call, "not_found", "none"))
    assert engine.next_text(call) == TEXTS.stages["find_destination.need_more"]
    run(apply_answer(call, "dest_2", "none"))
    assert call.order.receiver_address_detail == "301호" and call.flow.stage == "find_origin"


def test_find_destination_lists_only_callers_places():
    db = saved_db()
    db.places["01099999999"] = [("destination", Place(name="남", phone="0212345678", address="남의 집", address_detail=""))]
    assert all("남의 집" not in v for v in stage_choices(make_call(db)).values())


def test_find_origin_one_vs_many():
    call = make_call(saved_db())
    run(apply_answer(call, "dest_1", "none"))
    assert set(stage_choices(call)) == {"origin_1", "different", "none"}
    call = make_call(saved_db(origins=(ORIGIN, ORIGIN2)))
    run(apply_answer(call, "dest_1", "none"))
    assert {"origin_1", "origin_2", "same", "different"} <= set(stage_choices(call))
    run(apply_answer(call, "same", "none"))
    assert call.flow.stage == "find_origin" and "어디일까요" in engine.next_text(call)
    run(apply_answer(call, "origin_2", "none"))
    assert call.flow.stage == "collecting" and call.order.sender_address == ORIGIN2.address


def test_find_origin_asked_once_per_order():
    call = make_call(saved_db())
    run(apply_answer(call, "dest_1", "none"))
    run(apply_answer(call, "different", "none"))
    run(dispatch(call, "record_order", json.dumps({"sender_name": "김철수"}, ensure_ascii=False), "c"))
    assert call.flow.stage == "collecting"


def test_confirm_only_when_complete_and_submits_exact_draft():
    db = new_db()
    call = make_call(db)
    run(dispatch(call, "record_order", json.dumps(FULL_ORDER, ensure_ascii=False), "c"))
    call.order.item = None
    call.flow.stage = "confirming"
    assert run(apply_answer(call, "confirm", "none")) == [] and not db.orders  # 빠진 항목이 있으면 접수 안 함
    call.order.item = "옷"
    run(apply_answer(call, "confirm", "none"))
    assert db.orders[0]["sender_phone"] == "01012345678" and db.orders[0]["receiver_address_detail"] == ""
    assert call.order.model_dump() == {k: None for k in call.order.model_dump()}  # 중복 접수 방지
    assert run(apply_answer(call, "confirm", "none")) == [] and len(db.orders) == 1  # 다음 단계엔 confirm 없음


def test_save_offer_saves_by_kind_to_caller():
    db = new_db()
    call = make_call(db)
    run(dispatch(call, "record_order", json.dumps(FULL_ORDER, ensure_ascii=False), "c"))
    run(apply_answer(call, "confirm", "none"))
    run(apply_answer(call, "yes", "none"))
    assert call.customer_type == "registered"
    assert (db.places_of(CALLER, "origin"))[0].address == FULL_ORDER["sender_address"]
    assert (db.places_of(CALLER, "destination"))[0].name == "이영희"


def test_no_save_offer_without_caller():
    call = make_call(caller=None)
    run(dispatch(call, "record_order", json.dumps(FULL_ORDER, ensure_ascii=False), "c"))
    run(apply_answer(call, "confirm", "none"))
    assert call.flow.stage == "after_order"


def test_answer_then_intent_in_one_utterance():
    call = make_call(new_db())
    run(dispatch(call, "record_order", json.dumps(FULL_ORDER, ensure_ascii=False), "c"))
    run(apply_answer(call, "confirm", "new_order"))  # "네 맞아요, 하나 더 보낼게요"(저장 제안 중이라 새 주문은 무시)
    assert call.flow.stage == "save_offer"
    run(apply_answer(call, "no", "new_order"))  # "저장은 됐고 하나 더요"
    assert call.flow.stage == "collecting"


def test_end_requests_hangup_and_ending_ignores_further_answers():
    call = make_call(new_db())
    run(apply_answer(call, "none", "end"))
    assert call.hangup_requested.is_set() and call.flow.stage == "ending"
    assert run(apply_answer(call, "none", "handoff")) == [] and call.flow.stage == "ending"


def test_handoff_yes_requests_refer():
    call = make_call(new_db())
    run(apply_answer(call, "none", "handoff"))
    run(apply_answer(call, "yes", "none"))
    assert call.refer_requested.is_set() and call.flow.stage == "ending"


# --- 하위 흐름 ---

def test_subflow_from_any_stage_and_new_order_replays_after_return():
    call = make_call(new_db())
    run(dispatch(call, "record_order", json.dumps(FULL_ORDER, ensure_ascii=False), "c"))
    run(apply_answer(call, "confirm", "none"))
    assert call.flow.stage == "save_offer"
    run(apply_answer(call, "none", "lookup"))
    assert call.flow.stage == "lookup"
    run(dispatch(call, "lookup_orders", "{}", "c2"))
    assert call.flow.stage == "save_offer"  # 조회 안내 후 복귀
    run(apply_answer(call, "no", "none"))
    run(apply_answer(call, "none", "modify"))
    run(apply_answer(call, "none", "new_order"))
    assert call.flow.stage == "collecting"  # after_order로 돌아가 새 주문까지


def test_lookup_none():
    call = make_call(new_db())
    run(apply_answer(call, "none", "lookup"))
    out = run(dispatch(call, "lookup_orders", "{}", "c"))
    assert out["none"] is True and call.flow.stage == "collecting"


def test_modify_and_cancel_results():
    call = make_call(recent_db())
    run(apply_answer(call, "none", "modify"))
    args = {k: None for k in FULL_ORDER} | {"item": "책", "customer_confirmed": True}

    def tool_out(name, a):
        return run(dispatch(call, name, json.dumps(a, ensure_ascii=False), "c"))

    out = tool_out("modify_order", args | {"order_no": "Q999999"})
    assert out["ok"] is False and "접수번호" in out["retry"] and call.flow.stage == "modify"
    out = tool_out("modify_order", args | {"order_no": "q000001"})
    assert out["ok"] and out["fare"] is None and call.flow.stage == "recent_offer"
    run(apply_answer(call, "none", "cancel"))
    assert tool_out("cancel_order", {"order_no": "Q000001", "customer_confirmed": True})["ok"]
    run(apply_answer(call, "none", "cancel"))
    out = tool_out("cancel_order", {"order_no": "Q000001", "customer_confirmed": True})
    assert out["ok"] is False and out["error"] == "이미 취소된 주문"
    run(apply_answer(call, "none", "stop"))
    run(apply_answer(call, "none", "modify"))
    out = tool_out("modify_order", args | {"order_no": "Q000001"})
    assert out["ok"] is False and "취소된 주문" in out["error"]


# --- 정의 ---

def test_definitions_valid_and_every_stage_reachable():
    reachable = {s.name for s in engine.STAGES.values() if s.start_if}
    for _ in range(len(engine.STAGES)):
        for s in engine.STAGES.values():
            for t in s.transitions:
                if s.name in reachable and t.target != engine.RETURN:
                    reachable.add(t.target)
            if s.enter_on and (engine.ANY in s.enter_from or reachable & set(s.enter_from)):
                reachable.add(s.name)
    # 답 처리(on_answer)가 내는 사건도 전이로 이어진다(예: after_order "more" → intent.new_order)
    assert reachable == set(engine.STAGES)


def test_graph_draws_every_transition():
    """흐름도(get_graph)는 코드에서 만든다. 전이·어디서나 들어오는 하위 흐름·복귀가 모두 엣지로 그려져야 한다."""
    edges = {(e.source, e.target) for e in engine.GRAPH.get_graph().edges}
    for s in engine.STAGES.values():
        assert {(s.name, t.target) for t in s.transitions if t.target != engine.RETURN} <= edges
    assert {("collecting", "cancel"), ("cancel", "collecting"), ("save_offer", "ending")} <= edges


@pytest.mark.parametrize("moves", [engine.MAX_HOPS - 1, engine.MAX_HOPS])
def test_transition_chain_limit(moves):
    """사건 하나로 MAX_HOPS번 옮겨 가면 정의 오류(전이가 끝나지 않는 정의를 막는다)."""
    names = [f"chain_{i}" for i in range(moves + 1)]
    call = make_call()
    engine.STAGES.update({n: engine.Stage(
        name=n, description=n, tools=(),
        transitions=(engine.Transition("go" if i == 0 else engine.ENTERED, names[i + 1]),) if i < moves else (),
    ) for i, n in enumerate(names)})
    try:
        engine.build()
        call.flow.stage = names[0]
        if moves < engine.MAX_HOPS:
            run(engine.apply(call, ["go"]))
            assert call.flow.stage == names[-1]
        else:
            with pytest.raises(engine.FlowError, match="끝나지 않음"):
                run(engine.apply(call, ["go"]))
    finally:
        for n in names:
            del engine.STAGES[n]
        engine.build()


def test_only_ending_and_address_do_not_listen():
    """ending은 마무리 인사 중, address는 머무르지 않는 단계(주소 확정 후 바로 돌아감)."""
    assert sorted(s.name for s in engine.STAGES.values() if not s.listen) == ["address", "ending"]


def test_validate_catches_missing_tool_and_text():
    engine.STAGES["bad"] = engine.Stage(name="bad", description="x", tools=("no_such_tool",), variants=("nope",))
    try:
        with pytest.raises(engine.FlowError, match="no_such_tool") as e:
            engine.validate({"get_state"}, TEXTS, make_call().text_vars())
        assert "bad.nope" in str(e.value)
    finally:
        del engine.STAGES["bad"]


def test_progress_text_within_limit_with_longest_values():
    call = make_call()
    for f in FULL_ORDER:
        setattr(call.order, f, "가" * 120)
    call.flow.stage = "confirming"
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert len(text) <= CFG.progress.max_chars
    assert "이대로 접수" in text  # 다음에 할 일은 잘리지 않는다


def test_progress_text_contains_next_question_and_values():
    call = make_call()
    call.order.sender_name = "김철수"
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert "김철수" in text and TEXTS.fields["sender_phone"] in text


def test_unhandled_request_offers_handoff_and_decline_returns():
    """처리할 수 없는 요청(help) → 상담원 연결을 먼저 제안. 아니요면 하던 단계로, 예면 연결 안내."""
    call = make_call(new_db())
    run(apply_answer(call, "none", "help"))
    assert call.flow.stage == "handoff" and "안내드리기 어려운" in engine.next_text(call)
    run(apply_answer(call, "no", "none"))
    assert call.flow.stage == "collecting"
    run(apply_answer(call, "none", "handoff"))  # 고객이 직접 요청하면 제안 문구가 아니라 확인 문구
    assert "안내드리기 어려운" not in engine.next_text(call)
    run(apply_answer(call, "yes", "none"))
    assert call.refer_requested.is_set() and "잠시만 기다려" in engine.next_text(call)


# --- 말하기: PoC 수준의 진행 안내 ---

def test_caller_number_yes_is_recorded_by_server():
    """"지금 전화하신 번호로 연락드리면 될까요?" → "네"는 서버가 판별해 발신번호로 기록(백엔드는 발신번호를 모른다)."""
    call = make_call(new_db())
    call.order.sender_name = "김철수"
    assert "use_caller" in stage_choices(call)
    run(apply_answer(call, "use_caller", "none"))
    assert call.order.sender_phone == CALLER
    assert ("보내는 분 번호", TEXTS.caller_value) in call.recorded()  # 발신번호는 읽지 않게 표시만
    assert "use_caller" not in stage_choices(call)  # 연락처 차례가 지나면 선택지도 없다


def test_saved_values_are_hidden_until_customer_says_them():
    call = make_call(recent_db())
    run(apply_answer(call, "yes", "none"))  # 최근 배송 그대로
    shown = dict(call.recorded())
    assert shown["받는 분 번호"] == TEXTS.saved_value and shown["받는 분"] == DEST.name
    run(dispatch(call, "record_order", json.dumps({"receiver_phone": "01011112222"}), "c"))
    assert dict(call.recorded())["받는 분 번호"] == "01011112222"  # 고객이 직접 불러 준 번호는 보인다


def test_progress_tells_the_item_after_next():
    call = make_call(new_db())
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert "성함" in text and "그다음" in text and "지금 전화하신 번호로" in text


def test_call_info_greets_registered_customer_by_name_with_first_question():
    call = make_call(recent_db())
    info = TEXTS.call_info.format(**call.text_vars(), first=engine.next_text(call))
    assert FULL_ORDER["sender_name"] in info and "지난번처럼" in info and DEST.name in info


def test_confirm_progress_fits_with_realistic_values():
    call = make_call(new_db())
    run(dispatch(call, "record_order", json.dumps(FULL_ORDER, ensure_ascii=False), "c"))
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert call.flow.stage == "confirming" and FULL_ORDER["receiver_address"] in text  # 값이 잘리지 않는다
