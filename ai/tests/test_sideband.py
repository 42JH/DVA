"""가짜 sideband로 함수 호출 결과 반환·받아쓰기·고객 말 판별·종료 타이밍·동시 통화를 확인한다.
끼어들기·정정(spec/LANGGRAPH_REBUILD.md §2.5)처럼 시각이 필요한 §8 시나리오(15~18, 20, 23~25)도 여기에 있다."""

import asyncio
import json
import time

from conftest import CFG, FULL_ORDER, FakeClient, FakeBackend, make_call, run, until
from test_flow import FakeRag, orders_db, saved_db, no_recent_db

from app.dispatcher import dispatch
from app.flow import engine
from app.listener import apply_answer
from app.progress import send_progress
from app.sideband import run_call


def quick_cfg(pause_ms=100, flow=None, **call):
    return CFG.model_copy(update={"call": CFG.call.model_copy(update=call),
                                  "listener": CFG.listener.model_copy(update={"pause_ms": pause_ms}),
                                  "flow": CFG.flow.model_copy(update={"agent_open_hour": 0, "agent_close_hour": 24,
                                                                      **(flow or {})})})


def answers(client, answer, intent="none", slot="none"):
    """판별 모델이 이 답을 돌려준다. 지난 단계의 말 판별처럼 그 답이 선택지에 없으면 none."""
    def decide(kw):
        enum = kw["text"]["format"]["schema"]["properties"]["answer"]["enum"]
        return {"answer": answer if answer in enum else "none", "intent": intent, "slot": slot}
    client.responses.decide = decide


async def start(call, client):
    task = asyncio.create_task(run_call(call, client))
    await until(lambda: call.session_id in client.live.sideband.conns and call.status == "active")
    return task, client.live.sideband.conns[call.session_id]


def thoughts(conn):
    return [kw["content"] for p, kw in conn.sent if p == "session.thinking.append"]


async def close(conn, task, reason="remote_hangup"):
    conn.push("session.closed", reason=reason, usage=None)
    await task


def to_cancel_confirm(db):
    """조회 → 박민수께 보낸 택배 → 맞음 → 취소(확인 질문까지)."""
    call = make_call(db)
    run(apply_answer(call, "lookup", "none"))
    run(dispatch(call, "lookup_orders", json.dumps({"receiver_name": "박민수"}, ensure_ascii=False), "l"))
    run(apply_answer(call, "yes", "none"))
    run(apply_answer(call, "cancel", "none"))
    assert call.flow.stage == "C_CANCEL_CONFIRM"
    return call


class SlowCancel(FakeBackend):
    delay = 0.5
    cancels = 0

    async def cancel_parcels(self, call_session_seq, order_seq, order_parcel_seqs):
        type(self).cancels += 1
        await asyncio.sleep(self.delay)
        return await super().cancel_parcels(call_session_seq, order_seq, order_parcel_seqs)


def slow_orders(delay=0.5):
    slow = orders_db(cls=SlowCancel)
    slow.delay, SlowCancel.cancels = delay, 0
    return slow


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
        await until(lambda: len(conn.sent) >= 3)
        paths = [p for p, _ in conn.sent]
        # 도구 결과의 state.next로 다음 질문이 전해지므로 같은 진행 상태를 또 보내지 않는다(두 번 말하기 방지)
        assert paths[1:] == ["response.item.create", "response.create"]
        assert conn.sent[1][1]["item"]["call_id"] == "c1"
        assert "김철수" in json.dumps(conn.outputs()[0]["state"], ensure_ascii=False)
        conn.function_call("no_such_tool", {}, "c2")  # 없는 도구여도 결과는 꼭 돌려준다
        await until(lambda: len(conn.outputs()) == 2)
        assert conn.outputs()[1]["ok"] is False
        assert [p for p, _ in conn.sent].count("response.create") == 2
        await close(conn, task)
        assert call.status == "ended" and call.end_reason == "remote_hangup"
        assert call.tool_calls["c1"]["status"] == "done"

    run(scenario())


def test_transcript_bubbles_append_to_open_bubble_of_speaker():
    client, call = FakeClient(), make_call()

    async def scenario():
        task, conn = await start(call, client)
        # 상담원이 말하는 중 고객이 "네" 하고 끼어듦(겹침) → 상담원 말풍선은 이어진다. 그 뒤 한참 있다 고객 차례
        for speaker, delta, ms in [("output", "안녕하세요 ", 0), ("input", "네 ", 300), ("output", "디바콜", 400),
                                   ("input", "택배요", 5000), ("output", "네 고객님", 8000)]:
            conn.push(f"session.{speaker}_transcript.delta", delta=delta, start_ms=ms, end_ms=ms + 200)
        await close(conn, task)
        assert [(b["speaker"], b["text"]) for b in call.transcript] == [("agent", "안녕하세요 디바콜"), ("customer", "네 택배요"),
                                                                           ("agent", "네 고객님")]

    run(scenario())


