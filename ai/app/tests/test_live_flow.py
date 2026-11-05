"""S5 통화 흐름(대본 재생): 발화 끝 Decision → 위임 함수 호출 → 되읽기 → 확인 관문 → 담기 → "없어요" → 마무리.
가짜 OpenAI(sideband·decisions)·가짜 BE. 실통화는 BACKEND_MOCK=true로 따로 시험한다."""

import asyncio
import json
import time
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
        if "origin" in names:
            answers.append(choice("origin", "no" if "다른" in said else "yes" if said[:1] in "예네" else "not_answer"))
        if "more" in names:
            answers.append(choice("more", "no_more" if "없어요" in said else "not_answer"))
        if "switch" in names:
            answers.append(choice("switch", "end" if "끊어" in said else "none"))
        return SimpleNamespace(answers=answers)


def flow(tmp_path=None):
    client = FakeClient()
    client.decisions = FakeDecisions()
    svc = service(client, utterance_gap_ms=40, commit_delay_ms=30, notify_quiet_ms=30, response_fallback_sec=0.2,
                  closing_quiet_ms=1000, closing_max_sec=3.0)
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
        await say(conn, "아니요 없어요", 11000)                       # more=no_more → 접수 완료 단계 → 결과 뒤 마무리
        await until(lambda: s.phase == Phase.CLOSING)
        assert s.result and s.close_reason == "flow_complete"         # 결과를 받은 뒤 마무리 안내
        await ai(conn, "감사합니다. 좋은 하루 보내세요.", 13000)       # 마무리 인사 뒤 끊는다
        said_t = s.last_output_t
        await task
        return s, conn, said_t

    hung = []
    hangup = client.live.sessions.hangup
    client.live.sessions.hangup = lambda sid: (hung.append(time.time()), hangup(sid))[1]
    s, conn, said_t = run(scenario())
    assert hung[0] - said_t >= 1.0  # 마무리 인사(마지막 출력) 뒤 최소 1초 기다려 끊는다
    assert svc.snapshot_errors == [] and not s.stats.get("관제 오류")  # 값이 든 중간 상태에서도 관제 스냅샷이 된다
    snap = json.loads(json.dumps(s.snapshot(), ensure_ascii=False))  # 관제 SSE·통화 기록이 직렬화할 수 있어야
    assert snap["detail"]["담은 택배"][0]["받는 분"] == "이영희" and snap["detail"]["통계"]["Decision 호출"] == 3
    assert snap["tool_calls"][0]["name"] == "record_fields" and snap["transcript"]
    assert s.state.intent == "order" and len(s.state.parcels) == 1 and s.state.no_more_parcels
    assert s.state.parcels[0].confirmed_snapshot["receiver_phone"] == "01098765432"
    db = svc.d.backend.api
    # S6: 미등록 고객 → 보내는 분 정보가 차면 등록(주소 geo가 없어 내 주소는 생략) → 결과는 고객 번호로 1번
    assert db.customers[CALLER]["name"] == "김철수" and db.customers[CALLER]["address"] is None
    [result] = db.results
    assert result["body"]["customerSeq"] == s.state.customer.customer_seq and result["body"]["pickupRequestedAt"].endswith("+09:00")
    assert result["body"]["outcome"] == "INCOMPLETE"  # 주소 보정 없이(geo 없음) — 사유 ADDRESS_GEO_MISSING
    assert s.state.customer.call_session_seq in db.analyses and db.events[s.state.customer.call_session_seq]
    closing = next(e for e in conn.sent if e["type"] == "session.commentary.append" and "closing" in e["content"])
    assert '"order"' in closing["content"] and '"pending"' not in closing["content"]  # 받은 결과 상태로 마무리
    assert "more_parcels" not in "".join(e["content"] for e in conn.sent if e["type"] == "session.thinking.append")
    assert client.hangups == ["live_1"]
    types = sent_types(conn)
    assert types.index("response.item.create") < types.index("response.create")  # 결과 뒤 재개(S0b)
    assert all(e["event_id"].startswith(s.trace_id) for e in conn.sent)
    # Decision은 고객 발화 끝마다 1번(트리거 아님), 확인 질문은 확인 대기 중에만
    names = [n for _, n in client.decisions.calls]
    assert len(names) == 3 and names[0] == ["task"] and names[1][0] == "confirm" and "confirm" not in names[2]
    assert names[2] == ["more", "switch"]
    lat = {r["구간"] for r in snap["latency"]}  # 관제 지연 표
    assert {"Decision", "위임→도구 호출", "도구 record_fields", "확인 '네'→담기", "통화 준비(accept 전)", "accept"} <= lat
    assert any(b["op"].startswith("caller_context") and b["outcome"] == "ok" for b in snap["backend_calls"])  # BE 통신


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


