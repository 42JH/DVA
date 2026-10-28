"""분기 로직을 LLM 없이 검증: spec/scenario.md의 시나리오마다 "보고 순서 → 단계 경로"를 데이터로 적는다.
보고는 두 종류: 백엔드 도구 호출(tool)과 서버의 고객 말 판별 결과(say). 분기를 추가하면 SCENARIOS에 한 건을 추가한다."""

import json

import pytest
from conftest import CALLER, CFG, FULL_ORDER, GEO, INCOMING_AT, PICKUP_AT, TEXTS, FakeBackend, make_call, run

from app.address import kakao
from app.dispatcher import dispatch
from app.flow import engine
from app.listener import apply_answer, stage_choices
from app.order import Place

SENDER = {k: v for k, v in FULL_ORDER.items() if k.startswith("sender")}
RECEIVER = {k: v for k, v in FULL_ORDER.items() if k.startswith("receiver")}
ITEM = {"small_box_count": 1, "item_price": 30000}
WHEN = {"pickup_at": PICKUP_AT}

ORIGIN = Place(name="김철수", phone=CALLER, address="서울 강남구 테헤란로 212", address_detail="1201호", geo=GEO)
DEST = Place(name="이영희", phone="01098765432", address="부산 해운대구 센텀로 10", address_detail="", geo=GEO)
DEST2 = Place(name="이영희", phone="01098765432", address="서울 마포구 월드컵로 5", address_detail="301호", geo=GEO)


def new_db():
    return FakeBackend()


def saved_db(pins=(DEST, DEST2, ORIGIN), usage_types=("PERSONAL",)):
    """주소록이 있는 등록 고객. 주소록은 출발지·도착지 구분 없이 두 쪽 모두에 쓴다."""
    db = FakeBackend()
    db.add_customer(CALLER, "김철수", list(pins), usage_types=list(usage_types))
    return db


def withdrawn_db():
    db = FakeBackend()
    db.add_customer(CALLER, "김철수", status="WITHDRAWN")
    return db


def tool(name, args, stage):
    return ("tool", name, args, stage)


def say(answer, stage, intent="none"):
    return ("say", answer, intent, stage)