def test_customer_answer_changes_state_without_tool_call():
    client, call = FakeClient(), make_call(saved_db())

    async def scenario():
        call.cfg = quick_cfg()
        task, conn = await start(call, client)
        conn.push("session.output_transcript.delta", delta="서울 강남구 테헤란로 212에서 보내시는 택배 맞으실까요?")
        answers(client, "yes")
        conn.push("session.input_transcript.delta", delta="네 ")
        conn.push("session.input_transcript.delta", delta="맞아요")
        await until(lambda: call.flow.stage == "B_DEST_CONFIRM_Q")
        assert len(client.responses.requests) == 1  # 말이 멈춘 뒤 한 번만 판별
        req = client.responses.requests[0]
        assert "네 맞아요" in req["input"] and "보내시는 택배 맞으실까요" in req["input"]
        assert req["text"]["format"]["schema"]["properties"]["answer"]["enum"] == ["yes", "new_origin", "no", "lookup", "none"]
        assert "question" in req["text"]["format"]["schema"]["properties"]["intent"]["enum"]
        assert req["model"] == CFG.listener.model and req["store"] is False
        await until(lambda: "해운대" in thoughts(conn)[-1])
        assert conn.outputs() == []  # 백엔드 도구 호출 없음
        rec = next(t for t in call.tool_calls.values() if t["name"] == "listener")
        assert rec["total_ms"] >= rec["elapsed_ms"]  # 지연 측정: 말 끝 → 진행 상태
        await close(conn, task)

    run(scenario())


def test_stale_answer_is_discarded_when_stage_changed():
    client, call = FakeClient(), make_call(saved_db())

    async def scenario():
        call.cfg = quick_cfg()
        task, conn = await start(call, client)
        client.responses.delay = 0.3
        answers(client, "no_more")
        conn.push("session.input_transcript.delta", delta="없어요")
        await until(lambda: client.responses.requests)
        call.flow.stage = "A_CHOICE"  # 판별 중에 다른 경로로 단계가 바뀜
        await until(lambda: any(r.get("status") == "stale" for r in call.tool_calls.values()))
        await asyncio.sleep(0.4)  # 지난 단계의 말은 단계 답으로 쓰지 않고 전역 의도로만 다시 본다
        assert call.flow.stage == "A_CHOICE" and not call.hangup_requested.is_set()
        await close(conn, task)

    run(scenario())


def test_classifier_output_outside_choices_is_ignored():
    client, call = FakeClient(), make_call(no_recent_db())

    async def scenario():
        call.cfg = quick_cfg()
        task, conn = await start(call, client)
        client.responses.decide = lambda kw: {"answer": "drop_table", "intent": "none", "slot": "none"}
        conn.push("session.input_transcript.delta", delta="음")
        await until(lambda: call.errors)
        assert call.flow.stage == "HUB"
        client.responses.decide = lambda kw: "not json"
        conn.push("session.input_transcript.delta", delta="음")
        await until(lambda: len(call.errors) == 2)
        await close(conn, task)

    run(scenario())


def test_hangup_waits_for_goodbye_to_finish():
    client, call = FakeClient(), make_call(no_recent_db())

    async def scenario():
        call.cfg = quick_cfg(hangup_silence_sec=0.2, hangup_max_wait_sec=3.0)
        task, conn = await start(call, client)
        answers(client, "no_more")
        conn.push("session.input_transcript.delta", delta="없어요")
        await until(lambda: call.flow.stage == "END_CALL")
        await asyncio.sleep(0.3)
        assert client.live.sessions.of("hangup") == []  # 인사가 시작되기 전에는 끊지 않는다
        for _ in range(3):
            conn.push("session.output_audio.delta", delta="")
            await asyncio.sleep(0.05)
        t0 = time.monotonic()
        await until(lambda: client.live.sessions.of("hangup"))
        assert time.monotonic() - t0 >= 0.1
        conn.push("session.input_transcript.delta", delta="네 수고하세요")  # END_CALL에서는 판별하지 않는다
        await asyncio.sleep(0.2)
        assert len(client.responses.requests) == 1
        await close(conn, task, "close_requested")

    run(scenario())


def test_hangup_after_max_wait_even_without_speech():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg(hangup_silence_sec=0.1, hangup_max_wait_sec=0.3)
        task, conn = await start(call, client)
        answers(client, "none", "end")
        conn.push("session.input_transcript.delta", delta="그냥 끊을게요")
        await until(lambda: client.live.sessions.of("hangup"), timeout=2)
        await close(conn, task, "close_requested")

    run(scenario())


def offered(call):
    """RAG 실패 3번째: 상담원 제안까지."""
    call.rag = FakeRag()
    for i in range(3):
        run(apply_answer(call, "none", "question"))
        run(dispatch(call, "search_manual", json.dumps({"question": f"모르는 {i}"}, ensure_ascii=False), f"s{i}"))
    assert call.flow.stage == "D_AGENT_OFFER" and call.agent_offered
    return call