def test_agent_greets_first_on_session_start():
    """고객이 먼저 말하기 전에 서버가 N2로 첫 인사를 시킨다(한 번)."""
    svc, client = flow()

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: any("call_started" in e.get("content", "") for e in conn.sent))
        await ai(conn, "안녕하세요, 디바콜입니다.", 0)
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return conn

    conn = run(scenario())
    greets = [e for e in conn.sent if "call_started" in e.get("content", "")]
    assert len(greets) == 1 and greets[0]["type"] == "session.commentary.append"


def test_late_result_and_n2_wait_while_customer_is_speaking():
    """끼어들기: 고객이 말하는 동안 앞선 위임 결과로 재개(response.create)하거나 N2를 보내지 않는다. 말이 끝나면 보낸다."""
    svc, client = flow()

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await until(lambda: "session.commentary.append" in sent_types(conn))  # 첫 인사 N2
        await say(conn, "택배 보내려고요", 1000)
        conn.push({"type": "session.delegation.created", "delegation": {"id": "d1"}, "offset_ms": 2100})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.created"}})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {
            "type": "response.output_item.done", "item": {"type": "function_call", "call_id": "call_1",
                                                         "name": "record_fields",
                                                         "arguments": json.dumps({"sender_name": "김철수"})}}})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.completed"}})
        # 결과가 오는 동안 고객이 끼어들어 계속 말한다(약 0.36초). 간격은 gap 40ms보다 넉넉히 촘촘하게 —
        # Windows sleep 오차(~15ms)로 30ms 간격이 40ms를 넘어 발화가 끊긴 것으로 보이던 불안정(1/6 실패)을 막는다
        for i in range(36):
            conn.push({"type": "session.input_transcript.delta", "delta": "저기요 ", "start_ms": 3000 + i * 10,
                       "end_ms": 3000 + i * 10 + 8})
            await asyncio.sleep(0.01)
        types = sent_types(conn)
        assert "response.item.create" in types and "response.create" not in types
        notes_while_speaking = len([e for e in conn.sent if e["type"] == "session.commentary.append"])
        await until(lambda: "response.create" in sent_types(conn))  # 고객 말이 끝나면 재개
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return notes_while_speaking

    assert run(scenario()) == 1  # 고객이 말하는 동안 새 N2 없음(첫 인사만)


def test_three_unanswered_manual_searches_suggest_agent_then_reset():
    """같은 질문에 3번 연속 답을 못 드리면 상담원 권유(업무 규칙 h), 답이 나오면 0으로."""
    lf = LiveFlow.__new__(LiveFlow)
    lf.cfg = SimpleNamespace(unanswered_agent_after=3)
    s = SimpleNamespace(rt=None, note=lambda *a: None)
    miss = {"status": "ok", "code": "KB_NO_EVIDENCE", "facts": {"answerable": False}}
    hit = {"status": "ok", "facts": {"answerable": True}}
    down = {"status": "unavailable", "code": "KB_UNAVAILABLE"}
    assert "agent" not in lf._count_unanswered(s, miss)["facts"]
    lf._count_unanswered(s, hit)  # 답이 나오면 0
    assert "agent" not in lf._count_unanswered(s, miss)["facts"] and "facts" not in lf._count_unanswered(s, down)
    out = lf._count_unanswered(s, miss)
    assert out["facts"]["agent"] == "suggest" and s.rt.unanswered == 0


