import asyncio
import json
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from openai.types.responses import ResponseFunctionToolCall

from app.calls.backend_turn import BackendTurn
from app.calls.live import LiveFlow, Spoken
from app.calls.session import Phase
from app.calls.turn import TurnInput, TurnPipeline
from app.domain.candidates import offer
from app.domain.confirm import Utterance, issue_parcel_confirmation
from app.domain.state import Customer, ConversationState, Place
from app.tests.test_calls import FakeClient, incoming, service, started, until
from app.tests.test_domain import filled
from app.tests.test_live_flow import ai, choice, say
from backend_client.order import Place as BackendPlace
from call_analysis.turn_shadow_report import summarize
from conftest import CALLER, run

NOW = datetime(2026, 11, 11, tzinfo=timezone.utc)


def _client(*answers):
    client = FakeClient()
    client.decisions = SimpleNamespace(create=AsyncMock(return_value=SimpleNamespace(answers=answers)))
    client.responses = SimpleNamespace(create=AsyncMock())
    return client


def _pipeline(client):
    deps = service(client).d
    backend = BackendTurn(client, deps.backend_model, deps.backend_effort, deps.policy)
    return TurnPipeline(client, backend, deps.policy, decision_budget_sec=0.5)


def test_shadow_preserves_greeting_across_ack_without_changing_live_call():
    client = _client(choice("task", "chit_chat", 0.86), choice("origin", "not_answer", 0.94))
    svc = service(client, turn_shadow_enabled=True, utterance_gap_ms=40, notify_quiet_ms=30)
    svc.d.backend.api.add_customer(CALLER, "테스트", default_origin=BackendPlace(
        name="테스트", phone=CALLER, address="서울 강남구 가람9길 24", address_detail="101호"))
    LiveFlow(svc)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        s = svc.registry.calls["live_1"]
        await until(lambda: s.phase == Phase.ACTIVE)
        await ai(conn, "안녕하세요, 테스트님, 서울 강남구 가람구길 이십사에서 발송하시는 택배 접수 도와드릴까요?", 0)
        await ai(conn, "네", 1100)
        await say(conn, "어… 네", 2200)
        assert s.state.intent is None and not s.state.origin_applied
        await ai(conn, "어떤 물품을 보내시나요?", 4000)
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        row = next(e["data"] for e in s.events if e["kind"] == "Turn shadow")
        assert row["legacy_state_question"] == "intent"
        assert row["legacy_spoken_question"] == "items"
        assert row["shadow_question"] == "receiver_name"
        assert "sender_address" in row["differing_fields"]
        assert row["route"] == "closed" and row["parcel_count_matches"]
        assert "가람" not in json.dumps(row, ensure_ascii=False) and "101호" not in str(row)
        client.responses.create.assert_not_awaited()
        assert not any("receiver_name" in e.get("content", "") for e in conn.sent)

    run(scenario())


def test_shadow_records_mixed_turn_on_copy_and_rejects_external_tool():
    client = _client(choice("value", "yes"))
    pipeline = _pipeline(client)
    original = ConversationState(customer=Customer(caller_phone=CALLER), intent="order")
    original.record("receiver_name", "테스트")
    state = deepcopy(original)
    client.responses.create.side_effect = [
        SimpleNamespace(status="completed", output=[
            ResponseFunctionToolCall(type="function_call", call_id="bad", name="cancel_parcel", arguments="{}"),
            ResponseFunctionToolCall(type="function_call", call_id="new", name="record_fields",
                                     arguments='{"receiver_phone":"01022223333"}'),
        ]),
        SimpleNamespace(status="completed", output=[]),
    ]

    result = run(pipeline.run(TurnInput(state, Utterance(3, 1000, 1300, 1.0, "네, 연락처는 01022223333이에요"),
                                        None, NOW)))

    assert result.route == "backend" and result.status == "unsupported_tool" and result.tool_calls == 2
    assert result.state.fields["receiver_phone"] == "01022223333"
    assert not original.current["receiver_phone"].valid and not original.order_cancelled
    requests = client.responses.create.await_args_list
    assert all(not r.kwargs["store"] for r in requests)
    assert {t["name"] for t in requests[0].kwargs["tools"]} == {"record_fields", "get_state"}
    outputs = [item for item in requests[1].kwargs["input"] if item.get("type") == "function_call_output"]
    assert json.loads(outputs[0]["output"])["code"] == "TOOL_NOT_ALLOWED"
    assert json.loads(outputs[1]["output"])["status"] == "ok"