def test_refer_after_agent_offer_yes():
    client, call = FakeClient(), make_call(saved_db())
    call.cfg = quick_cfg(hangup_silence_sec=0.05, hangup_max_wait_sec=0.2)
    offered(call)

    async def scenario():
        task, conn = await start(call, client)
        answers(client, "yes")
        conn.push("session.input_transcript.delta", delta="네 연결해 주세요")
        await until(lambda: client.live.sessions.of("refer"))
        assert client.live.sessions.of("refer")[0][2] == CFG.call.refer_target_uri
        assert call.flow.stage == "AGENT_HANDOFF"
        await close(conn, task)

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
        await close(conn, task_good)

    run(scenario())


def test_concurrent_calls_do_not_mix_and_slow_backend_does_not_block_others():
    client, db = FakeClient(), FakeBackend()
    calls = [make_call(db, caller=f"0101111000{i}", session_id=f"live_{i}") for i in range(5)]

    async def scenario():
        for c in calls:
            c.cfg = quick_cfg()
        started = [await start(c, client) for c in calls]

        class SlowBackend(FakeBackend):
            async def submit_result(self, body, key):
                await asyncio.sleep(0.5)
                return await db.submit_result(body, key)

        calls[0].backend = SlowBackend()
        answers(client, "order")
        for _, conn in started:
            conn.push("session.input_transcript.delta", delta="택배 보내려고요")
        await until(lambda: all(c.flow.stage == "A_REGISTER_SENDER" and not c.listen_tasks for c in calls))
        for i, (call, (_, conn)) in enumerate(zip(calls, started)):
            conn.function_call("record_order", {**FULL_ORDER, "sender_phone": call.caller, "small_box_count": 0,
                                                "other_item": f"물품{i}"}, f"r{i}")
        # 결제 단계 진입은 확정 지연 뒤에(감시 작업이 COMMIT)
        await until(lambda: all(c.flow.stage == "A_CHOICE" for c in calls))
        answers(client, "no_more")
        for _, conn in started:
            conn.push("session.input_transcript.delta", delta="없어요")
        await until(lambda: all(c.result for c in calls[1:]), timeout=0.6)
        assert not calls[0].result  # 아직 느린 백엔드 대기 중
        await until(lambda: calls[0].result)
        items = {r["body"]["call"]["providerCallId"]: r["body"]["parcels"][0]["otherItemDescription"] for r in db.results}
        assert items == {f"live_{i}": f"물품{i}" for i in range(5)}
        assert len({r["key"] for r in db.results}) == 5
        for task, conn in started:
            await close(conn, task)

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
        await close(conn, task)

    run(scenario())


def test_answer_processing_failure_tells_voice_model_and_keeps_stage():
    client, call = FakeClient(), make_call(orders_db())
    call.cfg = quick_cfg()
    run(apply_answer(call, "lookup", "none"))

    async def broken(name, forgot=False):
        raise RuntimeError("처리 실패")

    call.find_orders = broken

    async def scenario():
        task, conn = await start(call, client)
        answers(client, "forgot")
        conn.push("session.input_transcript.delta", delta="기억이 안 나요")
        await until(lambda: call.texts.answer_error in thoughts(conn))
        assert call.flow.stage == "C_FIND_RECENT"
        await close(conn, task)

    run(scenario())


def test_refer_failure_apologizes_then_hangs_up():
    client, call = FakeClient(), make_call(saved_db())
    client.live.sessions.refer_error = RuntimeError("refer 실패")
    call.cfg = quick_cfg(hangup_silence_sec=0.05, hangup_max_wait_sec=0.2)
    offered(call)

    async def scenario():
        task, conn = await start(call, client)
        answers(client, "yes")
        conn.push("session.input_transcript.delta", delta="네 연결해 주세요")
        await until(lambda: client.live.sessions.of("hangup"))
        assert call.refer_failed and any("연결이 어렵습니다" in t for t in thoughts(conn))
        await close(conn, task, "close_requested")

    run(scenario())


def test_customer_silence_ends_call_with_goodbye():
    """SIP 종료·PBX 종료 웹훅이 모두 오지 않아도 고객 말이 없으면 마무리 인사 후 끊는다."""
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg(idle_hangup_sec=0.3, hangup_silence_sec=0.05, hangup_max_wait_sec=0.2)
        task, conn = await start(call, client)
        await until(lambda: client.live.sessions.of("hangup"))
        assert call.flow.stage == "END_CALL" and any("무응답" in e["message"] for e in call.errors)
        await close(conn, task, "close_requested")

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
        await close(conn, task)

    run(scenario())


def test_heard_order_info_goes_to_backend_when_voice_model_did_not_delegate():
    """접수 단계에서 이 단계의 답이 아닌 고객 말을 음성 모델이 위임하지 않으면 서버가 백엔드에 넘긴다(설정을 켰을 때)."""
    client, call = FakeClient(), make_call()

    async def scenario():
        cfg = quick_cfg()
        call.cfg = cfg.model_copy(update={"listener": cfg.listener.model_copy(update={"record_heard": True})})
        call.flow.stage = "A_REGISTER_SENDER"
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
        await close(conn, task)

    run(scenario())


