"""일반 수긍은 진행하되, 이미 진행 중인 결과 안내·확인·새 발화를 침범하지 않는다."""

import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from conftest import run
from app.calls.live import LiveFlow, Runtime, Spoken
from app.calls.session import Phase
from app.domain.state import CandidateSet, ConversationState, ParcelDraft
from app.policy.render import decision_questions
from app.tests.test_calls import FakeConn
from app.domain.confirm import issue_parcel_confirmation
from app.tests.test_domain import P, filled
from app.tests.test_live_flow import choice, flow
from app.tests.test_results import session


def setup(intent="lookup"):
    svc, _ = flow()
    live = LiveFlow(svc)
    state = ConversationState(intent=intent, current=ParcelDraft() if intent == "order" else None)
    if intent == "lookup":
        state.selected_order = {"status": "READY"}
    elif intent == "cancel":
        state.cancel_done = True
    s = session(state)
    s.phase, s.sideband = Phase.ACTIVE, FakeConn()
    now = time.time()
    prev = Spoken(1, "확인한 내용입니다.", 100, 500, now - 2, now - 1)
    turn = Spoken(2, "네", 1000, 1200, now, now)
    s.rt = Runtime(ai=[prev], customer_turns=[turn])
    return live, s, turn, prev


async def answer(live, s, turn, prev, reply="acknowledge", confidence=1.0, **answers):
    await live.apply(s, turn, prev, {"switch": ("none", 1.0), "reply": (reply, confidence), **answers}, None)
    if s.tasks:
        await asyncio.gather(*list(s.tasks))


def notices(s):
    return [json.loads(e["content"].removeprefix("[서버 결과] ")) for e in s.sideband.sent
            if e["type"] == "session.commentary.append"]


@pytest.mark.parametrize("intent", ["order", "lookup", "inquiry", "cancel"])
def test_acknowledgement_continues_across_business_stages(intent):
    async def scenario():
        live, s, turn, prev = setup(intent)
        await answer(live, s, turn, prev)
        [notice] = notices(s)
        assert notice["acknowledgement"] == ("continue" if intent == "order" else "ask_help")
        if intent == "order":
            assert notice["summary"]["next_field"] == "sender_name"
        assert s.state.intent == intent and not s.state.parcels and s.state.pending is None
        await answer(live, s, turn, prev)  # 같은 판정을 다시 적용해도 안내는 한 번만 보낸다.
        assert len(notices(s)) == 1
    run(scenario())


@pytest.mark.parametrize("reply, confidence", [("wait", 1.0), ("confirmation", 1.0), ("other", 1.0),
                                                ("acknowledge", 0.3)])
def test_non_acknowledgements_and_uncertain_answers_do_not_advance(reply, confidence):
    async def scenario():
        live, s, turn, prev = setup()
        await answer(live, s, turn, prev, reply, confidence)
        assert not notices(s)
    run(scenario())


@pytest.mark.parametrize("blocker", ["confirmation", "candidate", "delegation", "new_customer", "live_spoke",
                                    "closing", "server_guidance", "queued_notice"])
def test_acknowledgement_rechecks_ownership_after_waiting(blocker):
    async def scenario():
        live, s, turn, prev = setup()

        async def during_wait(*args, **kwargs):
            if blocker == "confirmation":
                s.tools.state = filled()
                issue_parcel_confirmation(s.state, P, time.time())
            elif blocker == "candidate":
                s.state.candidates = CandidateSet("order", ("후보",), ({},))
            elif blocker == "delegation":
                d = live._dl(s, "pending")
                d["inflight"] = 1
                d["t"] = time.time() - 60  # 기존 대기 상한을 넘어도 미완료 처리를 앞지르지 않는다.
            elif blocker == "new_customer":
                s.rt.cust = Spoken(3, "추가 발화", 1300, 1400, time.time(), time.time())
            elif blocker == "live_spoke":
                s.last_output_t = time.time()
            elif blocker == "closing":
                s.phase = Phase.CLOSING
            elif blocker == "server_guidance":
                await live.send(s, {"type": "response.create"})
            elif blocker == "queued_notice":
                s.rt.pending_guidance += 1

        live._wait_quiet = during_wait
        await answer(live, s, turn, prev)
        assert not notices(s)
    run(scenario())