def test_shadow_registered_address_and_conflicting_end_are_state_only():
    client = _client(choice("confirm", "yes", 0.89), choice("switch", "end", 0.91))
    pipeline = _pipeline(client)
    state = filled()
    pending = issue_parcel_confirmation(state, pipeline.policy, 1.0)
    turn = TurnInput(state, Utterance(3, 2000, 2300, 2.0, "네"),
                     Utterance(2, 1000, 1800, 1.1, "이대로 접수할까요?", pending.id), NOW)
    result = run(pipeline.run(turn))
    assert result.state.next_question == "confirm_end" and not state.parcels and state.pending is pending
    origin = ConversationState(customer=Customer(customer_seq=1, name="테스트", origin_place=Place(
        "테스트", CALLER, "서울 강남구 가람9길 24", "101호")), intent="order", origin_offered=True)
    result = run(pipeline.run(TurnInput(origin, turn.customer, turn.previous, NOW, origin_question=True)))
    assert result.state.fields["sender_address_detail"] == "101호"
    client.responses.create.assert_not_awaited()


def test_shadow_accepts_only_a_known_destination_on_a_short_yes():
    client = _client(choice("pick", "두 번째 후보"))
    pipeline = _pipeline(client)
    state = ConversationState(intent="order")
    offer(state, "destination", ("첫 번째 후보", "두 번째 후보"), (
        Place("테스트", "01011112222", "서울 가람9길 24", "101호"),
        Place("테스트", "01022223333", "서울 가람9길 24", "102호"),
    ))
    yes = Utterance(3, 2000, 2300, 2.0, "네, 맞습니다")
    client.responses.create.return_value = SimpleNamespace(status="completed", output=[])
    ambiguous = run(pipeline.run(TurnInput(deepcopy(state), yes, None, NOW)))
    assert ambiguous.state.candidate_kind == "destination" and "receiver_address" not in ambiguous.state.fields
    chosen = run(pipeline.run(TurnInput(deepcopy(state), yes, None, NOW, destination="두 번째 후보")))
    assert chosen.state.candidate_kind is None and chosen.state.fields["receiver_address_detail"] == "102호"
    assert state.candidates is not None


def test_shadow_cancels_previous_turn_and_respects_the_sampling_limit():
    client = _client(choice("switch", "none"))
    svc = service(client, turn_shadow_enabled=True, turn_shadow_max_turns=1, utterance_gap_ms=40)
    flow = LiveFlow(svc)

    async def scenario():
        running, cancelled = asyncio.Event(), asyncio.Event()

        async def hanging_response(**kwargs):
            running.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        client.responses.create.side_effect = hanging_response
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        s = svc.registry.calls["live_1"]
        await until(lambda: s.phase == Phase.ACTIVE)
        await say(conn, "받는 분 연락처는 이 번호예요", 1000)
        await asyncio.wait_for(running.wait(), 1.0)
        await say(conn, "아니요", 3000)
        await asyncio.wait_for(cancelled.wait(), 1.0)
        assert s.stats["Turn shadow 제한"] == 1
        assert not flow.shadow_tasks and s.phase == Phase.ACTIVE
        assert [e["text"] for e in s.events if e["kind"] == "Turn shadow"] == ["superseded"]
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task

    run(scenario())


def test_report_compares_observed_questions_and_marks_unobserved_turns(tmp_path):
    path = tmp_path / "call.json"
    path.write_text(json.dumps({"transcript": [{"text": "private address"}], "stats": {"Turn shadow 제한": 2},
                                "events": [
        {"kind": "Turn shadow", "data": {"status": "ok", "legacy_spoken_question": "items",
                                       "shadow_question": "receiver_name", "legacy_spoken_ms": 1400,
                                       "shadow_ready_ms": 30, "differing_fields": ["sender_address"]}},
        {"kind": "Turn shadow", "data": {"status": "ok", "shadow_question": "origin"}},
        {"kind": "Turn shadow", "data": {"status": "superseded"}},
    ]}), encoding="utf-8")
    report = summarize([path])
    assert report["calls"] == 1 and report["next_question"] == {"different": 1, "unobserved": 1}
    assert report["turn_status"]["sample_limit"] == 2 and report["turn_status"]["superseded"] == 1
    assert report["field_differences"] == {"sender_address": 1}
    assert report["legacy_spoken_ms"]["p95"] == 1400 and report["shadow_ready_ms"]["p95"] == 30
    assert "private address" not in str(report)