def test_order_values_during_qna_return_to_order():
    """QnA·상담원 제안 중에 고객이 주문 값(다시 말한 주소 등)을 말해 기록되면 하던 접수 단계로 돌아간다
    (2026-10-31 통화: 상담원 제안 단계라 기록이 거절되고 접수로 돌아가지 못함)."""
    call = make_call()
    call.flow.stage, call.flow.task = "A_RECEIVER_HUB", "new_order"
    run(engine.apply(call, ["intent.restricted"]))
    assert call.flow.stage == "D_AGENT_OFFER"
    out = run(dispatch(call, "record_order", json.dumps({"receiver_name": "현승준"}, ensure_ascii=False), "r"))
    assert out["ok"] and call.order.receiver_name == "현승준" and call.flow.stage == "A_RECEIVER_HUB"


def test_heard_talk_is_not_sent_to_backend_by_default():
    """기본은 끔: 위임된 백엔드 응답 중에 서버 요청이 끼어들어 상담원이 멈춘 통화(2026-10-29) 뒤로."""
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg()
        call.flow.stage = "A_REGISTER_SENDER"
        task, conn = await start(call, client)
        conn.push("session.input_transcript.delta", delta="서울 양천구 신정이펜일로 오십이요")
        await until(lambda: any(r["name"] == "listener" and r["status"] == "done" for r in call.tool_calls.values()))
        assert not [p for p, _ in conn.sent if p.startswith("response.")]
        await close(conn, task)

    run(scenario())


# --- §2.5 끼어들기·정정(§8 시나리오) ---

async def at_dest_question(call, client):
    """등록 고객이 인사 질문(기존 출발지)을 다 듣고 "네"라고 해서 최근 도착지 확인 질문(B4)에 들어간 때.
    진입 시각(세션 ms)을 돌려준다."""
    task, conn = await start(call, client)
    conn.push("session.output_transcript.delta", delta="김철수님, 안녕하세요. 서울 강남구 테헤란로 212에서 보내시는 택배 맞으실까요?",
              start_ms=0, end_ms=600)
    answers(client, "yes")
    conn.push("session.input_transcript.delta", delta="네 맞아요", start_ms=700, end_ms=800)
    await until(lambda: call.flow.stage == "B_DEST_CONFIRM_Q" and not call.listen_tasks)
    return task, conn, call.flow.entered_ms


def test_15_yes_before_core_is_not_taken_and_question_is_asked_again():
    client, call = FakeClient(), make_call(saved_db())

    async def scenario():
        call.cfg = quick_cfg()
        task, conn, e = await at_dest_question(call, client)
        conn.push("session.output_transcript.delta", delta="이번에도 ", start_ms=e + 100, end_ms=e + 500)
        conn.push("session.output_transcript.delta", delta="부산 해운대구 센텀로 10로 보내시나요?",
                  start_ms=e + 500, end_ms=e + 3000)
        answers(client, "yes")
        conn.push("session.input_transcript.delta", delta="네", start_ms=e + 700, end_ms=e + 900)
        await until(lambda: any("끝까지 듣기 전" in t for t in thoughts(conn)))
        assert call.flow.stage == "B_DEST_CONFIRM_Q" and "해운대" in thoughts(conn)[-1]
        conn.push("session.input_transcript.delta", delta="네 맞아요", start_ms=e + 3500, end_ms=e + 4000)
        await until(lambda: call.flow.stage == "A_ITEM_SIZE")
        await close(conn, task)

    run(scenario())


def test_16_no_during_question_is_taken_as_no():
    client, call = FakeClient(), make_call(saved_db())

    async def scenario():
        call.cfg = quick_cfg()
        task, conn, e = await at_dest_question(call, client)
        conn.push("session.output_transcript.delta", delta="이번에도 부산", start_ms=e + 100, end_ms=e + 2500)
        answers(client, "no")
        conn.push("session.input_transcript.delta", delta="아니 그거 말고 다른 거요", start_ms=e + 600, end_ms=e + 1500)
        await until(lambda: call.flow.stage == "B_DEST_MATCH")
        assert not any("끝까지 듣기 전" in t for t in thoughts(conn))
        await close(conn, task)

    run(scenario())


def test_17_cancel_yes_then_wait_within_commit_delay_does_not_cancel():
    db = orders_db()
    client, call = FakeClient(), to_cancel_confirm(db)

    async def scenario():
        call.cfg = quick_cfg()
        task, conn = await start(call, client)
        answers(client, "yes")
        conn.push("session.input_transcript.delta", delta="네")
        await until(lambda: call.flow.pending)
        answers(client, "none", "wait")
        conn.push("session.input_transcript.delta", delta=" 아 잠깐만요")
        await until(lambda: call.flow.pending is None and not call.listen_tasks)
        await asyncio.sleep(call.cfg.flow.commit_delay_ms / 1000 + 0.2)
        assert call.flow.stage == "C_CANCEL_CONFIRM" and db.orders[1]["parcels"][0]["status"] == "ACTIVE" and not call.running_ops
        await close(conn, task)

    run(scenario())


