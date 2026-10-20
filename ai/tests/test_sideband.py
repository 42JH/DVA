"""가짜 sideband로 함수 호출 결과 반환·받아쓰기·종료 타이밍·동시 통화를 확인한다."""

import asyncio
import time

from conftest import CFG, FULL_ORDER, FakeClient, FakeDB, make_call, run, until

from app.sideband import run_call


def quick_cfg(**call):
    return CFG.model_copy(update={"call": CFG.call.model_copy(update=call)})


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


def test_hangup_waits_for_goodbye_to_finish():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg(hangup_silence_sec=0.2, hangup_max_wait_sec=3.0)
        call.flow.stage = "after_order"
        task, conn = await start(call, client)
        conn.function_call("end_call", {"customer_confirmed": True}, "c1")
        await until(lambda: conn.outputs())
        await asyncio.sleep(0.3)
        assert client.live.sessions.of("hangup") == []  # 인사가 시작되기 전에는 끊지 않는다
        for _ in range(3):
            conn.push("session.output_audio.delta", delta="")
            await asyncio.sleep(0.05)
        t0 = time.monotonic()
        await until(lambda: client.live.sessions.of("hangup"))
        assert time.monotonic() - t0 >= 0.1
        conn.push("session.closed", reason="close_requested", usage=None)
        await task

    run(scenario())


def test_hangup_after_max_wait_even_without_speech():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg(hangup_silence_sec=0.1, hangup_max_wait_sec=0.3)
        call.flow.stage = "after_order"
        task, conn = await start(call, client)
        conn.function_call("end_call", {"customer_confirmed": True}, "c1")
        await until(lambda: client.live.sessions.of("hangup"), timeout=2)
        conn.push("session.closed", reason="close_requested", usage=None)
        await task

    run(scenario())


def test_refer_after_transfer():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg(hangup_silence_sec=0.05, hangup_max_wait_sec=0.2)
        call.flow.stage = "handoff"
        task, conn = await start(call, client)
        conn.function_call("transfer_to_agent", {"customer_confirmed": True}, "c1")
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
    client, db = FakeClient(), FakeDB()
    calls = [make_call(db, caller=f"0101111000{i}", session_id=f"live_{i}") for i in range(5)]

    async def scenario():
        started = [await start(c, client) for c in calls]
        # 0번 통화의 DB가 느려도(접수 지연) 다른 통화는 진행된다

        class SlowDB(FakeDB):
            async def insert_order(self, *a, **k):
                await asyncio.sleep(0.5)
                return await db.insert_order(*a, **k)

        calls[0].db = SlowDB()
        for i, (call, (_, conn)) in enumerate(zip(calls, started)):
            conn.function_call("record_order", {**FULL_ORDER, "item": f"물품{i}"}, f"r{i}")
        await until(lambda: all(c.flow.stage == "confirming" for c in calls))
        for _, conn in started:
            conn.function_call("confirm_order", {"answer": "confirm", "customer_confirmed": True}, "k")
        await until(lambda: all(c.submitted for c in calls[1:]), timeout=0.4)
        assert not calls[0].submitted  # 아직 느린 DB 대기 중
        await until(lambda: calls[0].submitted)
        items = {o["session_id"]: o["item"] for o in db.orders}
        assert items == {f"live_{i}": f"물품{i}" for i in range(5)}
        assert len({o["order_no"] for o in db.orders}) == 5
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
