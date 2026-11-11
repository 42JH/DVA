"""Decision 입력(열린 질문·최근 AI 발화·끊어진 고객 발화)과 서버 주도 통화의 판정 하한(decision-input-plan.md §3)."""
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.calls import decision_input
from app.calls.backend_turn import BackendTurn
from app.calls.turn import TurnInput, TurnPipeline
from app.domain.address_book import begin_sender_name_change, sender_change_next
from app.domain.candidates import offer
from app.domain.confirm import Utterance, issue_cancel_confirmation, issue_parcel_confirmation
from app.domain.state import BoxProposal, ConversationState, Customer, Place, Source
from app.tests.test_calls import FakeClient, service
from app.tests.test_domain import P, confirm_once, filled
from conftest import CALLER, run

NOW = datetime(2026, 11, 11, tzinfo=timezone.utc)


def spoken(uid, text, start, end):
    return SimpleNamespace(utterance_id=uid, text=text, t_start=start, t_last=end, ai_cut=None)


def registered(**state):
    place = Place("김철수", CALLER, "서울 강남구 가람9길 24", "101호")
    return ConversationState(customer=Customer(customer_seq=1, name="김철수", origin_place=place), **state)


# --- 최근 AI 발화 · 고객 조각 ---
def test_recent_ai_joins_every_chunk_since_the_last_customer_turn():
    """되읽기 중 쉼으로 잘린 뒤 '이대로 접수할까요?'만 이어 말해도 되읽기 전체가 들어간다."""
    customers = [spoken(1, "오만 원이요", 0, 1), spoken(5, "네", 30, 30.3)]
    ai = [spoken(2, "네, 오만 원으로 기록했어요.", 2, 4), spoken(3, "김철수님이 역삼동에서 센텀로의 이영희님께 보내시는 것으로 확인했습니다", 5, 12),
          spoken(4, ". 이대로 접수할까요?", 26, 28)]
    text = decision_input.recent_ai(ai, customers, customers[-1])
    assert text.startswith("네, 오만 원으로") and "확인했습니다" in text and text.endswith("이대로 접수할까요?")


def test_recent_ai_reaches_back_to_the_question_when_only_fillers_follow():
    """질문 뒤에 고객의 머뭇거림과 AI 맞장구가 끼어도 그 질문이 남는다. 오래된 질문은 붙이지 않는다."""
    customers = [spoken(2, "어...", 5, 5.5), spoken(4, "네", 12, 12.3)]
    ai = [spoken(1, "등록된 발송 주소로 보내실까요?", 1, 3), spoken(3, "네, 잠시만요.", 7, 9)]
    assert decision_input.recent_ai(ai, customers, customers[-1]) == "등록된 발송 주소로 보내실까요? 네, 잠시만요."
    late = spoken(4, "네", 40, 40.3)
    assert decision_input.recent_ai(ai, [customers[0], late], late) == "네, 잠시만요."


def test_recent_ai_stops_where_the_customer_cut_in_and_keeps_the_tail_when_long():
    customers = [spoken(2, "잠깐만요", 3, 3.5)]
    ai = [spoken(1, "김철수님이 역삼동에서 보내시는 것으로 확인했습니다", 1, 6)]
    assert decision_input.recent_ai(ai, customers, customers[0], cut=(1, 6)) == "김철수님이"
    long = [spoken(1, "가" * 500 + " 이대로 접수할까요?", 1, 2)]
    text = decision_input.recent_ai(long, customers, customers[0])
    assert len(text) == decision_input.RECENT_AI_MAX + 1 and text.endswith("이대로 접수할까요?")