def test_words_heard_while_answer_is_applied_are_not_lost(monkeypatch):
    """판별 결과를 적용하는(await) 사이에 붙은 말을 소비하면서 지우지 않는다(지우면 확정 지연이 멈춘 채 남았다)."""
    from app.flow import engine

    db = orders_db()
    client, call = FakeClient(), to_cancel_confirm(db)
    apply = engine.apply

    async def scenario():
        call.cfg = quick_cfg()
        task, conn = await start(call, client)

        async def apply_then_talk(ctx, events, by, *a, **kw):
            await apply(ctx, events, by, *a, **kw)
            if by == "listener" and events:  # "네" 적용 직후, 소비 전에 다음 말이 온다
                answers(client, "none", "wait")
                conn.push("session.input_transcript.delta", delta=" 아 잠깐만요")
                await asyncio.sleep(0.05)

        monkeypatch.setattr(engine, "apply", apply_then_talk)
        answers(client, "yes")
        conn.push("session.input_transcript.delta", delta="네")
        await until(lambda: len(client.responses.requests) == 2 and not call.listen_tasks)
        assert "아 잠깐만요" in client.responses.requests[1]["input"] and call.flow.pending is None
        await asyncio.sleep(call.cfg.flow.commit_delay_ms / 1000 + 0.2)
        assert db.orders[1]["parcels"][0]["status"] == "ACTIVE"
        await close(conn, task)

    run(scenario())


def test_18_customer_talk_during_cancel_does_not_stop_it_and_result_is_told():
    db = slow_orders(0.5)
    client, call = FakeClient(), to_cancel_confirm(db)

    async def scenario():
        call.cfg = quick_cfg(flow={"flush_wait_sec": 0.3})
        task, conn = await start(call, client)
        answers(client, "yes")
        conn.push("session.input_transcript.delta", delta="네 취소해 주세요")
        await until(lambda: call.flow.stage == "C_CANCEL")
        answers(client, "none", "wait")
        conn.push("session.input_transcript.delta", delta="잠깐만요")
        await until(lambda: call.flow.stage == "HUB", timeout=3)
        await until(lambda: not call.side["text"] and not call.listen_tasks, timeout=3)  # 결과 안내 뒤 판별(기다림)
        assert db.orders[1]["parcels"][0]["status"] == "CANCELLED" and SlowCancel.cancels == 1
        assert any(call.texts.say["C9"] in t for t in thoughts(conn)) and call.flow.stage == "HUB"
        await close(conn, task)

    run(scenario())


def test_20_late_tail_of_previous_answer_is_not_used_in_new_step():
    client, call = FakeClient(), make_call(saved_db())

    async def scenario():
        call.cfg = quick_cfg()
        task, conn, e = await at_dest_question(call, client)
        answers(client, "yes")  # 새 단계(B4)의 선택지에 있는 답이지만 이전 단계에서 한 말이다
        conn.push("session.input_transcript.delta", delta=" 네네", start_ms=780, end_ms=790)
        await until(lambda: any(r["call_id"].endswith("-side") and r["status"] == "done"
                                for r in call.tool_calls.values()))
        assert call.flow.stage == "B_DEST_CONFIRM_Q"
        await close(conn, task)

    run(scenario())


def test_late_tail_does_not_cancel_classification_of_new_answer():
    client, call = FakeClient(), make_call(saved_db())

    async def scenario():
        call.cfg = quick_cfg()
        task, conn, e = await at_dest_question(call, client)
        conn.push("session.output_transcript.delta", delta="이번에도 부산 해운대구 센텀로 10로 보내시나요?",
                  start_ms=e + 100, end_ms=e + 2500)
        answers(client, "yes")
        conn.push("session.input_transcript.delta", delta="네 맞아요", start_ms=e + 3000, end_ms=e + 3400)
        conn.push("session.input_transcript.delta", delta=" 그리고", start_ms=750, end_ms=790)  # 지난 단계 말의 늦은 조각
        await until(lambda: call.flow.stage == "A_ITEM_SIZE")
        await close(conn, task)

    run(scenario())


def test_23_question_during_search_is_handled_after_the_answer():
    client, call = FakeClient(), make_call(no_recent_db())

    async def scenario():
        call.cfg, call.rag = quick_cfg(flow={"flush_wait_sec": 0.3}), FakeRag()
        task, conn = await start(call, client)
        answers(client, "none", "question")
        conn.push("session.input_transcript.delta", delta="배송은 며칠 걸려요?")
        await until(lambda: call.flow.stage == "RAG" and not call.listen_tasks)
        conn.push("session.input_transcript.delta", delta="그리고 반품은 어떻게 해요?")  # 검색 중(듣지 않는 단계)
        await asyncio.sleep(0.3)
        assert call.flow.stage == "RAG" and call.side["text"]
        conn.function_call("search_manual", {"question": "배송 기간"}, "s1")
        await until(lambda: call.flow.stage == "RAG" and call.flow.history[-4]["to"] == "D_AFTER_ANSWER", timeout=3)
        assert [h["to"] for h in call.flow.history[-3:]] == ["GLOBAL_INTENT", "QNA", "RAG"]
        assert call.flow.resume == {"task": None, "stage": "HUB"}  # QnA 안에서는 덮어쓰지 않는다
        await close(conn, task)

    run(scenario())