def _agent_flow(uri="", now=None):
    from datetime import datetime, timedelta, timezone
    lf = LiveFlow.__new__(LiveFlow)
    lf.cfg = SimpleNamespace(agent_days=(0, 1, 2, 3, 4), agent_open="09:00", agent_close="18:00", agent_transfer_uri=uri)
    spawned, refers = [], []

    async def refer(sid, target_uri):
        refers.append((sid, target_uri))

    lf.svc = SimpleNamespace(d=SimpleNamespace(client=SimpleNamespace(live=SimpleNamespace(
        sessions=SimpleNamespace(refer=refer)))))
    from app.domain.state import ConversationState
    at = now or datetime(2026, 11, 4, 10, 0, tzinfo=timezone(timedelta(hours=9)))  # 수요일 10시
    s = SimpleNamespace(state=ConversationState(), tools=SimpleNamespace(now=lambda: at), call_id="live_1", rt=None,
                        last_output_t=0.0, note=lambda *a: None, spawn=lambda coro, name: spawned.append(coro))
    return lf, s, spawned, refers


def test_agent_out_of_hours_offers_callback_in_hours_transfers_or_not_configured():
    """업무 규칙 e: 근무 시간 밖 → 콜백 제안, 안 + 전환 대상 있음 → 전환(refer), 없음 → 담당자 연락."""
    from datetime import datetime, timedelta, timezone
    night = datetime(2026, 11, 4, 20, 0, tzinfo=timezone(timedelta(hours=9)))
    lf, s, _, _ = _agent_flow(now=night)
    assert lf._agent_route(s) == {"agent": "callback_offer"} and s.state.callback_offered and s.state.agent_transferred
    lf, s, _, _ = _agent_flow()
    assert lf._agent_route(s) == {"agent": "not_configured"} and not s.state.callback_offered  # SIP URI 미준비
    lf, s, spawned, refers = _agent_flow(uri="sip:agent@pbx")
    assert lf._agent_route(s) == {"agent": "transferring"}
    run(spawned[0])  # 안내가 끝나면(여기서는 바로) 전환
    assert refers == [("live_1", "sip:agent@pbx")]


def test_callback_question_only_while_offered():
    from app.policy.render import decision_questions
    from app.tests.test_domain import P
    names = lambda **kw: [q["name"] for q in decision_questions(P, "intent", **kw)]  # noqa: E731
    assert "callback" in names(callback=True) and "callback" not in names()


def test_address_save_after_commit_one_answer_for_both():
    """담기 전에는 묻지 않고, 담은 뒤 한 번의 답으로 제안한 주소(보내는 곳·받는 곳)를 함께 정한다."""
    from app.calls.live import _save_pending
    lf = LiveFlow.__new__(LiveFlow)
    saved = []

    async def save_addresses(s, seq, snap, offer):
        saved.append(offer)

    lf.svc = SimpleNamespace(results=SimpleNamespace(save_addresses=save_addresses), call_session_seq=None)
    from app.tests.test_domain import confirm_once, filled
    st = filled()
    pid = confirm_once(st)
    spawned = []
    s = SimpleNamespace(state=st, spawn=lambda coro, name: spawned.append(coro))
    st.address_offer, st.address_consent = {"sender": True, "receiver": True}, None
    assert _save_pending(st) == ()  # 되읽기 중(담기 전)에는 저장을 묻지 않는다
    lf._maybe_save_addresses(s)
    assert not spawned
    st.address_offer = st.address_offer | {"parcel": pid}
    assert _save_pending(st) == ("sender", "receiver")
    lf._maybe_save_addresses(s)
    assert not spawned  # 답 전
    st.address_consent = False
    lf._maybe_save_addresses(s)
    assert not spawned and st.address_offer is None and _save_pending(st) == ()  # 거절 → 둘 다 버림
    st.address_offer, st.address_consent = {"sender": True, "receiver": True, "parcel": pid}, True
    lf._maybe_save_addresses(s)
    run(spawned[0])
    assert saved == [{"sender": True, "receiver": True, "parcel": pid}] and st.address_offer is None  # 둘 다 저장


