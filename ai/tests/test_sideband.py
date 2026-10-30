"""가짜 sideband로 함수 호출 결과 반환·받아쓰기·고객 답 판별·종료 타이밍·동시 통화를 확인한다."""

import asyncio
import time

from conftest import CFG, FULL_ORDER, FakeClient, FakeBackend, make_call, run, until

from app.sideband import run_call


def quick_cfg(pause_ms=100, **call):
    return CFG.model_copy(update={"call": CFG.call.model_copy(update=call),
                                  "listener": CFG.listener.model_copy(update={"pause_ms": pause_ms})})


def answers(client, answer, intent="none"):
    client.responses.decide = lambda kw: {"answer": answer, "intent": intent}


async def start(call, client):
    task = asyncio.create_task(run_call(call, client))
    await until(lambda: call.session_id in client.live.sideband.conns and call.status == "active")
    return task, client.live.sideband.conns[call.session_id]


def test_function_call_returns_output_then_response_create_and_progress():
    client, call = FakeClient(), make_call()

    async def scenario():
        task, conn = await start(call, client)
        assert conn.sent[0][0] == "session.thinking.append"
        assert conn.sent[0][1]["delegation_id"] is None
        conn.push("response.event", event={"type": "response.output_item.added",
                                           "item": {"type": "function_call", "id": "it1", "call_id": "c1", "name": "record_order"}})
        conn.push("response.event", event={"type": "response.function_call_arguments.delta", "item_id": "it1", "delta": "{"})
        conn.function_call("record_order", {"sender_name": "김철수"}, "c1")
        await until(lambda: conn.outputs())
        await until(lambda: len(conn.sent) >= 4)
        paths = [p for p, _ in conn.sent]
        assert paths[1:4] == ["response.item.create", "response.create", "session.thinking.append"]
        assert conn.sent[1][1]["item"]["call_id"] == "c1"
        assert "김철수" in conn.sent[3][1]["content"]
        conn.function_call("no_such_tool", {}, "c2")  # 없는 도구여도 결과는 꼭 돌려준다
        await until(lambda: len(conn.outputs()) == 2)
        assert conn.outputs()[1]["ok"] is False
        assert [p for p, _ in conn.sent].count("response.create") == 2
        conn.push("session.closed", reason="remote_hangup", usage=None)
        await task
        assert call.status == "ended" and call.end_reason == "remote_hangup"
        assert call.tool_calls["c1"]["status"] == "done"

    run(scenario())


def test_transcript_bubbles_append_to_open_bubble_of_speaker():
    client, call = FakeClient(), make_call()

    async def scenario():
        task, conn = await start(call, client)
        # 상담원이 말하는 중 고객이 "네" 하고 끼어듦(겹침) → 상담원 말풍선은 이어진다. 그 뒤 한참 있다 고객 차례
        for speaker, delta, ms in [("output", "안녕하세요 ", 0), ("input", "네 ", 300), ("output", "디포스트콜", 400),
                                   ("input", "택배요", 5000), ("output", "네 고객님", 8000)]:
            conn.push(f"session.{speaker}_transcript.delta", delta=delta, start_ms=ms, end_ms=ms + 200)
        conn.push("session.closed", reason="remote_hangup", usage=None)
        await task
        assert [(b["speaker"], b["text"]) for b in call.transcript] == [("agent", "안녕하세요 디포스트콜"), ("customer", "네 택배요"),
                                                                           ("agent", "네 고객님")]

    run(scenario())


def test_customer_answer_changes_state_without_tool_call():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg()
        call.flow.stage = "after_order"
        task, conn = await start(call, client)
        conn.push("session.output_transcript.delta", delta="더 보내실 택배가 있으신가요?")
        answers(client, "more")
        conn.push("session.input_transcript.delta", delta="네 하나 ")
        conn.push("session.input_transcript.delta", delta="더요")
        await until(lambda: call.flow.stage == "collecting")
        assert len(client.responses.requests) == 1  # 말이 멈춘 뒤 한 번만 판별
        req = client.responses.requests[0]
        assert "네 하나 더요" in req["input"] and "더 보내실 택배" in req["input"]
        assert req["text"]["format"]["schema"]["properties"]["answer"]["enum"] == ["more", "no_more", "none"]
        assert req["model"] == CFG.listener.model and req["store"] is False
        await until(lambda: conn.sent[-1][0] == "session.thinking.append" and "보내는 분" in conn.sent[-1][1]["content"])
        assert conn.outputs() == []  # 백엔드 도구 호출 없음
        rec = next(t for t in call.tool_calls.values() if t["name"] == "listener")
        assert rec["total_ms"] >= rec["elapsed_ms"]  # 지연 측정: 말 끝 → 진행 상태
        conn.push("session.closed", reason="remote_hangup", usage=None)
        await task

    run(scenario())