def test_server_mode_owns_first_turn_and_ignores_hosted_tool_events():
    client = _client(choice("task", "chit_chat"))
    svc = service(client, turn_mode="server", turn_shadow_enabled=True, utterance_gap_ms=40, notify_quiet_ms=30)
    svc.d.backend.api.add_customer(CALLER, "테스트", default_origin=BackendPlace(
        name="테스트", phone=CALLER, address="서울 강남구 가람9길 24", address_detail="101호"))
    flow = LiveFlow(svc)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        s = svc.registry.calls["live_1"]
        await until(lambda: s.phase == Phase.ACTIVE)
        assert svc.session_config(s, None)["delegation"] == {"type": "client"}
        await ai(conn, "안녕하세요, 테스트님, 서울 강남구 가람구길 이십사에서 발송하시는 택배 접수 도와드릴까요?", 0)
        await ai(conn, "네", 1100)
        conn.push({"type": "session.delegation.created", "offset_ms": 2300,
                   "delegation": {"id": "client_d1", "target": "client"}})
        conn.push({"type": "response.event", "delegation_id": "client_d1", "event": {
            "type": "response.output_item.done", "item": {"type": "function_call", "call_id": "wrong_path",
                                                         "name": "record_fields",
                                                         "arguments": '{"big_box_count":3}'}}})
        await say(conn, "어… 네", 2200)
        await until(lambda: any('"next_question": "receiver_name"' in e.get("content", "") for e in conn.sent))
        assert s.state.intent == "order" and s.state.current["sender_address_detail"].value == "101호"
        assert not s.state.current["items"].valid and not s.tool_calls
        assert not flow.shadow and client.decisions.create.await_count == 0
        announcements = [e for e in conn.sent if e["type"] == "session.commentary.append"]
        assert len(announcements) == 2  # greeting and server next question
        assert any(e["type"] == "session.thinking.append" and e["delegation_id"] == "client_d1" for e in conn.sent)
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task

    run(scenario())


def test_server_mode_final_yes_uses_existing_commit_gate():
    client = _client(choice("confirm", "yes", 0.97), choice("switch", "none", 0.97))
    svc = service(client, turn_mode="server", utterance_gap_ms=40, notify_quiet_ms=30, commit_delay_ms=20)
    flow = LiveFlow(svc)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        s = svc.registry.calls["live_1"]
        await until(lambda: s.phase == Phase.ACTIVE)
        async with s.lock:
            s.tools.state = filled()
            pending = issue_parcel_confirmation(s.state, s.tools.policy, s.tools.clock())
        await flow.commit(s, pending.id, only_turn=Spoken(1, "네", 0, 100, 0.0, 0.1))
        assert s.state.pending is pending and not s.state.parcels
        await ai(conn, "이대로 접수할까요?", 0)
        await say(conn, "네", 1600)
        await until(lambda: len(s.state.parcels) == 1)
        assert s.state.pending is None and s.state.parcels[0].confirmed_snapshot == pending.snapshot
        await until(lambda: any("parcel_added" in e.get("content", "") for e in conn.sent))
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task

    run(scenario())


def test_server_mode_lookup_opens_cancel_confirmation_before_existing_cancel_execution():
    client = _client()

    async def decide(*, model, input, questions):
        names = {q["name"] for q in questions}
        answers = [choice("task", "cancel", 0.97)] if "task" in names else [
            choice("confirm", "yes", 0.97), choice("switch", "none", 0.97)]
        return SimpleNamespace(answers=answers)

    client.decisions.create.side_effect = decide
    client.responses.create.side_effect = [
        SimpleNamespace(status="completed", output=[ResponseFunctionToolCall(
            type="function_call", call_id="lookup", name="lookup_orders", arguments="{}")]),
        SimpleNamespace(status="completed", output=[]),
    ]
    svc = service(client, turn_mode="server", utterance_gap_ms=40, notify_quiet_ms=30, commit_delay_ms=20)
    svc.d.backend.api.add_customer(CALLER, "테스트")
    svc.d.backend.api.add_order(CALLER, "COLLECTING", [("이영희", "서울 가람9길 24")])
    LiveFlow(svc)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        s = svc.registry.calls["live_1"]
        await until(lambda: s.phase == Phase.ACTIVE)
        await say(conn, "보낸 택배를 취소해 주세요", 1000)
        await until(lambda: s.rt.server_task is not None and s.rt.server_task.done(), timeout=12.0)
        await until(lambda: sum(e.get("type") == "session.commentary.append" for e in conn.sent) >= 2)
        assert any('"next_question": "cancel_confirmation"' in e.get("content", "") for e in conn.sent), [
            (e["text"], e.get("data")) for e in s.events if e["kind"] == "Server turn"]
        assert s.state.pending.kind == "cancel" and not s.state.cancel_done
        await ai(conn, "이 택배를 취소할까요?", 3000)
        await say(conn, "네", 5000)
        await until(lambda: s.state.cancel_done)
        assert s.state.pending is None
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task

    run(scenario())