# (이름, DB 준비, [보고], 기대 단계 경로)
SCENARIOS = [
    ("신규 접수 한 건", new_db, [
        tool("record_order", SENDER, "collecting"),
        tool("record_order", RECEIVER | ITEM | WHEN, "collecting"),
        say("credit", "confirming"),
        say("confirm", "after_order"),
        say("no_more", "ending"),
    ], ["collecting", "address", "collecting", "address", "collecting", "confirming", "after_order", "ending"]),
    ("신규, 한 번에 말하고 끝냄", new_db, [
        tool("record_order", FULL_ORDER, "collecting"),
        say("credit", "confirming"),
        say("confirm", "after_order"),
        say("none", "ending", intent="end"),
    ], ["collecting", "address", "collecting", "confirming", "after_order", "ending"]),
    ("등록, 주소록으로", saved_db, [
        say("dest_1", "find_origin"),
        say("origin_3", "collecting"),
        tool("record_order", ITEM | WHEN, "collecting"),
        say("credit", "confirming"),
        say("confirm", "after_order"),
        say("no_more", "ending"),
    ], ["find_destination", "collecting", "find_origin", "collecting", "confirming", "after_order", "ending"]),
    ("등록, 받는 곳 못 찾음(두 번)", saved_db, [
        say("not_found", "find_destination"),
        say("not_found", "collecting"),
        tool("record_order", {**RECEIVER, "receiver_name": "박민수"}, "find_origin"),
        say("origin_3", "collecting"),
        tool("record_order", ITEM | WHEN, "collecting"),
        say("credit", "confirming"),
    ], ["find_destination", "collecting", "address", "collecting", "find_origin", "collecting", "confirming"]),
    ("등록, 출발지만 바뀜", saved_db, [
        say("dest_1", "find_origin"),
        say("different", "collecting"),
        tool("record_order", {**SENDER, "sender_address": "인천 연수구 송도동 1"} | ITEM | WHEN, "collecting"),
        say("credit", "confirming"),
    ], ["find_destination", "collecting", "find_origin", "collecting", "address", "collecting", "confirming"]),
    ("마지막 확인에서 정정", new_db, [
        tool("record_order", FULL_ORDER, "collecting"),
        say("credit", "confirming"),
        say("correct", "confirming"),
        tool("record_order", {"small_box_count": 2}, "confirming"),
        say("confirm", "after_order"),
    ], ["collecting", "address", "collecting", "confirming", "after_order"]),
    ("정정하다 빠진 항목이 생김(주소만 바꿈)", new_db, [
        tool("record_order", FULL_ORDER, "collecting"),
        say("credit", "confirming"),
        tool("record_order", {"receiver_address": "대구 중구 동성로 1"}, "collecting"),
        tool("record_order", {"receiver_address_detail": "2층"}, "confirming"),
    ], ["collecting", "address", "collecting", "confirming", "address", "confirming", "collecting", "confirming"]),
    ("택배 추가(신규): 공통값은 다시 묻지 않음", new_db, [
        tool("record_order", FULL_ORDER, "collecting"),
        say("credit", "confirming"),
        say("confirm", "after_order"),
        say("more", "collecting"),
        tool("record_order", {k: v for k, v in FULL_ORDER.items() if k != "pickup_at"}, "confirming"),
        say("confirm", "after_order"),
        say("no_more", "ending"),
    ], ["collecting", "address", "collecting", "confirming", "after_order", "collecting", "address", "collecting",
        "confirming", "after_order", "ending"]),
    ("택배 추가(등록): 이번에도 같은 곳부터", saved_db, [
        say("dest_1", "find_origin"),
        say("origin_3", "collecting"),
        tool("record_order", ITEM | WHEN, "collecting"),
        say("credit", "confirming"),
        say("confirm", "after_order"),
        say("more", "recent_offer"),
        say("yes", "collecting"),
        tool("record_order", ITEM, "confirming"),
        say("confirm", "after_order"),
    ], ["find_destination", "collecting", "find_origin", "collecting", "confirming", "after_order", "recent_offer",
        "collecting", "confirming", "after_order"]),
    ("조회·수정·취소 요청은 보류: 상담원 연결 제안", new_db, [
        say("none", "handoff", intent="lookup"),
        say("no", "collecting"),
        say("none", "handoff", intent="cancel"),
        say("no", "collecting"),
    ], ["collecting", "handoff", "collecting", "handoff", "collecting"]),
    ("상담원 연결: 아니오면 복귀, 예면 종료", new_db, [
        say("none", "handoff", intent="handoff"),
        say("no", "collecting"),
        tool("record_order", FULL_ORDER, "collecting"),
        say("credit", "confirming"),
        say("none", "handoff", intent="handoff"),
        say("yes", "ending"),
    ], ["collecting", "handoff", "collecting", "address", "collecting", "confirming", "handoff", "ending"]),
    ("접수 그만둠", new_db, [
        tool("record_order", SENDER, "collecting"),
        say("none", "ending", intent="quit"),
    ], ["collecting", "address", "collecting", "ending"]),
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


def play(db, steps):
    call = make_call(db)
    for i, step in enumerate(steps):
        report(call, step, i)
    return call


# --- 시작 ---

@pytest.mark.parametrize("make_db, caller, stage", [
    (new_db, CALLER, "collecting"),
    (new_db, None, "collecting"),
    (saved_db, CALLER, "find_destination"),
    (lambda: saved_db(pins=()), CALLER, "collecting"),  # 주소록이 없으면 찾을 것이 없다
    (withdrawn_db, CALLER, "ending"),
])
def test_start_stage(make_db, caller, stage):
    assert make_call(make_db(), caller=caller).flow.stage == stage


def test_withdrawn_customer_is_handed_to_agent_not_treated_as_new():
    call = make_call(withdrawn_db())
    assert call.customer_type == "withdrawn" and call.refer_requested.is_set()
    assert "상담원" in engine.next_text(call)


def test_registered_order_asks_destination_first():
    call = make_call(saved_db(pins=()))
    assert engine.missing(call)[:4] == ["receiver_address", "receiver_address_detail", "receiver_name", "receiver_phone"]
    assert engine.missing(make_call(new_db()))[0] == "sender_name"


def test_registered_customer_uses_backend_name_and_seq():
    call = make_call(saved_db())
    assert call.customer_seq is not None and call.display_name() == "김철수"
    assert "customer_name" not in call.call_fields_due()  # 등록 고객은 성함을 묻지 않는다


# --- 판별 결과별 분기 ---

def test_find_destination_choices_and_variants():
    call = make_call(saved_db())
    choices = stage_choices(call)
    assert "이영희, 부산 해운대구 센텀로 10" in choices["dest_1"] and "dest_3" in choices and "dest_4" not in choices
    run(apply_answer(call, "name_only", "none"))
    assert engine.next_text(call) == TEXTS.stages["find_destination.need_region"]
    run(apply_answer(call, "ambiguous", "none"))
    assert engine.next_text(call) == TEXTS.stages["find_destination.need_detail"]
    run(apply_answer(call, "not_found", "none"))
    assert engine.next_text(call) == TEXTS.stages["find_destination.need_more"]
    run(apply_answer(call, "dest_2", "none"))
    assert call.order.receiver_address_detail == "301호" and call.order.receiver_geo == GEO
    assert call.flow.stage == "find_origin"


def test_find_destination_lists_only_callers_pins():
    db = saved_db()
    db.add_customer("01099999999", "남", [Place(name="남", phone="0212345678", address="남의 집", address_detail="")])
    assert all("남의 집" not in v for v in stage_choices(make_call(db)).values())


def test_find_origin_one_vs_many():
    call = make_call(saved_db(pins=(ORIGIN,)))
    run(apply_answer(call, "dest_1", "none"))
    run(dispatch(call, "record_order", json.dumps(RECEIVER, ensure_ascii=False), "c"))  # 받는 곳은 새로
    assert set(stage_choices(call)) == {"origin_1", "different", "none"}
    call = make_call(saved_db())
    run(apply_answer(call, "dest_1", "none"))
    assert {"origin_1", "origin_2", "origin_3", "same", "different"} <= set(stage_choices(call))
    run(apply_answer(call, "same", "none"))
    assert call.flow.stage == "find_origin" and "어디일까요" in engine.next_text(call)
    run(apply_answer(call, "origin_3", "none"))
    assert call.flow.stage == "collecting" and call.order.sender_address == ORIGIN.address


def test_find_origin_asked_once_per_order():
    call = make_call(saved_db())
    run(apply_answer(call, "dest_1", "none"))
    run(apply_answer(call, "different", "none"))
    run(dispatch(call, "record_order", json.dumps({"sender_name": "김철수"}, ensure_ascii=False), "c"))
    assert call.flow.stage == "collecting"


def test_confirm_only_when_complete_and_keeps_exact_draft():
    db = new_db()
    call = make_call(db)
    run(dispatch(call, "record_order", json.dumps(FULL_ORDER, ensure_ascii=False), "c"))
    run(apply_answer(call, "credit", "none"))
    call.order.item_price = None
    call.flow.stage = "confirming"
    assert run(apply_answer(call, "confirm", "none")) == [] and not call.parcels  # 빠진 항목이 있으면 담지 않음
    call.order.item_price = 30000
    draft = call.order.model_copy()
    run(apply_answer(call, "confirm", "none"))
    assert call.parcels == [draft] and draft.sender_phone == CALLER and draft.receiver_address_detail == ""
    assert call.order.empty()  # 같은 택배를 두 번 담지 않는다
    assert run(apply_answer(call, "confirm", "none")) == [] and len(call.parcels) == 1  # 다음 단계엔 confirm 없음
    assert not db.results  # 담기만 하고 접수는 통화 끝에 한 번


# --- 통화 항목: 성함·수거 시각·결제 방식 ---

def test_customer_name_from_sender_when_sender_phone_is_caller():
    call = make_call(new_db())
    run(dispatch(call, "record_order", json.dumps(FULL_ORDER, ensure_ascii=False), "c"))
    assert call.customer_name == "김철수" and engine.missing(call) == ["payment_method"]


def test_customer_name_asked_when_sender_phone_differs():
    call = make_call(new_db())
    run(dispatch(call, "record_order", json.dumps({**FULL_ORDER, "sender_phone": "01022223333"}), "c"))
    assert engine.missing(call)[0] == "customer_name" and "성함" in engine.next_text(call)
    run(dispatch(call, "record_order", json.dumps({"customer_name": "박영수"}, ensure_ascii=False), "c2"))
    assert call.customer_name == "박영수" and engine.missing(call) == ["payment_method"]


def test_pickup_time_must_be_future_with_timezone():
    call = make_call(new_db())
    for bad in ("2020-01-01T10:00:00+09:00", "2099-01-01T10:00:00", "내일 오전"):
        out = run(dispatch(call, "record_order", json.dumps({"pickup_at": bad}, ensure_ascii=False), "c"))
        assert out["ok"] is False and "수거" in out["retry"] and call.pickup_at is None
    run(dispatch(call, "record_order", json.dumps({"pickup_at": "2099-01-01T01:00:00Z"}), "c"))
    assert call.pickup_at == "2099-01-01T10:00:00+09:00"  # 한국 시간으로


@pytest.mark.parametrize("make_db, options", [
    (new_db, {"credit", "billing"}),
    (lambda: saved_db(usage_types=("PERSONAL",)), {"credit", "billing"}),
    (lambda: saved_db(usage_types=("PERSONAL", "COMPANY")), {"credit", "groupBilling", "billing"}),
    (lambda: saved_db(usage_types=("COMPANY",)), {"credit", "groupBilling"}),
])
def test_payment_choices_by_customer(make_db, options):
    call = make_call(make_db())
    assert set(call.payment_options()) == options
    call.order = call.order.model_copy(update={k: v for k, v in FULL_ORDER.items() if k != "pickup_at"} | {
        "sender_phone": CALLER, "receiver_phone": "01098765432"})
    call.pickup_at, call.customer_name, call.flow.stage = PICKUP_AT, "김철수", "collecting"
    assert set(stage_choices(call)) == options | {"none"}


# --- 통화 결과(백엔드 POST /api/orders, 통화당 한 번) ---

NEW_ONE = [tool("record_order", FULL_ORDER, "collecting"), say("credit", "confirming"), say("confirm", "after_order")]


def test_no_more_submits_all_confirmed_parcels_once_as_complete():
    db = new_db()
    call = play(db, NEW_ONE + [say("more", "collecting"),
                               tool("record_order", {**FULL_ORDER, "small_box_count": 2}, "confirming"),
                               say("confirm", "after_order"), say("no_more", "ending")])
    assert len(db.results) == 1 and call.hangup_requested.is_set()
    body = db.results[0]["body"]
    assert body["outcome"] == "COMPLETE" and db.results[0]["key"] == call.result_key
    assert body["call"] == {"providerCallId": "live_test", "callerPhoneNumber": CALLER, "incomingAt": INCOMING_AT}
    assert body["customer"] == {"name": "김철수", "phoneNumber": CALLER} and "customerSeq" not in body
    assert body["paymentMethodType"] == "credit" and body["pickupRequestedAt"] == PICKUP_AT
    assert [p["smallBoxCount"] for p in body["parcels"]] == [1, 2]
    assert body["parcels"][0]["origin"] == {
        "name": "김철수", "phoneNumber": CALLER, "roadAddress": FULL_ORDER["sender_address"], "detailAddress": "1201호",
        "jibunAddress": GEO.jibun_address, "dongName": "역삼동", "postalCode": "06236", "latitude": 37.5,
        "longitude": 127.03}
    assert body["parcels"][0]["itemPrice"] == 30000
    text = engine.next_text(call)
    assert "TEST0001" in text and "2건" in text  # ACCEPTED만 접수 완료 안내
    run(call.finish())
    assert len(db.results) == 1  # 통화가 끝나도 다시 보내지 않는다


def test_registered_customer_sent_by_seq():
    db = saved_db()
    call = play(db, [say("dest_1", "find_origin"), say("origin_3", "collecting"),
                     tool("record_order", ITEM | WHEN, "collecting"), say("credit", "confirming"),
                     say("confirm", "after_order"), say("no_more", "ending")])
    body = db.results[0]["body"]
    assert body["customerSeq"] == call.customer_seq and "customer" not in body
    assert body["parcels"][0]["destination"]["roadAddress"] == DEST.address  # 주소록 값 그대로(좌표 포함)


def test_not_accepted_is_never_announced_as_success():
    db = new_db()
    db.dver_status = "REVIEW_REQUIRED"
    call = play(db, NEW_ONE + [say("no_more", "ending")])
    assert db.results[0]["status"] == "REVIEW_REQUIRED"
    assert engine.next_text(call).startswith(TEXTS.stages["ending.pending"][:10]) and "완료" not in engine.next_text(call)


def test_missing_geo_is_not_filled_and_sent_as_incomplete(monkeypatch):
    async def not_found(address_, timeout_sec, transport=None):
        return None

    monkeypatch.setattr(kakao, "geocode", not_found)
    db = new_db()
    call = play(db, NEW_ONE + [say("no_more", "ending")])
    body = db.results[0]["body"]
    assert body["outcome"] == "INCOMPLETE" and "jibunAddress" not in body["parcels"][0]["origin"]
    assert call.stage_variant("ending") == "pending"


@pytest.mark.parametrize("steps, outcome, parcels", [
    (NEW_ONE, "COMPLETE", 1),  # 확인한 택배가 있는데 끊김 → 확인한 것만 접수
    (NEW_ONE + [say("more", "collecting"), tool("record_order", SENDER, "collecting")], "COMPLETE", 1),
    ([tool("record_order", SENDER, "collecting")], "INCOMPLETE", 1),  # 받는 중이던 것만
    ([], "INCOMPLETE", 0),
    (NEW_ONE + [say("none", "handoff", intent="handoff"), say("yes", "ending")], "INCOMPLETE", 1),  # 상담원: 접수 안 함
    ([tool("record_order", SENDER, "collecting"), say("none", "handoff", intent="handoff"), say("yes", "ending")],
     "INCOMPLETE", 1),
    ([tool("record_order", SENDER, "collecting"), say("none", "ending", intent="quit")], "CANCELLED", None),
])
def test_call_end_sends_one_result(steps, outcome, parcels):
    db = new_db()
    call = play(db, steps)
    run(call.finish())
    body = db.results[0]["body"]
    assert len(db.results) == 1 and body["outcome"] == outcome
    if parcels is not None:
        assert len(body.get("parcels", [])) == parcels
    if outcome != "COMPLETE":
        assert "paymentMethodType" not in body or body["paymentMethodType"] == "credit"


def test_incomplete_with_confirmed_and_partial_parcels_on_handoff():
    db = new_db()
    call = play(db, NEW_ONE + [say("more", "collecting"), tool("record_order", {"receiver_name": "박민수"}, "collecting"),
                               say("none", "handoff", intent="handoff"), say("yes", "ending")])
    run(call.finish())
    parcels = db.results[0]["body"]["parcels"]
    assert len(parcels) == 2 and parcels[1] == {"destination": {"name": "박민수"}}


def test_no_result_without_caller_or_incoming_time():
    db = new_db()
    call = make_call(db, caller=None)
    run(call.finish())
    assert not db.results and call.errors


def test_withdrawn_call_end_sends_incomplete_without_customer():
    db = withdrawn_db()
    call = make_call(db)
    run(call.finish())
    body = db.results[0]["body"]
    assert body["outcome"] == "INCOMPLETE" and "customer" not in body and "customerSeq" not in body


def test_answer_then_intent_in_one_utterance():
    call = make_call(new_db())
    run(dispatch(call, "record_order", json.dumps(FULL_ORDER, ensure_ascii=False), "c"))
    run(apply_answer(call, "credit", "none"))
    run(apply_answer(call, "confirm", "new_order"))  # "네 맞아요, 하나 더 보낼게요"
    assert call.flow.stage == "collecting" and len(call.parcels) == 1


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


def test_held_stages_are_not_loaded():
    """조회·수정·취소는 보류: 정의는 남기고 흐름에는 넣지 않는다(도구는 등록돼 있다)."""
    from app.flow.stages import subflows
    from app.tools._base import TOOLS

    assert {s.name for s in subflows.HELD} == {"lookup", "modify", "cancel"}
    assert not {"lookup", "modify", "cancel"} & set(engine.STAGES)
    assert {"lookup_orders", "modify_order", "cancel_order"} <= set(TOOLS)
    assert all(not {"lookup_orders", "modify_order", "cancel_order"} & set(s.tools) for s in engine.STAGES.values())


def test_graph_draws_every_transition():
    """흐름도(get_graph)는 코드에서 만든다. 전이·어디서나 들어오는 하위 흐름·복귀가 모두 엣지로 그려져야 한다."""
    edges = {(e.source, e.target) for e in engine.GRAPH.get_graph().edges}
    for s in engine.STAGES.values():
        assert {(s.name, t.target) for t in s.transitions if t.target != engine.RETURN} <= edges
    assert {("collecting", "handoff"), ("handoff", "collecting"), ("after_order", "ending")} <= edges


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
    for f in ("sender_name", "sender_phone", "sender_address", "sender_address_detail", "receiver_name",
              "receiver_phone", "receiver_address", "receiver_address_detail", "other_item"):
        setattr(call.order, f, "가" * 120)
    call.order.item_price, call.pickup_at, call.payment_method = 30000, PICKUP_AT, "credit"
    call.customer_name = "가" * 30
    call.flow.stage = "confirming"
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert len(text) <= CFG.progress.max_chars
    assert "이대로 접수" in text  # 다음에 할 일은 잘리지 않는다


def test_progress_text_contains_next_question_and_values():
    call = make_call()
    call.order.sender_name = "김철수"
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert "김철수" in text and TEXTS.fields["sender_phone"] in text


def test_pickup_question_tells_current_time():
    call = make_call()
    call.order = call.order.model_copy(update={k: v for k, v in FULL_ORDER.items() if k != "pickup_at"} | {
        "sender_phone": CALLER, "receiver_phone": "01098765432"})
    assert engine.missing(call)[0] == "pickup_at" and call.text_vars()["now"] in engine.next_text(call)


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
    call = make_call(saved_db())
    run(apply_answer(call, "dest_1", "none"))  # 주소록의 받는 곳
    run(apply_answer(call, "different", "none"))
    shown = dict(call.recorded())
    assert shown["받는 분 번호"] == TEXTS.saved_value and shown["받는 분"] == DEST.name
    run(dispatch(call, "record_order", json.dumps({"receiver_phone": "01011112222"}), "c"))
    assert dict(call.recorded())["받는 분 번호"] == "01011112222"  # 고객이 직접 불러 준 번호는 보인다


def test_progress_tells_the_item_after_next():
    call = make_call(new_db())
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert "성함" in text and "그다음" in text and "지금 전화하신 번호로" in text


def test_call_info_greets_registered_customer_by_name_with_first_question():
    call = make_call(saved_db())
    info = TEXTS.call_info.format(**call.text_vars(), first=engine.next_text(call))
    assert "김철수" in info and "어디로 보내시나요" in info


def test_confirm_progress_fits_with_realistic_values():
    call = make_call(new_db())
    run(dispatch(call, "record_order", json.dumps(FULL_ORDER, ensure_ascii=False), "c"))
    run(apply_answer(call, "credit", "none"))
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert call.flow.stage == "confirming" and FULL_ORDER["receiver_address"] in text  # 값이 잘리지 않는다
    assert "소형 박스 1개" in text and "30,000원" in text and "정산" in text