def test_customer_pieces_join_only_without_ai_speech_within_the_window_and_before_apply():
    first, second = spoken(2, "어... 여기가 그", 10, 11), spoken(3, "부산광역시 서구 구덕로", 12.5, 14)
    ai = [spoken(1, "새 발송 주소를 알려주시겠어요?", 5, 8)]
    assert decision_input.joined(ai, [first, second], second) == [first, second]
    assert decision_input.recent_ai(ai, [first, second], first) == "새 발송 주소를 알려주시겠어요?"
    assert decision_input.joined(ai, [first, second], second, applied=2) == [second]  # 앞 조각의 판정이 이미 적용됨
    assert decision_input.joined(ai + [spoken(9, "네", 11.5, 11.8)], [first, second], second) == [second]
    assert decision_input.joined(ai, [first, spoken(3, "부산광역시", 15, 16)], spoken(3, "부산광역시", 15, 16)) != [first]
    assert len(decision_input.joined(ai, [first], spoken(3, "부산광역시", 15, 16))) == 1  # 3초를 넘김


# --- 열린 질문 ---
def _pending_parcel():
    state = filled()
    issue_parcel_confirmation(state, P, 1.0)
    return state


def _pending_cancel():
    state = ConversationState(intent="cancel", selected_order={"order_seq": 1, "order_parcel_seq": 1})
    issue_cancel_confirmation(state, 1.0)
    return state


def _candidates(kind, intent):
    state = ConversationState(intent=intent)
    offer(state, kind, ("첫째", "둘째"), (Place("가", CALLER, "서울 가람9길 24", ""), Place("나", CALLER, "서울 가람9길 25", "")))
    return state


def _box():
    state = filled()
    state.current.box_proposal = BoxProposal("small", 1, 1.0)
    return state


def _name_change(named):
    state = registered(intent="order", origin_offered=True, origin_answer=True, origin_mentioned_in_greeting=True)
    state.record("sender_name", "김철수", Source.PROFILE)
    begin_sender_name_change(state)
    if named:
        state.record("sender_name", "박영희")
        state.origin_answer = True
    return state


def _more():
    state = filled()
    confirm_once(state)
    return state


@pytest.mark.parametrize("build, kwargs, kind, phrase", [
    (lambda: _pending_parcel(), {"end_waiting": True}, "end", "통화 종료 여부(yes=통화 종료)"),
    (lambda: ConversationState(intent="order", callback_offered=True), {}, "callback", "yes=연락 받음"),
    (_pending_cancel, {}, "cancel", "yes=취소 진행"),
    (lambda: _candidates("order", "lookup"), {}, "pick", "조회한 택배 선택: 첫째, 둘째"),
    (lambda: _candidates("parcel", "order"), {}, "pick", "고칠 택배 선택: 첫째, 둘째"),
    (lambda: registered(origin_offered=True), {}, "greeting", "안내한 발송 주소 사용 여부"),
    (ConversationState, {}, "greeting", "첫 인사: 택배 접수 시작 여부(yes=접수 시작)"),
    (lambda: _name_change(named=True), {}, "name_save", "yes=등록 이름 변경"),
    (lambda: registered(intent="order", origin_offered=True), {}, "origin", "yes=등록 주소 사용"),
    (lambda: _candidates("destination", "order"), {}, "pick", "받는 곳 후보 선택: 첫째, 둘째"),
    (_box, {}, "box", "박스 후보 확인: 소형 박스 1개"),
    (_pending_parcel, {}, "readback", "yes=이대로 접수, change=내용 고침"),
    (_more, {}, "more", "yes=더 있음"),
])
def test_open_question_comes_from_server_state(build, kwargs, kind, phrase):
    opened = decision_input.open_question(build(), P, **kwargs)
    assert opened[0] == kind and phrase in opened[1]


def test_open_question_for_the_address_change_and_none_while_collecting_values():
    state = _name_change(named=True)
    state.origin_answer = None
    assert sender_change_next(state) == "ask_address_change"
    assert decision_input.open_question(state, P)[0] == "address_change"
    assert decision_input.open_question(_name_change(named=False), P) is None  # 새 성함을 받는 중
    collecting = ConversationState(intent="order")
    collecting.record("sender_name", "김철수")
    text, kind = decision_input.render(collecting, P, "보내는 분 연락처를 알려주시겠어요?", "공일공")
    assert kind is None and "열린 질문: 없음" in text and "지금 받는 항목: " in text
    fixing = _pending_parcel()
    fixing.pending, fixing.awaiting_fix = None, True
    assert decision_input.open_question(fixing, P) is None  # 고친 값을 기다리는 중


