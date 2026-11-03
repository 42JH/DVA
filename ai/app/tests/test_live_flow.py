"""S5 통화 흐름(대본 재생): 발화 끝 Decision → 위임 함수 호출 → 되읽기 → 확인 관문 → 담기 → "없어요" → 마무리.
가짜 OpenAI(sideband·decisions)·가짜 BE. 실통화는 BACKEND_MOCK=true로 따로 시험한다."""

import asyncio
import json
from types import SimpleNamespace

from conftest import CALLER, run

from app.calls.live import LiveFlow
from app.calls.session import Phase
from app.tests.test_calls import FakeClient, incoming, service, started, until

PICKUP = "2030-01-01T10:00:00+09:00"
FULL = {"sender_name": "김철수", "sender_address": "서울 강남구 테헤란로 212", "sender_address_detail": "1201호",
        "receiver_name": "이영희", "receiver_phone": "공일공 구팔칠육 오사삼이", "receiver_address": "부산 해운대구 센텀로 10",
        "receiver_address_detail": "", "small_box_count": 1, "item_price": 30000}


def choice(name, value, p=0.97):
    probs = [SimpleNamespace(value=value, probability=p)]
    return SimpleNamespace(type="choice", name=name, choice=value, confidence=p, probabilities=probs)


class FakeDecisions:
    def __init__(self):
        self.calls = []

    async def create(self, model, input, questions):
        names = [q["name"] for q in questions]
        self.calls.append((input, names))
        said = input.split("고객 발화: ")[1]
        answers = []
        if "confirm" in names:
            answers.append(choice("confirm", "yes" if said.startswith("네") else
                                  "proceed" if "접수해 주세요" in said else "not_answer"))
        if "task" in names:
            answers.append(choice("task", "order"))
        if "more" in names:
            answers.append(choice("more", "no_more" if "없어요" in said else "not_answer"))
        if "switch" in names:
            answers.append(choice("switch", "end" if "끊어" in said else "none"))
        return SimpleNamespace(answers=answers)


def flow(tmp_path=None):
    client = FakeClient()
    client.decisions = FakeDecisions()
    svc = service(client, utterance_gap_ms=40, commit_delay_ms=30, notify_quiet_ms=30, response_fallback_sec=0.2,
                  closing_quiet_ms=60, closing_max_sec=2.0)
    LiveFlow(svc)
    if tmp_path is not None:  # S6: 결과·인사이트까지
        from app.calls.results import ResultService
        from app.persistence.outbox import Outbox
        from app.tests.test_domain import fare
        svc.results = ResultService(svc.d.backend, Outbox(tmp_path / "outbox.sqlite3"), svc.d.policy, fare)
        svc.on_finalize.insert(0, svc.results.finish)
    return svc, client


async def say(conn, text, start_ms):
    for i, part in enumerate(text.split(" ")):
        conn.push({"type": "session.input_transcript.delta", "delta": part + " ", "start_ms": start_ms + i * 100,
                   "end_ms": start_ms + i * 100 + 90})
        await asyncio.sleep(0.005)
    await asyncio.sleep(0.12)  # 발화 끝(gap) + Decision


async def ai(conn, text, start_ms):
    conn.push({"type": "session.output_transcript.delta", "delta": text, "start_ms": start_ms,
               "end_ms": start_ms + 800})
    await asyncio.sleep(0.08)


def sent_types(conn):
    return [e["type"] for e in conn.sent]