def test_24_late_result_of_older_classification_is_ignored():
    client, call = FakeClient(), make_call(no_recent_db())

    async def scenario():
        call.cfg = quick_cfg()
        task, conn = await start(call, client)

        async def create(**kw):
            client.responses.requests.append(kw)
            first = len(client.responses.requests) == 1
            await asyncio.sleep(0.5 if first else 0)
            return type("R", (), {"output_text": json.dumps(
                {"answer": "order" if first else "lookup", "intent": "none", "slot": "none"})})()

        client.responses.create = create
        conn.push("session.input_transcript.delta", delta="네")
        await until(lambda: client.responses.requests)
        conn.push("session.input_transcript.delta", delta=" 아니 조회요")
        await until(lambda: call.flow.stage == "C_FIND_RECENT")
        await until(lambda: any(r["status"] == "stale" for r in call.tool_calls.values()), timeout=2)
        assert call.flow.stage == "C_FIND_RECENT"
        await close(conn, task)

    run(scenario())


def test_25_call_ending_during_write_waits_for_its_result():
    db = slow_orders(1.0)
    client, call = FakeClient(), to_cancel_confirm(db)

    async def scenario():
        # 확정(말 끝 + 0.1 + 0.7초) 뒤, 취소가 끝나기(+1.0초) 전에 무응답 종료(1.4초)가 오게
        call.cfg = quick_cfg(idle_hangup_sec=1.4, hangup_silence_sec=0.05, hangup_max_wait_sec=0.2)
        task, conn = await start(call, client)
        answers(client, "yes")
        conn.push("session.input_transcript.delta", delta="네")
        await until(lambda: call.flow.stage == "C_CANCEL")
        await until(lambda: call.flow.stage == "END_CALL", timeout=3)
        moves = [(h["to"], h["event"]) for h in call.flow.history[-2:]]
        assert moves == [("HUB", "cancel.done"), ("END_CALL", "call.ending")]  # 결과를 기록한 뒤 종료
        assert [op["status"] for op in call.running_ops.values()] == ["done"]
        await until(lambda: client.live.sessions.of("hangup"))
        await close(conn, task, "close_requested")

    run(scenario())


def test_write_in_progress_is_finished_when_session_closes():
    db = slow_orders(0.4)
    client, call = FakeClient(), to_cancel_confirm(db)

    async def scenario():
        call.cfg = quick_cfg()
        task, conn = await start(call, client)
        answers(client, "yes")
        conn.push("session.input_transcript.delta", delta="네")
        await until(lambda: SlowCancel.cancels == 1)
        await close(conn, task)  # 고객이 끊어도 실행 중인 취소는 결과까지 기록
        assert [op["status"] for op in call.running_ops.values()] == ["done"]
        assert db.orders[1]["parcels"][0]["status"] == "CANCELLED"

    run(scenario())


def test_commit_fires_after_delay_and_fare_notice_is_sent_first():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg()
        task, conn = await start(call, client)
        answers(client, "order")
        conn.push("session.input_transcript.delta", delta="택배요")
        await until(lambda: call.flow.stage == "A_REGISTER_SENDER")
        conn.function_call("record_order", FULL_ORDER, "r1")
        await until(lambda: call.flow.pending and conn.outputs())
        nxt = conn.outputs()[-1]["state"]["next"]  # 기다리는 동안 새 질문 없음(방금 받은 번호 확인만)
        assert nxt.endswith(call.texts.note["COMMIT_WAIT"]) and "010-9876-5432" in nxt
        await until(lambda: call.flow.stage == "A_CHOICE" and call.texts.say["A8"] in thoughts(conn)[-1])
        last = thoughts(conn)[-1]  # 확정 뒤 운임 → 결제 → 추가 접수 질문을 한 진행 상태로 차례대로
        assert last.index("운임은 4,000원이에요") < last.index(call.texts.say["PAY_BILLING"]) < last.index(call.texts.say["A8"])
        # 고객 말 없이 서버가 옮겼으므로 말하게도 한다(thinking.append만으로는 다음 고객 말까지 말하지 않아 멈춤)
        spoken = [kw["content"] for p, kw in conn.sent if p == "session.commentary.append"]
        assert spoken and call.texts.say["A8"] in spoken[-1]
        await close(conn, task)

    run(scenario())