def test_question_list_follows_the_open_question():
    """열린 질문 + switch만 묻고, 보내는 분 변경은 첫 인사와 발송 확인에만 붙인다."""
    greeting = registered(origin_offered=True, origin_mentioned_in_greeting=True)
    flags = decision_input.question_flags(greeting, P, "greeting")
    assert flags["origin"] and flags["sender_change"] and flags["sender_name_scope"] and not flags["pending"]
    readback = _pending_parcel()
    assert decision_input.question_flags(readback, P, "readback") == {
        "pending": True, "callback": False, "origin": False, "sender_change": False, "sender_name_scope": False}
    receiver = registered(intent="order", origin_offered=True, origin_answer=True, origin_applied=True,
                          origin_mentioned_in_greeting=True)
    receiver.record("sender_name", "김철수", Source.PROFILE)
    assert not any(decision_input.question_flags(receiver, P, None).values())  # 받는 분을 받는 중


def test_input_without_the_open_question_line_when_disabled():
    text, kind = decision_input.render(_pending_parcel(), P, "이대로 접수할까요?", "네", open_line=False)
    assert kind is None and text == "최근 AI 발화: 이대로 접수할까요?\n고객 발화: 네"


# --- 서버 주도 통화: 하한과 열린 질문 기준 적용 ---
def answer(name, value, p, **others):
    probabilities = [SimpleNamespace(value=k, probability=v) for k, v in ({value: p} | others).items()]
    return SimpleNamespace(type="choice", name=name, choice=value, confidence=p, probabilities=probabilities)


def pipeline(*answers, **cfg):
    client = FakeClient()
    client.decisions = SimpleNamespace(create=AsyncMock(return_value=SimpleNamespace(answers=answers)))
    client.responses = SimpleNamespace(create=AsyncMock(return_value=SimpleNamespace(status="completed", output=[])))
    deps = service(client, **cfg).d
    backend = BackendTurn(client, deps.backend_model, deps.backend_effort, deps.policy)
    return TurnPipeline(client, backend, deps.policy, 0.5, deps.cfg), client


def turn(state, text, **kwargs):
    return TurnInput(state, Utterance(3, 2000, 2300, 2.0, text), Utterance(2, 1000, 1800, 1.1, "질문"), NOW, **kwargs)


def test_origin_answer_applies_from_the_open_question_without_matching_the_spoken_sentence():
    """Live가 다른 문장으로 물어도 서버가 기다리는 질문의 답이면 적용한다. 확실하지 않으면 적용하지 않는다."""
    flow, client = pipeline(answer("origin", "yes", 0.98, not_answer=0.02))
    state = registered(intent="order", origin_offered=True)
    result = run(flow.run(turn(state, "네 거기서 보낼게요", recent_ai="늘 보내시던 곳에서 보내시는 거죠?")))
    assert state.origin_answer is True and state.origin_applied and result.decision["open_question"] == "origin"
    sent = client.decisions.create.await_args.kwargs
    assert "열린 질문: 등록된 발송 주소 사용 여부" in sent["input"] and "늘 보내시던 곳" in sent["input"]
    assert [q["name"] for q in sent["questions"]] == ["origin", "switch", "sender_name_scope", "value"]

    flow, _ = pipeline(answer("origin", "yes", 0.6, not_answer=0.4))  # 둘째와의 차이가 0.3보다 작다
    unsure = registered(intent="order", origin_offered=True)
    run(flow.run(turn(unsure, "네 거기서 보낼게요")))
    assert unsure.origin_answer is None


@pytest.mark.parametrize("said, decided, changes", [
    ("네", None, True), ("아니요", None, False), ("네 바꿀게요", "yes", True), ("아뇨 그대로요", "no", False)])