def test_stale_answer_is_discarded_when_stage_changed():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg()
        call.flow.stage = "after_order"
        task, conn = await start(call, client)
        client.responses.delay = 0.3
        answers(client, "no_more")
        conn.push("session.input_transcript.delta", delta="아니요")
        await until(lambda: client.responses.requests)
        call.flow.stage = "collecting"  # 판별 중에 다른 경로로 단계가 바뀜
        await until(lambda: any(r.get("status") == "stale" for r in call.tool_calls.values()))
        assert call.flow.stage == "collecting" and not call.hangup_requested.is_set()
        conn.push("session.closed", reason="remote_hangup", usage=None)
        await task

    run(scenario())


def test_classifier_output_outside_choices_is_ignored():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg()
        call.flow.stage = "after_order"
        task, conn = await start(call, client)
        client.responses.decide = lambda kw: {"answer": "drop_table", "intent": "none"}
        conn.push("session.input_transcript.delta", delta="음")
        await until(lambda: call.errors)
        assert call.flow.stage == "after_order"
        client.responses.decide = lambda kw: "not json"
        conn.push("session.input_transcript.delta", delta="음")
        await until(lambda: len(call.errors) == 2)
        conn.push("session.closed", reason="remote_hangup", usage=None)
        await task

    run(scenario())


def test_hangup_waits_for_goodbye_to_finish():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg(hangup_silence_sec=0.2, hangup_max_wait_sec=3.0)
        call.flow.stage = "after_order"
        task, conn = await start(call, client)
        answers(client, "no_more")
        conn.push("session.input_transcript.delta", delta="없어요")
        await until(lambda: call.flow.stage == "ending")
        await asyncio.sleep(0.3)
        assert client.live.sessions.of("hangup") == []  # 인사가 시작되기 전에는 끊지 않는다
        for _ in range(3):
            conn.push("session.output_audio.delta", delta="")
            await asyncio.sleep(0.05)
        t0 = time.monotonic()
        await until(lambda: client.live.sessions.of("hangup"))
        assert time.monotonic() - t0 >= 0.1
        conn.push("session.input_transcript.delta", delta="네 수고하세요")  # ending에서는 판별하지 않는다
        await asyncio.sleep(0.2)
        assert len(client.responses.requests) == 1
        conn.push("session.closed", reason="close_requested", usage=None)
        await task

    run(scenario())


def test_hangup_after_max_wait_even_without_speech():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg(hangup_silence_sec=0.1, hangup_max_wait_sec=0.3)
        task, conn = await start(call, client)
        answers(client, "none", "end")
        conn.push("session.input_transcript.delta", delta="그냥 끊을게요")
        await until(lambda: client.live.sessions.of("hangup"), timeout=2)
        conn.push("session.closed", reason="close_requested", usage=None)
        await task

    run(scenario())


def test_refer_after_handoff_yes():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg(hangup_silence_sec=0.05, hangup_max_wait_sec=0.2)
        call.flow.stage = "handoff"
        task, conn = await start(call, client)
        answers(client, "yes")
        conn.push("session.input_transcript.delta", delta="네 연결해 주세요")
        await until(lambda: client.live.sessions.of("refer"))
        assert client.live.sessions.of("refer")[0][2] == CFG.call.refer_target_uri
        conn.push("session.closed", reason="remote_hangup", usage=None)
        await task

    run(scenario())