def test_rag_wait_times_out_as_no_answer():
    client, call = FakeClient(), make_call(saved_db())

    async def scenario():
        call.cfg = quick_cfg(flow={"rag_wait_sec": 0.3})
        task, conn = await start(call, client)
        answers(client, "none", "question")
        conn.push("session.input_transcript.delta", delta="해외 배송 되나요?")
        await until(lambda: call.flow.stage == "D_AGENT_OFFER" and call.texts.say["D5"] in thoughts(conn)[-1],
                    timeout=2)  # 검색 결과가 오지 않음
        assert call.fail_count == 1
        await close(conn, task)

    run(scenario())


def test_search_result_before_classification_is_not_handled_twice():
    client, call = FakeClient(), make_call(saved_db())

    async def scenario():
        call.cfg, call.rag = quick_cfg(), FakeRag()
        task, conn = await start(call, client)
        client.responses.delay = 0.3  # 판별이 늦다
        answers(client, "none", "question")
        conn.push("session.input_transcript.delta", delta="배송은 며칠 걸려요?")
        await until(lambda: client.responses.requests)
        conn.function_call("search_manual", {"question": "배송 기간"}, "s1")  # 음성 모델이 먼저 위임
        await until(lambda: call.flow.stage == "D_AFTER_ANSWER")
        await until(lambda: not call.listen_tasks)
        assert call.flow.stage == "D_AFTER_ANSWER"  # 같은 질문으로 RAG에 다시 들어가지 않는다
        await close(conn, task)

    run(scenario())


def test_goodbye_to_unclassified_no_more_is_not_corrected():
    """고객이 "더 없어요"라고 해서 음성 모델이 판별보다 먼저 인사해도, 판별 결과 END_CALL이면 바로잡지 않는다."""
    client, call = FakeClient(), make_call(no_recent_db())

    async def scenario():
        call.cfg = quick_cfg()
        task, conn = await start(call, client)
        client.responses.delay = 0.3
        answers(client, "no_more")
        conn.push("session.input_transcript.delta", delta="더 없어요")
        await asyncio.sleep(0.15)
        conn.push("session.output_transcript.delta", delta="네, 이용해 주셔서 감사합니다. 좋은 하루 보내세요.")
        await until(lambda: call.flow.stage == "END_CALL")
        await asyncio.sleep(0.3)
        assert not any(p == "session.instructions.append" for p, _ in conn.sent)
        await close(conn, task)

    run(scenario())


def test_voice_model_goodbye_outside_end_call_is_corrected_once():
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg()
        task, conn = await start(call, client)
        for _ in range(2):
            conn.push("session.output_transcript.delta", delta="이용해 주셔서 감사합니다. 좋은 하루 보내세요.")
        await until(lambda: any(p == "session.instructions.append" for p, _ in conn.sent))
        await asyncio.sleep(0.1)
        fixes = [kw for p, kw in conn.sent if p == "session.instructions.append"]
        assert len(fixes) == 1 and fixes[0]["content"] == call.texts.drift_fix and fixes[0]["delegation_id"] is None
        await close(conn, task)

    run(scenario())


def test_progress_waits_while_customer_is_speaking():
    """고객이 말하는 중에는 진행 상태를 미뤘다가 말이 멈추면 보낸다(음성 모델이 고객 말 위로 말하지 않게)."""
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg()
        task, conn = await start(call, client)
        before = len(thoughts(conn))
        conn.push("session.input_transcript.delta", delta="어 잠깐")  # 고객이 말하는 중
        await until(lambda: call.customer_said_at)
        call.flow.notice.append("CORRECTED")  # 진행 상태가 바뀔 일이 생김
        call.corrected = ("receiver_phone", "01011112222")
        async with call.lock:
            call.customer_said_at = time.monotonic()  # 방금도 말함(말 멈춤 대기 안)
            await send_progress(call, conn)
        assert call.progress_due and len(thoughts(conn)) == before
        await until(lambda: not call.progress_due, timeout=3)  # 말이 멈추면 보낸다
        assert len(thoughts(conn)) == before + 1 and "01011112222" in thoughts(conn)[-1]
        await close(conn, task)

    run(scenario())


def test_heard_speech_is_consumed_even_without_answer():
    """답·용건이 없던 말도 판별에 썼으면 비운다. 남기면 다음 말에 붙어 오판된다(2026-10-31: "저 말투가 그렇죠"가 다음
    주소 답에 붙어 제한된 요청으로 판별됨)."""
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg()
        answers(client, "none")
        task, conn = await start(call, client)
        conn.push("session.input_transcript.delta", delta="저 말투가 그렇죠")
        await until(lambda: any(r["name"] == "listener" and r["status"] == "done" for r in call.tool_calls.values()))
        assert call.heard_text == ""
        await close(conn, task)

    run(scenario())