def test_real_result_notice_wins_over_queued_acknowledgement():
    async def scenario():
        live, s, turn, prev = setup()
        entered, release = asyncio.Event(), asyncio.Event()

        async def wait(*args, **kwargs):
            entered.set()
            await release.wait()

        live._wait_quiet = wait
        task = asyncio.create_task(live.notify(s, "N2", {"result": "actual"}))
        await entered.wait()
        ack = asyncio.create_task(answer(live, s, turn, prev))
        await asyncio.sleep(0)
        release.set()
        await asyncio.gather(task, ack)
        assert notices(s) == [{"result": "actual"}]
        assert s.rt.pending_guidance == 0
    run(scenario())


@pytest.mark.parametrize("operation", ["commit", "follow", "transfer"])
def test_business_processing_keeps_ownership_until_its_result_is_announced(operation):
    async def scenario():
        live, s, turn, prev = setup()
        entered, release = asyncio.Event(), asyncio.Event()

        async def processing(*args):
            entered.set()
            await release.wait()
            await live.notify(s, "N2", {"result": "actual"})

        if operation == "commit":
            live._commit = processing
            task = asyncio.create_task(live.commit(s, "pending"))
        elif operation == "follow":
            live._follow_inner = processing
            task = asyncio.create_task(live._follow(s, "intent", "cancel"))
        else:
            live._transfer_inner = processing
            task = asyncio.create_task(live._transfer(s))
        await entered.wait()
        await answer(live, s, turn, prev)
        assert not notices(s)
        release.set()
        await task
        assert notices(s) == [{"result": "actual"}]
        assert s.rt.pending_guidance == 0
    run(scenario())


def test_cancelling_a_pending_notice_releases_ownership():
    async def scenario():
        live, s, turn, prev = setup()
        entered = asyncio.Event()

        async def wait(*args, **kwargs):
            entered.set()
            await asyncio.Event().wait()

        live._wait_quiet = wait
        task = asyncio.create_task(live.notify(s, "N2", {"result": "actual"}))
        await entered.wait()
        assert s.rt.pending_guidance == 1
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert s.rt.pending_guidance == 0
        assert not notices(s)
    run(scenario())


@pytest.mark.parametrize("outcome", ["acknowledge", "timeout", "unavailable"])
def test_judge_uses_one_request_and_does_not_guess_after_api_failure(outcome):
    async def scenario():
        live, s, turn, prev = setup()
        create = AsyncMock(return_value=SimpleNamespace(answers=[choice("switch", "none"),
                                                                 choice("reply", "acknowledge")]))
        if outcome != "acknowledge":
            create.side_effect = TimeoutError() if outcome == "timeout" else RuntimeError("unavailable")
        live.svc.d.client.decisions.create = create
        await live.judge(s, turn, prev)
        if s.tasks:
            await asyncio.gather(*list(s.tasks))
        create.assert_awaited_once()
        assert [q["name"] for q in create.call_args.kwargs["questions"]] == ["switch", "reply"]
        assert notices(s) == ([{"acknowledgement": "ask_help"}] if outcome == "acknowledge" else [])
    run(scenario())


def test_existing_confirmation_answer_is_not_followed_by_generic_acknowledgement():
    async def scenario():
        live, s, turn, prev = setup()
        live._follow = AsyncMock()
        await answer(live, s, turn, prev, switch=("end", 1.0))
        live._follow.assert_awaited_once_with(s, "intent", "end")
        assert not notices(s)
    run(scenario())


def test_help_reply_asks_for_the_actual_request_without_repeating_the_lookup():
    async def scenario():
        live, s, turn, prev = setup()
        await answer(live, s, turn, prev, "help")
        assert notices(s) == [{"acknowledgement": "clarify"}]
        assert not s.tool_calls
    run(scenario())


@pytest.mark.parametrize("intent", ["lookup", "cancel"])
def test_unfinished_business_reasks_the_target_instead_of_asking_for_another_task(intent):
    async def scenario():
        live, s, turn, prev = setup(intent)
        s.state.selected_order = None
        s.state.cancel_done = False
        await answer(live, s, turn, prev)
        assert notices(s) == [{"acknowledgement": "clarify", "intent": intent}]
    run(scenario())


def test_reply_question_reuses_the_existing_decision_request():
    qs = decision_questions(P, "lookup")
    assert [q["name"] for q in qs] == ["switch", "reply"]
    assert {v["value"] for v in qs[-1]["choices"]} == {"acknowledge", "confirmation", "wait", "help", "other"}
    switch = qs[0]["instructions"]
    assert "추가 도움이 없다고" in switch