def test_address_change_question_means_yes_is_a_new_address(said, decided, changes):
    flow, _ = pipeline(*([answer("origin", decided, 0.95)] if decided else []))
    state = _name_change(named=True)
    state.origin_answer = None
    run(flow.run(turn(state, said, origin_question=decided is None, spoken_question="ask_address_change")))
    assert state.current.sender_address_change is changes
    assert (sender_change_next(state) == "sender_address") is changes


def test_end_needs_a_clear_request_and_otherwise_asks_once():
    for p, expected in ((0.95, "end"), (0.8, "confirm_end"), (0.7, None)):
        flow, client = pipeline(answer("switch", "end", p))
        state = ConversationState(intent="order")
        state.record("sender_name", "김철수")
        result = run(flow.run(turn(state, "이제 됐어요 끊을게요")))
        assert (result.state.next_question == expected) if expected else client.responses.create.await_count == 1
    # 열린 질문에 동의한 말과 종료가 겹치면 바로 끊지 않는다.
    flow, _ = pipeline(answer("switch", "end", 0.95), answer("more", "more", 0.9))
    assert run(flow.run(turn(_more(), "네 끊어주세요"))).state.next_question != "end"
    flow, _ = pipeline(answer("switch", "end", 0.95), answer("origin", "yes", 0.9))
    state = registered(intent="order", origin_offered=True)
    assert run(flow.run(turn(state, "네 끊어주세요"))).state.next_question == "confirm_end"


def test_a_pick_among_candidates_keeps_the_strict_floor():
    flow, _ = pipeline(answer("pick", "첫째", 0.75, not_answer=0.2))
    state = _candidates("order", "lookup")
    run(flow.run(turn(state, "유민국님 거요", pick_allowed=True)))
    assert state.candidates is not None and state.selected_order is None


def test_callback_and_box_answers_apply_from_the_open_question():
    flow, _ = pipeline(answer("callback", "yes", 0.9))
    state = ConversationState(intent="order", callback_offered=True)
    result = run(flow.run(turn(state, "네 그렇게 해 주세요")))
    assert state.callback_requested and result.facts == {"agent": "callback_registered"}
    flow, _ = pipeline(answer("box", "no", 0.9))
    state = _box()
    result = run(flow.run(turn(state, "아니요 그건 아니에요")))
    assert state.current.box_proposal is None and result.facts == {"box_proposal_declined": True}


def test_an_unsure_short_answer_asks_again_with_the_choices_spelled_out():
    flow, client = pipeline(answer("origin", "yes", 0.55, not_answer=0.45))
    state = registered(intent="order", origin_offered=True)
    result = run(flow.run(turn(state, "네")))
    assert result.facts == {"clarify": "origin"} and state.origin_answer is None
    client.responses.create.assert_not_awaited()
    # 열린 질문의 답이 아니라고 본 짧은 말은 다시 묻지 않고 평소처럼 넘긴다.
    flow, client = pipeline(answer("origin", "not_answer", 0.9))
    result = run(flow.run(turn(registered(intent="order", origin_offered=True), "네")))
    assert "clarify" not in result.facts and client.responses.create.await_count == 1
    flow, client = pipeline(answer("task", "chit_chat", 0.6, order=0.4))  # 맞장구로 본 첫 인사 답도 마찬가지
    result = run(flow.run(turn(ConversationState(), "네")))
    assert "clarify" not in result.facts and client.responses.create.await_count == 1


def test_backend_receives_the_joined_customer_speech():
    flow, client = pipeline(answer("switch", "none", 0.99))
    state = ConversationState(intent="order")
    run(flow.run(turn(state, "부산광역시 서구 구덕로", said="어... 여기가 그 부산광역시 서구 구덕로")))
    assert "어... 여기가 그 부산광역시 서구 구덕로" in client.responses.create.await_args.kwargs["input"][0]["content"]
    assert "어... 여기가 그 부산광역시" in client.decisions.create.await_args.kwargs["input"]