def test_sideband_failure_ends_only_that_call():
    client = FakeClient()
    good = make_call(session_id="good")
    bad = make_call(session_id="bad")

    async def scenario():

        class Broken:
            async def __aenter__(self):
                raise ConnectionError("down")

            async def __aexit__(self, *a):
                return False

        original = client.live.sideband.connect
        client.live.sideband.connect = lambda *, session_id: Broken() if session_id == "bad" else original(session_id=session_id)
        task_good, conn = await start(good, client)
        await run_call(bad, client)
        assert bad.status == "ended" and bad.end_reason == "error" and bad.errors
        assert client.live.sessions.of("hangup") == [("hangup", "bad")]
        assert good.status == "active"
        conn.push("session.closed", reason="remote_hangup", usage=None)
        await task_good

    run(scenario())


def test_concurrent_calls_do_not_mix_and_slow_tool_does_not_block_others():
    client, db = FakeClient(), FakeBackend()
    calls = [make_call(db, caller=f"0101111000{i}", session_id=f"live_{i}") for i in range(5)]

    async def scenario():
        started = [await start(c, client) for c in calls]
        # 0번 통화의 백엔드가 느려도(접수 지연) 다른 통화는 진행된다

        class SlowBackend(FakeBackend):
            async def submit_result(self, body, key):
                await asyncio.sleep(0.5)
                return await db.submit_result(body, key)

        calls[0].backend = SlowBackend()
        for i, (call, (_, conn)) in enumerate(zip(calls, started)):
            call.payment_method, call.cfg = "credit", quick_cfg()
            conn.function_call("record_order", {**FULL_ORDER, "sender_phone": call.caller, "small_box_count": 0,
                                                "other_item": f"물품{i}"}, f"r{i}")
        await until(lambda: all(c.flow.stage == "confirming" for c in calls))
        answers(client, "confirm")
        for _, conn in started:
            conn.push("session.input_transcript.delta", delta="네 맞아요")
        # 판별이 끝날 때까지(판별에 쓴 말을 비우기 전에 다음 말을 넣으면 같이 지워진다)
        await until(lambda: all(c.flow.stage == "after_order" and not c.listen_tasks for c in calls))
        answers(client, "no_more")
        for _, conn in started:
            conn.push("session.input_transcript.delta", delta="없어요")
        await until(lambda: all(c.result for c in calls[1:]), timeout=0.4)
        assert not calls[0].result  # 아직 느린 백엔드 대기 중
        await until(lambda: calls[0].result)
        items = {r["body"]["call"]["providerCallId"]: r["body"]["parcels"][0]["otherItemDescription"] for r in db.results}
        assert items == {f"live_{i}": f"물품{i}" for i in range(5)}
        assert len({r["key"] for r in db.results}) == 5
        for _, conn in started:
            conn.push("session.closed", reason="remote_hangup", usage=None)
        await asyncio.gather(*(t for t, _ in started))

    run(scenario())


def test_tool_calls_in_one_call_run_in_order():
    client, call = FakeClient(), make_call()

    async def scenario():
        task, conn = await start(call, client)
        conn.function_call("record_order", {"sender_name": "첫번째"}, "a")
        conn.function_call("record_order", {"sender_name": "두번째"}, "b")
        await until(lambda: len(conn.outputs()) == 2)
        assert call.order.sender_name == "두번째"
        assert [kw["item"]["call_id"] for p, kw in conn.sent if p == "response.item.create"] == ["a", "b"]
        conn.push("session.closed", reason="remote_hangup", usage=None)
        await task

    run(scenario())


class FailingSubmit(FakeBackend):
    async def submit_result(self, body, key):
        raise RuntimeError("백엔드 실패")


def test_repeated_answer_failure_offers_handoff():
    client, call = FakeClient(), make_call(FailingSubmit())

    async def scenario():
        call.cfg = quick_cfg()
        call.flow.stage = "after_order"
        task, conn = await start(call, client)
        answers(client, "no_more")
        conn.push("session.input_transcript.delta", delta="더 없어요")
        await until(lambda: call.answer_failures == 1)
        assert conn.sent[-1][1]["content"] == call.texts.answer_error and call.flow.stage == "after_order"
        conn.push("session.input_transcript.delta", delta="없어요")
        await until(lambda: call.flow.stage == "handoff")
        await until(lambda: "안내드리기 어려운" in conn.sent[-1][1]["content"])
        conn.push("session.closed", reason="remote_hangup", usage=None)
        await task

    run(scenario())