def test_save_question_only_after_commit_and_blocks_more():
    """담은 뒤 N2에 저장 제안이 실리고, 저장 답을 기다리는 동안은 '더 없음'을 판정하지 않는다."""
    from app.calls.live import Spoken
    from app.domain.confirm import issue_parcel_confirmation
    from app.policy.render import decision_questions
    from app.tests.test_domain import P, filled
    from app.tests.test_results import session
    lf = LiveFlow.__new__(LiveFlow)
    lf.policy, lf.svc = P, SimpleNamespace(results=None)
    lf.cfg = SimpleNamespace(decision_min_confidence=0.6)
    sent = []

    async def notify(s, level, facts):
        sent.append((level, facts))

    lf.notify = notify
    st = filled()
    p = issue_parcel_confirmation(st, P, 100.0)
    st.address_offer, st.address_consent = {"sender": True, "receiver": True}, None
    run(lf.commit(session(st), p.id))
    [(level, facts)] = sent
    assert level == "N2" and facts["parcel_added"] and facts["address_save"] == {"sender": True, "receiver": True}
    names = lambda **kw: [q["name"] for q in decision_questions(P, "more_parcels", **kw)]  # noqa: E731
    assert names(save=True) == ["save", "switch"]  # 저장 답 대기: more 없음
    assert names() == ["more", "switch"]  # 답을 들은 뒤에는 다시 더 보낼 택배를 듣는다
    utt = Spoken(9, "네 해 주세요", 0, 500, 200.0, 200.5)
    run(lf.apply(session(st), utt, None, {"save": ("yes", 0.95, {})}, None))
    assert st.address_consent is True and st.address_offer is None  # 한 번의 답으로 둘 다


def test_order_intent_notice_carries_missing_so_first_question_follows_order():
    """운영 통화 3a0b9c7f: 접수 시작 알림이 {"intent":"order"}뿐이라 Live가 "어떤 택배" 같은 순서 밖 질문을 함."""
    svc, client = flow()

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        await ai(conn, "안녕하세요, 디바콜입니다.", 0)
        await say(conn, "택배 보내려고요", 1000)
        await until(lambda: any('"intent"' in e.get("content", "") for e in conn.sent))
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return conn

    conn = run(scenario())
    notice = next(e for e in conn.sent if '"intent"' in e.get("content", ""))
    facts = json.loads(notice["content"].split("[서버 결과] ", 1)[1])
    assert facts["intent"] == "order" and facts["summary"]["missing"][0] == "sender_name"



def test_registered_greeting_yes_prefills_sender_and_asks_receiver_first():
    """기존 고객: 인사 "○○님, {기본 주소}에서 보내시는 택배 접수 도와드릴까요?"에 "예" → 접수 + 그 출발지 →
    보내는 분 성함·주소·상세를 등록 정보(PROFILE)로 채우고 다음 질문은 받는 분 성함."""
    from app.domain.state import Source
    from backend_client.order import Geo as BGeo, Place as BPlace
    svc, client = flow()
    db = svc.d.backend.api
    db.add_customer(CALLER, "김철수", default_origin=BPlace(name="김철수", phone=CALLER, address="서울 강남구 테헤란로 212",
                                                        address_detail="1201호", geo=BGeo(jibun_address="서울 강남구 역삼동 737",
                                                                                         dong_name="역삼동", postal_code="06236")))

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await ai(conn, "안녕하세요, 김철수님, 서울 강남구 테헤란로 212에서 보내시는 택배 접수 도와드릴까요?", 0)
        await say(conn, "예", 1500)
        await until(lambda: any('"intent"' in e.get("content", "") for e in conn.sent))
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s, conn

    s, conn = run(scenario())
    assert "등록된 출발지: 서울 강남구 테헤란로 212" in client.accepted[0][1]["instructions"]
    facts = json.loads(next(e for e in conn.sent if '"intent"' in e.get("content", ""))["content"].split("[서버 결과] ", 1)[1])
    assert facts["origin"] == "prefilled" and facts["summary"]["missing"][0] == "receiver_name"
    cur = s.state.parcels[0].draft if s.state.parcels else s.state.current
    assert cur["sender_name"].source == Source.CALLER_ID  # 등록 고객 성함은 처음부터 채워져 있다
    assert all(cur[n].source == Source.PROFILE for n in ("sender_address", "sender_address_detail"))
    assert cur.sender_geo is not None and cur["sender_address_detail"].value == "1201호"