def test_order_flow_end_to_end(tmp_path):
    svc, client = flow(tmp_path)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await ai(conn, "안녕하세요, 디바콜입니다.", 0)
        await say(conn, "택배 보내려고요", 1000)                     # task=order → 2단계 통화 등록
        await until(lambda: s.state.customer.call_session_seq)
        # 고객이 값을 말함 → Live 위임 → Backend 함수 호출
        conn.push({"type": "session.delegation.created", "delegation": {"id": "d1"}, "offset_ms": 2100})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.created"}})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {
            "type": "response.output_item.done", "item": {"type": "function_call", "call_id": "call_1",
                                                         "name": "record_fields", "arguments": json.dumps(FULL)}}})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.completed"}})
        await until(lambda: "response.create" in sent_types(conn))
        out = json.loads(next(e for e in conn.sent if e["type"] == "response.item.create")["item"]["output"])
        assert out["status"] == "ok" and out["can_proceed"] and "readback" in out["facts"]  # N1: 확인 내용
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.completed"}})
        await ai(conn, "받는 분 이영희님, 연락처 공일공 구팔칠육 오사삼이. 맞으세요?", 5000)   # 되읽기(pending 발급 뒤)
        await say(conn, "네 맞아요", 7000)                            # confirm=yes → 관문 → 확정 지연
        await until(lambda: s.state.parcels)
        await until(lambda: "session.commentary.append" in sent_types(conn))   # N2: 담기 완료
        await ai(conn, "담아 두었어요. 더 보내실 택배 있으세요?", 9000)
        await say(conn, "아니요 없어요", 11000)                       # more=no_more → 더 없음(아직 끊지 않음)
        await until(lambda: s.state.no_more_parcels)
        assert s.phase == Phase.ACTIVE
        await ai(conn, "더 궁금하신 점 있으세요?", 12000)
        await say(conn, "아니요 끊어주세요", 12500)                   # switch=end → 마무리
        await until(lambda: s.phase == Phase.CLOSING)
        await ai(conn, "감사합니다. 좋은 하루 보내세요.", 13000)       # 마무리 인사 뒤 끊는다
        await task
        return s, conn

    s, conn = run(scenario())
    assert svc.snapshot_errors == [] and not s.stats.get("관제 오류")  # 값이 든 중간 상태에서도 관제 스냅샷이 된다
    snap = json.loads(json.dumps(s.snapshot(), ensure_ascii=False))  # 관제 SSE·통화 기록이 직렬화할 수 있어야
    assert snap["detail"]["담은 택배"][0]["받는 분"] == "이영희" and snap["detail"]["통계"]["Decision 호출"] == 4
    assert snap["tool_calls"][0]["name"] == "record_fields" and snap["transcript"]
    assert s.state.intent == "order" and len(s.state.parcels) == 1 and s.state.no_more_parcels
    assert s.state.parcels[0].confirmed_snapshot["receiver_phone"] == "01098765432"
    db = svc.d.backend.api
    # S6: 미등록 고객 → 보내는 분 정보가 차면 등록(주소 geo가 없어 내 주소는 생략) → 결과는 고객 번호로 1번
    assert db.customers[CALLER]["name"] == "김철수" and db.customers[CALLER]["address"] is None
    [result] = db.results
    assert result["body"]["customerSeq"] == s.state.customer.customer_seq and "pickupRequestedAt" not in result["body"]
    assert result["body"]["outcome"] == "INCOMPLETE"  # 주소 보정 없이(geo 없음) — 사유 ADDRESS_GEO_MISSING
    assert s.state.customer.call_session_seq in db.analyses and db.events[s.state.customer.call_session_seq]
    closing = next(e for e in conn.sent if e["type"] == "session.commentary.append" and "closing" in e["content"])
    assert '"order"' in closing["content"]  # 마무리 안내에 결과 상태(사실)
    assert client.hangups == ["live_1"] and s.close_reason in ("customer_end", "close_requested")
    types = sent_types(conn)
    assert types.index("response.item.create") < types.index("response.create")  # 결과 뒤 재개(S0b)
    assert all(e["event_id"].startswith(s.trace_id) for e in conn.sent)
    # Decision은 고객 발화 끝마다 1번(트리거 아님), 확인 질문은 확인 대기 중에만
    names = [n for _, n in client.decisions.calls]
    assert len(names) == 4 and names[0] == ["task"] and names[1][0] == "confirm" and "confirm" not in names[2]
    assert names[2] == ["more", "switch"]


def test_yes_before_readback_does_not_commit():
    """Live가 서버 확인 내용 전에 되읽고 "네"를 받은 경우(S0b b1): 확인 질문을 넣지 않아 확정되지 않는다."""
    svc, client = flow()

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        s = svc.registry.calls["live_1"]
        await until(lambda: s.phase == Phase.ACTIVE)
        await say(conn, "택배 보내려고요", 1000)
        await ai(conn, "받는 분 이영희님 맞으시죠?", 3000)            # 서버 확인 내용 없음
        await say(conn, "네 맞아요", 4000)
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s

    s = run(scenario())
    assert s.state.parcels == [] and all("confirm" not in n for _, n in client.decisions.calls)


