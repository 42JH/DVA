"""Decision 맥락은 현재 답의 근거만 보충하며 서버 기록을 고객 동의로 취급하지 않는다."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.calls.live import LiveFlow, Runtime, Spoken, _decision_input
from app.domain.state import ConversationState, Customer, FieldState, FieldStatus, ParcelDraft


def spoken(i, text, start, end=None):
    return Spoken(i, text, start * 1000, (end or start) * 1000, start, end or start)


def context(text):
    return json.loads(text.splitlines()[1])


@pytest.mark.parametrize("scope", [True, False])
def test_only_question_relevant_server_facts_are_copied(scope):
    state = ConversationState(customer=Customer(name="등록 성함", caller_phone="비공개 전화번호",
                                               default_address="비공개 주소"),
                              intent="order", current=ParcelDraft(ask_customer_name_save=True))
    state.current.fields["sender_name"] = FieldState(value="이번 성함", status=FieldStatus.VALID)
    text = _decision_input(state, Runtime(), spoken(1, "이번에만요", 3), None,
                           [{"name": "sender_name_scope" if scope else "switch"}])
    facts = context(text)["판단 시점 서버 기록"]
    assert ("보내는 분 이름" in facts) == scope
    if scope:
        assert facts["보내는 분 이름"] == {
            "등록 이름": "등록 성함", "이번 택배 기록": "이번 성함", "등록 이름 변경 여부 미결정": True}
    else:
        assert "등록 성함" not in text and "이번 성함" not in text
    assert "비공개" not in text
    assert "이미 반영됐을 수" in text and "동의했다는 증거가 아니다" in text
    assert state.current.ask_customer_name_save


def test_history_keeps_roles_and_order_but_excludes_current_future_and_unfinished_turns():
    question = spoken(1, "등록 이름도 바꿀까요?", 1)
    customer = spoken(2, "무슨 뜻이에요?", 2)
    prev = spoken(3, "앞으로 사용할 이름입니다.", 3, 4)
    utt = spoken(4, "이번에만요", 3.5, 5)
    late = spoken(5, "나중 질문", 6)
    unfinished = spoken(0, "뒤늦게 붙은 전사", 0.5, 6)
    rt = Runtime(ai=[unfinished, question, prev, late], customer_turns=[customer, utt])
    text = _decision_input(ConversationState(), rt, utt, prev, [])
    data = context(text)
    assert data["이전 대화"] == [{"화자": "AI", "발화": question.text}, {"화자": "고객", "발화": customer.text}]
    assert data["판단 시점 서버 기록"]["직전 AI와 고객의 발화 시간 겹침"] is True
    assert "나중 질문" not in text and "뒤늦게 붙은 전사" not in text
    assert text.endswith("직전 AI 발화: 앞으로 사용할 이름입니다.\n고객 발화: 이번에만요")


def test_origin_question_does_not_imply_an_existing_address():
    text = _decision_input(ConversationState(origin_offered=True), Runtime(),
                           spoken(1, "네", 1), None, [{"name": "origin"}])
    assert "발송 주소 후보 출처" not in context(text)["판단 시점 서버 기록"]


def test_history_is_bounded_without_cutting_an_utterance_or_changing_the_current_reply():
    rt = Runtime(customer_turns=[spoken(i, f"과거{i}", i) for i in range(1, 10)])
    utt = spoken(11, "현재 답", 11)
    data = context(_decision_input(ConversationState(), rt, utt, None, []))
    assert [t["발화"] for t in data["이전 대화"]] == [f"과거{i}" for i in range(4, 10)]
    assert data["이전 대화 일부 생략"]
    rt.customer_turns.append(spoken(10, "긴 발화" * 1001, 10))
    text = _decision_input(ConversationState(), rt, utt, None, [])
    assert context(text)["이전 대화"] == []
    assert context(text)["이전 대화 일부 생략"]
    assert text.endswith("고객 발화: 현재 답")


def test_judge_sends_context_to_decision_api():
    import asyncio

    from app.tests.test_live_flow import flow

    async def scenario():
        svc, client = flow()
        client.decisions.create = AsyncMock(return_value=SimpleNamespace(answers=[]))
        state = ConversationState(intent="inquiry")
        rt = Runtime(ai=[spoken(1, "추가로 궁금하신가요?", 1)])
        s = SimpleNamespace(lock=asyncio.Lock(), state=state, rt=rt,
                            tools=SimpleNamespace(draft_intake=False), stats={"Decision 호출": 0},
                            decision_ms=[], timing=lambda *a: None, note=lambda *a: None)
        live = LiveFlow(svc)
        live.apply = AsyncMock()
        await live.judge(s, spoken(2, "상담원 연결해 주세요", 2), rt.ai[-1])
        sent = client.decisions.create.call_args.kwargs
        assert context(sent["input"])["판단 시점 서버 기록"]["기존 업무"] == "inquiry"
        assert [q["name"] for q in sent["questions"]] == ["switch", "reply"]
        assert sent["model"] == "gpt-6-luna"
        live.apply.assert_awaited_once()

    asyncio.run(scenario())
