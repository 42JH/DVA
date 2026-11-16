"""일반 수긍 뒤 진행은 Live가 맡는다. 서버는 같은 질문을 다시 지시하지 않는다."""

import asyncio
import time

import pytest

from conftest import run
from app.calls.live import LiveFlow, Runtime, Spoken
from app.calls.session import Phase
from app.domain.state import ConversationState, ParcelDraft
from app.policy.render import decision_questions, render_delegation
from app.tests.test_calls import FakeConn
from app.tests.test_domain import P
from app.tests.test_live_flow import flow
from app.tests.test_results import session


@pytest.mark.parametrize("intent", ["order", "lookup", "inquiry", "cancel"])
def test_plain_acknowledgement_sends_no_server_guidance(intent):
    async def scenario():
        svc, _ = flow()
        live = LiveFlow(svc)
        s = session(ConversationState(intent=intent, current=ParcelDraft() if intent == "order" else None))
        s.phase, s.sideband = Phase.ACTIVE, FakeConn()
        now = time.time()
        prev = Spoken(1, "확인한 내용입니다.", 100, 500, now - 2, now - 1)
        turn = Spoken(2, "네", 1000, 1200, now, now)
        s.rt = Runtime(ai=[prev], customer_turns=[turn])
        await live.apply(s, turn, prev, {"switch": ("none", 1.0)}, None)
        if s.tasks:
            await asyncio.gather(*list(s.tasks))
        assert not [e for e in s.sideband.sent if e["type"] == "session.commentary.append"]
    run(scenario())


def test_live_is_told_to_continue_and_decision_has_no_reply_question():
    text = render_delegation(P)
    assert "바로 이어갑니다" in text and "독자적으로 다음 질문" not in text
    assert "결과가 올 때까지 다음 질문을 하지 않습니다" in text  # 서버 결과 대기 규칙은 유지
    for stage in ("intent", "receiver", "more_parcels", "lookup"):
        assert "reply" not in [q["name"] for q in decision_questions(P, stage)]
    assert "acknowledgement" not in P.results