def test_tool_failure_still_returns_output_and_unverified_claim_gets_n3():
    svc, client = flow()

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        s = svc.registry.calls["live_1"]
        await until(lambda: s.phase == Phase.ACTIVE)
        conn.push({"type": "session.delegation.created", "delegation": {"id": "d1"}, "offset_ms": 100})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {
            "type": "response.output_item.done", "item": {"type": "function_call", "call_id": "c1",
                                                         "name": "cancel_order", "arguments": "{}"}}})
        await until(lambda: "response.item.create" in sent_types(conn))
        await ai(conn, "네, 접수 완료되었습니다.", 2000)              # 서버 결과 없이 접수 완료 → N3(사실 첨부)
        await until(lambda: "session.instructions.append" in sent_types(conn))
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return conn

    conn = run(scenario())
    out = json.loads(next(e for e in conn.sent if e["type"] == "response.item.create")["item"]["output"])
    assert out["code"] == "TOOL_NOT_ALLOWED"  # 서버 전용 취소는 모델이 부를 수 없다 — 그래도 결과는 돌려준다
    n3 = next(e for e in conn.sent if e["type"] == "session.instructions.append")
    assert "접수되었" in n3["content"] and n3["delegation_id"] is None and "order_submitted" in n3["content"]




def test_submit_locks_edit_and_add():
    from app.tests.test_domain import P, confirm_once, filled
    st = filled()
    confirm_once(st)
    st.no_more_parcels = True
    started = []
    lf = LiveFlow.__new__(LiveFlow)
    lf.svc = SimpleNamespace(results=SimpleNamespace(tasks={}, start=lambda s, cb: started.append(s)))
    lf.policy = P
    s = SimpleNamespace(state=st, call_id="live_1")
    lf._maybe_submit(s, force=True)
    assert started and st.order_submitted
    assert lf._edit(st) == {"order": "submitted"} and st.current is None  # 다시 열지 않는다


def test_proceed_request_without_question_reasks_confirmation_then_yes_commits(tmp_path):
    """2026-11-03 통화 512a1b: 되읽기 뒤 문의(RAG) → "그럼 접수해 주세요"가 확인 질문의 답이 아니어서 확정 못 함."""
    svc, client = flow(tmp_path)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await ai(conn, "안녕하세요, 디바콜입니다.", 0)
        await say(conn, "택배 보내려고요", 1000)
        conn.push({"type": "session.delegation.created", "delegation": {"id": "d1"}, "offset_ms": 2100})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {
            "type": "response.output_item.done", "item": {"type": "function_call", "call_id": "call_1",
                                                         "name": "record_fields", "arguments": json.dumps(FULL)}}})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.completed"}})
        await until(lambda: s.state.pending)
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.completed"}})
        await ai(conn, "받는 분 이영희님 맞으세요?", 5000)
        await ai(conn, "택배 접수는 평일 아홉 시부터 여섯 시까지입니다.", 6500)   # 문의 답(질문으로 끝나지 않음)
        await say(conn, "그럼 접수해 주세요", 8000)                    # confirm=proceed → 확정 없이 다시 묻게
        await until(lambda: any(e["type"] == "session.commentary.append" and "ask_again" in e["content"]
                                for e in conn.sent))
        assert s.state.parcels == [] and s.state.pending
        await ai(conn, "받는 분 이영희님, 이대로 접수할까요?", 9000)
        await say(conn, "네 해주세요", 10500)                          # 이제 확인 질문의 답 → 확정
        await until(lambda: s.state.parcels)
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s

    s = run(scenario())
    ask = next(e for e in client.conns[0].sent if "ask_again" in e.get("content", ""))
    assert "이영희" in ask["content"]  # 되읽을 값을 같이 준다
    assert s.decision_ms and "Decision ms P50" in s.snapshot()["detail"]["통계"]