def test_refer_failure_apologizes_then_hangs_up():
    client, call = FakeClient(), make_call()
    client.live.sessions.refer_error = RuntimeError("refer 실패")

    async def scenario():
        call.cfg = quick_cfg(hangup_silence_sec=0.05, hangup_max_wait_sec=0.2)
        call.flow.stage = "handoff"
        task, conn = await start(call, client)
        answers(client, "yes")
        conn.push("session.input_transcript.delta", delta="네 연결해 주세요")
        await until(lambda: client.live.sessions.of("hangup"))
        assert call.refer_failed and any("연결이 어렵습니다" in s[1].get("content", "") for s in conn.sent)
        conn.push("session.closed", reason="close_requested", usage=None)
        await task

    run(scenario())


def test_customer_silence_ends_call_with_goodbye():
    """SIP 종료·PBX 종료 웹훅이 모두 오지 않아도 고객 말이 없으면 마무리 인사 후 끊는다."""
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg(idle_hangup_sec=0.3, hangup_silence_sec=0.05, hangup_max_wait_sec=0.2)
        task, conn = await start(call, client)
        await until(lambda: client.live.sessions.of("hangup"))
        assert call.flow.stage == "ending" and any("무응답" in e["message"] for e in call.errors)
        conn.push("session.closed", reason="close_requested", usage=None)
        await task

    run(scenario())


def test_customer_speech_keeps_call_open():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg(idle_hangup_sec=0.3)
        answers(client, "none")
        task, conn = await start(call, client)
        for _ in range(6):
            conn.push("session.input_transcript.delta", delta="음 ")
            await asyncio.sleep(0.1)
        assert client.live.sessions.of("hangup") == []
        conn.push("session.closed", reason="remote_hangup", usage=None)
        await task

    run(scenario())


def test_heard_order_info_goes_to_backend_when_voice_model_did_not_delegate():
    """수집 단계에서 이 단계의 답이 아닌 고객 말을 음성 모델이 위임하지 않으면 서버가 백엔드에 넘긴다."""
    client, call = FakeClient(), make_call()

    async def scenario():
        cfg = quick_cfg()
        call.cfg = cfg.model_copy(update={"listener": cfg.listener.model_copy(update={"record_heard": True})})
        call.flow.stage = "collecting"
        task, conn = await start(call, client)
        conn.push("session.input_transcript.delta", delta="서울 양천구 신정이펜일로 오십이요")
        await until(lambda: any(p == "response.item.create" for p, _ in conn.sent))
        item = next(kw["item"] for p, kw in conn.sent if p == "response.item.create")
        assert item["role"] == "user" and "신정이펜일로" in item["content"][0]["text"]
        assert [p for p, _ in conn.sent if p.startswith("response.")] == ["response.item.create", "response.create"]
        # 음성 모델이 이미 위임했으면 넘기지 않는다
        conn.sent.clear()
        conn.push("session.input_transcript.delta", delta="받는 분은 김도윤이요")
        await until(lambda: call.heard_text)
        conn.push("session.delegation.created", delegation={"target": "responses"})
        await until(lambda: any(r["name"] == "listener" and r["status"] == "done" and "김도윤" in r["arguments"]
                                for r in call.tool_calls.values()))
        assert not [p for p, _ in conn.sent if p.startswith("response.")]
        conn.push("session.closed", reason="remote_hangup", usage=None)
        await task

    run(scenario())


def test_heard_talk_is_not_sent_to_backend_by_default():
    """기본은 끔: 위임된 백엔드 응답 중에 서버 요청이 끼어들어 상담원이 멈춘 통화(2026-10-29) 뒤로."""
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg()
        call.flow.stage = "collecting"
        task, conn = await start(call, client)
        conn.push("session.input_transcript.delta", delta="서울 양천구 신정이펜일로 오십이요")
        await until(lambda: any(r["name"] == "listener" and r["status"] == "done" for r in call.tool_calls.values()))
        assert not [p for p, _ in conn.sent if p.startswith("response.")]
        conn.push("session.closed", reason="remote_hangup", usage=None)
        await task

    run(scenario())