def test_origin_paths_other_place_and_recent_only():
    from app.domain.assess import readback_facts
    from app.domain.state import ConversationState, Customer, Place, Source
    from app.tests.test_domain import GEO, P
    lf = LiveFlow.__new__(LiveFlow)
    recent = Place("김철수", CALLER, "부산 해운대구 센텀로 10", "3층", GEO, Source.HISTORY)
    # 다른 곳에서 보냄 → 성함만, 다음은 보내는 곳 주소
    st = ConversationState(customer=Customer(customer_seq=12, name="김철수", caller_phone=CALLER, origin_place=recent),
                           intent="order")
    st.origin_offered, st.origin_answer = True, False
    assert lf._origin_step(st) == {"origin": "name_only"}
    assert st.current["sender_name"].source == Source.CALLER_ID and not st.current["sender_address"].valid
    # 기본 주소 없이 최근 출발지만 → 접수 시작 때 "그곳에서 보내시나요?"를 묻게 하고, 답이 오면 채운다
    st = ConversationState(customer=Customer(customer_seq=12, name="김철수", caller_phone=CALLER, origin_place=recent),
                           intent="order")
    assert lf._origin_step(st) == {"origin_confirm": "부산 해운대구 센텀로 10"} and st.origin_offered
    st.origin_answer = True
    assert lf._origin_step(st) == {"origin": "prefilled"}
    # 되읽기에는 저장된 상세주소를 넣지 않는다
    snap = {n: st.current[n].value for n in ("sender_name", "sender_address", "sender_address_detail")}
    out = readback_facts(snap, {n: f.source for n, f in st.current.fields.items()}, P)
    assert "sender_address" in out and "sender_address_detail" not in out


def test_customer_end_mid_collection_greets_then_hangs_up():
    """접수 도중 고객이 끝내면(switch=end) 기존대로 마무리 인사 뒤 끊는다(완료 단계가 아니어도)."""
    svc, client = flow()

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await say(conn, "택배 보내려고요", 1000)
        await say(conn, "그냥 끊어주세요", 2000)
        await until(lambda: s.phase == Phase.CLOSING)
        reason = s.close_reason
        await ai(conn, "감사합니다. 좋은 하루 보내세요.", 3000)
        await task
        return reason, conn

    reason, conn = run(scenario())
    assert reason == "customer_end" and client.hangups == ["live_1"]
    assert any(e["type"] == "session.commentary.append" and "closing" in e["content"] for e in conn.sent)


class SlowResults:
    """결과 전송이 끝나지 않는 가짜(마무리 결과 대기 상한 확인)."""
    def __init__(self):
        self.tasks = {}

    def start(self, s, on_result):
        self.tasks[s.call_id] = asyncio.ensure_future(asyncio.sleep(30))


def test_flow_complete_without_result_closes_with_pending_and_reminds_silent_greeting():
    """완료 단계: 결과가 상한 안에 안 오면 pending으로 마무리 인사를 시키고, AI가 말하지 않으면 1번 다시 요청한 뒤
    인사가 끝나고 최소 1초 뒤에 끊는다."""
    from app.tests.test_domain import confirm_once, filled
    client = FakeClient()
    client.decisions = FakeDecisions()
    svc = service(client, utterance_gap_ms=40, notify_quiet_ms=30, closing_quiet_ms=1000, closing_max_sec=12.0,
                  closing_result_wait_sec=0.2)
    lf = LiveFlow(svc)
    svc.results = SlowResults()
    hung = []
    hangup = client.live.sessions.hangup
    client.live.sessions.hangup = lambda sid: (hung.append(time.time()), hangup(sid))[1]

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        st = filled()
        confirm_once(st)
        s.tools.state = st
        await lf._follow(s, "no_more", None)                       # 완료 단계 → 결과 0.2초 대기 → pending 마무리
        assert s.phase == Phase.CLOSING and s.close_reason == "flow_complete"
        await until(lambda: sum("closing" in e.get("content", "") for e in conn.sent) == 2, timeout=6.0)  # 4초 무발화 → 재요청
        await ai(conn, "이용해 주셔서 감사합니다. 좋은 하루 보내세요.", 9000)
        said_t = s.last_output_t
        await task
        svc.results.tasks["live_1"].cancel()
        return conn, said_t

    conn, said_t = run(scenario())
    closings = [e["content"] for e in conn.sent if e["type"] == "session.commentary.append" and "closing" in e["content"]]
    assert len(closings) == 2 and all('"pending"' in c for c in closings)
    assert client.hangups == ["live_1"] and hung[0] - said_t >= 1.0