def test_agent_speaking_until_output_transcript_end_passes():
    """상담원 음성이 아직 나가는 중(출력 받아쓰기의 끝 시각이 지금보다 뒤)이면 진행 상태를 미룬다(말 겹침 방지)."""
    from app.progress import agent_speaking
    call = make_call()
    call.observe_clock(1000)  # 세션 타임라인 1초 = 지금
    call.last_output_at = time.monotonic()  # 음성 출력 이벤트는 말하지 않을 때도 와서 기준이 아니다
    call.agent_deltas = [("운임은", 500, call.now_ms() + 2000)]
    assert agent_speaking(call)
    call.agent_deltas = [("운임은", 500, call.now_ms() - 10)]
    assert not agent_speaking(call)
    call.agent_text_at = time.monotonic()  # 출력 받아쓰기 조각이 방금 옴
    assert agent_speaking(call)


def test_correction_is_sent_to_backend_when_voice_model_did_not_delegate():
    """말 중간·직후 정정("아니요, 현승준이요")은 음성 모델이 넘기지 않았으면 서버가 백엔드에 넘긴다(record_heard 설정과
    상관없이). 2026-10-31 통화: 말로만 받고 넘기지 않아 틀린 이름으로 접수됨."""
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg()
        call.flow.stage, call.flow.task = "A_RECEIVER_HUB", "new_order"
        call.order.sender_name = "현승우"
        answers(client, "none", intent="correction", slot="sender_name")
        task, conn = await start(call, client)
        conn.push("session.input_transcript.delta", delta="아니요, 현승준이요")
        await until(lambda: any(p == "response.item.create" for p, _ in conn.sent))
        item = next(kw["item"] for p, kw in conn.sent if p == "response.item.create")
        assert "현승준" in item["content"][0]["text"]
        await close(conn, task)

    run(scenario())


def test_listener_retries_once_on_timeout():
    """판별이 시간 초과면 같은 말을 한 번 더 판별한다(정정 판별이 시간 초과로 버려지던 것)."""
    client, call = FakeClient(), make_call()
    calls = []

    def decide(kw):
        calls.append(1)
        if len(calls) == 1:
            raise TimeoutError
        enum = kw["text"]["format"]["schema"]["properties"]["answer"]["enum"]
        return {"answer": "order" if "order" in enum else "none", "intent": "none", "slot": "none"}

    async def scenario():
        call.cfg = quick_cfg()
        client.responses.decide = decide
        task, conn = await start(call, client)
        conn.push("session.input_transcript.delta", delta="택배 접수할게요")
        await until(lambda: call.flow.stage == "A_REGISTER_SENDER")
        assert len(calls) == 2
        await close(conn, task)

    run(scenario())


def test_listener_records_token_usage():
    """판별 기록에 토큰 수(입력·출력·추론)를 남긴다(시간 초과 원인이 추론량인지 보려고)."""
    from types import SimpleNamespace
    from app.listener import _usage
    resp = SimpleNamespace(usage=SimpleNamespace(input_tokens=310, output_tokens=40,
                                                 output_tokens_details=SimpleNamespace(reasoning_tokens=28)))
    assert _usage(resp) == {"input": 310, "output": 40, "reasoning": 28}
    assert _usage(SimpleNamespace()) is None


def test_clock_uses_customer_transcripts_only():
    """상담원 받아쓰기는 음성보다 먼저 와 끝 시각이 미래라 시계 추정에 쓰지 않는다(쓰면 시계가 앞서 나가 말 겹침 판단이 틀림)."""
    call = make_call()
    call.add_transcript("agent", "안녕하세요", 0, 60_000)
    assert call.clock_offset is None
    call.add_transcript("customer", "네", 1000, 1500)
    assert call.clock_offset is not None and abs(call.now_ms() - 1500) < 200


def test_backend_state_is_updated_when_state_changes():
    """상태가 바뀔 때마다 백엔드 지시문 끝의 "지금 상태"를 session.update로 갱신한다(바뀌지 않으면 보내지 않음).
    백엔드가 단계를 몰라 get_state부터 부르거나 엉뚱한 도구를 고르던 것(2026-10-31 실측)."""
    client, call = FakeClient(), make_call()

    async def scenario():
        call.cfg = quick_cfg()
        call.backend_instructions = "백엔드 지시문"
        task, conn = await start(call, client)
        updates = lambda: [kw["session"] for p, kw in conn.sent if p == "session.update"]  # noqa: E731
        await until(lambda: updates())
        first = updates()[-1]["delegation"]
        assert first["type"] == "responses" and first["responses"]["instructions"].startswith("백엔드 지시문")
        assert "A_NEW_ORDER" in first["responses"]["instructions"]
        answers(client, "order")
        conn.push("session.input_transcript.delta", delta="택배요")
        await until(lambda: call.flow.stage == "A_REGISTER_SENDER" and "A_REGISTER_SENDER" in json.dumps(
            updates()[-1], ensure_ascii=False))
        count = len(updates())
        await send_progress(call, conn)  # 상태가 그대로면 다시 보내지 않는다
        from app.progress import update_backend
        await update_backend(call, conn)
        assert len(updates()) == count
        await close(conn, task)

    run(scenario())
