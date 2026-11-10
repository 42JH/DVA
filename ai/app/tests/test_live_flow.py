"""S5 통화 흐름(대본 재생): 발화 끝 Decision → 위임 함수 호출 → 되읽기 → 확인 관문 → 담기 → "없어요" → 마무리.
가짜 OpenAI(sideband·decisions)·가짜 BE. 실통화는 BACKEND_MOCK=true로 따로 시험한다."""

import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
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
            if said.startswith("음"):  # 애매한 '네'(운영 통화 b8f3795c "아 그렇게 접수해줘" yes 0.56)
                answers.append(choice("confirm", "yes", 0.56))
            else:
                answers.append(choice("confirm", "yes" if said.startswith("네") else "no" if said.startswith("아니") else
                                      "change" if "바꿔" in said else
                                      "proceed" if "접수해 주세요" in said else "not_answer"))
        if "task" in names:
            answers.append(choice("task", "inquiry" if "궁금" in said else "order"))
        if "origin" in names:
            answers.append(choice("origin", "no" if "다른" in said else "yes" if said[:1] in "예네" else "not_answer"))
        if "more" in names:
            answers.append(choice("more", "no_more" if "없어요" in said else "not_answer"))
        if "switch" in names:
            answers.append(choice("switch", "end" if "끊어" in said else "agent" if "상담원 연결" in said else "none"))
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


def test_item_restriction_from_transcript_without_a_model_tool_call(tmp_path):
    from app.tests.test_domain import confirm_once, filled

    svc, client = flow(tmp_path)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await say(conn, "폭죽을 보내려고요", 1000)
        await until(lambda: s.state.current and "dangerous_goods" in s.state.current.item_issues)
        await until(lambda: s.state.customer.call_session_seq)
        s.tools.state = filled()
        confirm_once(s.state)
        await say(conn, "아까 박스 안에 라이터도 있어요", 3000)
        assert s.state.current.item_issues["flammables"].code == "ITEM_MENTION_UNCLEAR"
        assert not s.tool_calls
        await say(conn, "전화 끊어 주세요", 5000)
        await until(lambda: s.phase == Phase.CLOSING)
        await ai(conn, "감사합니다.", 7000)
        await task
        [result] = svc.d.backend.api.results
        assert result["body"]["outcome"] == "INCOMPLETE" and not result["body"].get("parcels")

    run(scenario())


@pytest.mark.parametrize(("readback", "answer", "answer_at"), [
    ("받는 분 이영희님, 연락처 공일공 구팔칠육 오사삼이. 맞으세요?", "네 맞아요", 7000),
    ("변경된 받는 분은 이영희님입니다. 이대로 접수할까요?", "어 접수해 주세요", 7000),
    ("변경된 받는 분은 이영희님이고, 연락처는", "어 접수해 주세요", 5300),
])
def test_order_flow_end_to_end(tmp_path, readback, answer, answer_at):
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
        assert "readback_id" not in out["facts"]
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.completed"}})
        await ai(conn, readback, 5000)
        assert s.rt.ai[-1].readback_id == s.state.pending.id
        await say(conn, answer, answer_at)
        await until(lambda: s.state.parcels)
        assert not any(event["kind"] == "확인 다시 묻기" for event in s.events)
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
    s = SimpleNamespace(state=st, call_id="live_1", tools=SimpleNamespace(draft_intake=False))
    lf._maybe_submit(s, force=True)
    assert started and st.order_submitted
    assert lf._edit(s) == {"order": "submitted"} and st.current is None  # 다시 열지 않는다


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
        await ai(conn, "다시 확인할 내용은 받는 분 이영희님이고,", 9000)
        assert s.rt.ai[-1].readback_id == s.state.pending.id
        await say(conn, "어 접수해 주세요", 9300)                     # 서버가 다시 준 되읽기 도중 명확한 접수 요청
        await until(lambda: s.state.parcels)
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s

    s = run(scenario())
    ask = next(e for e in client.conns[0].sent if "ask_again" in e.get("content", ""))
    assert "이영희" in ask["content"]  # 되읽을 값을 같이 준다
    assert s.decision_ms and "Decision ms P50" in s.snapshot()["detail"]["통계"]


def test_unclear_yes_reasks_each_time_then_clear_yes_commits(tmp_path):
    """운영 통화 b8f3795c: 애매한 '네'(yes 0.56)는 확정하지 않고 Live에 아무것도 안 보내 32초 멈춘 뒤 무음 종료.
    이제 확정 없이 다시 묻게 하고(두 번째 애매한 답에도), 분명한 '네'에 확정한다."""
    svc, client = flow(tmp_path)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await say(conn, "택배 보내려고요", 1000)
        conn.push({"type": "session.delegation.created", "delegation": {"id": "d1"}, "offset_ms": 2100})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {
            "type": "response.output_item.done", "item": {"type": "function_call", "call_id": "call_1",
                                                         "name": "record_fields", "arguments": json.dumps(FULL)}}})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.completed"}})
        await until(lambda: s.state.pending)
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.completed"}})
        asks = lambda: [e for e in conn.sent if e["type"] == "session.commentary.append" and "ask_again" in e["content"]]  # noqa: E731
        await ai(conn, "받는 분 이영희님, 이대로 접수할까요?", 5000)
        await say(conn, "음 그렇게 해줘", 6500)
        await until(lambda: len(asks()) == 1)
        await ai(conn, "받는 분 이영희님, 이대로 접수할까요?", 7500)
        await say(conn, "음 그렇게 해줘", 9000)
        await until(lambda: len(asks()) == 2)  # 같은 내용이어도 다시 묻는다
        assert s.state.parcels == [] and s.state.pending
        await ai(conn, "받는 분 이영희님, 이대로 접수할까요?", 10000)
        await say(conn, "네 해주세요", 11500)
        await until(lambda: s.state.parcels)
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s

    s = run(scenario())
    assert len(s.state.parcels) == 1


async def _collect_full(conn, s):
    """접수 값 전부 기록(d1) → 확인 대기까지."""
    await say(conn, "택배 보내려고요", 1000)
    conn.push({"type": "session.delegation.created", "delegation": {"id": "d1"}, "offset_ms": 2100})
    conn.push({"type": "response.event", "delegation_id": "d1", "event": {
        "type": "response.output_item.done", "item": {"type": "function_call", "call_id": "call_1",
                                                     "name": "record_fields", "arguments": json.dumps(FULL)}}})
    conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.completed"}})
    await until(lambda: s.state.pending)
    conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.completed"}})


def _asks(conn):
    return [e for e in conn.sent if e["type"] == "session.commentary.append" and "ask_again" in e["content"]]


def test_change_then_rejected_fix_then_plain_answer_reopens_readback_and_yes_commits(tmp_path):
    """운영 통화 56c133c8: 되읽기 뒤 '바꿔 주세요'(change)로 확인 대기를 풀고, 정정 위임은 수거 시각 거절(needs)이라
    대기를 다시 열지 않음. 다음 답의 위임이 도구 없이 끝나자 Live가 스스로 확인 질문을 했고 '네'가 갈 곳이 없어 무음 종료.
    이제 도구 없이 끝난 위임 뒤 서버 되읽기(ask_again)로 대기를 다시 열고, 그 뒤 '네'에 확정한다."""
    svc, client = flow(tmp_path)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await _collect_full(conn, s)
        await ai(conn, "받는 분 이영희님, 이대로 접수할까요?", 5000)
        await say(conn, "승용차로 바꿔 주세요", 6500)                         # confirm=change → 대기 해제
        await until(lambda: s.state.pending is None)
        assert s.state.awaiting_fix
        conn.push({"type": "session.delegation.created", "delegation": {"id": "d2"}, "offset_ms": 6500})
        conn.push({"type": "response.event", "delegation_id": "d2", "event": {
            "type": "response.output_item.done", "item": {"type": "function_call", "call_id": "call_2", "name": "record_fields",
                                                         "arguments": json.dumps({"client_comment": "승용차",
                                                                                  "pickup_at": "2000-01-01T09:00:00+09:00"})}}})
        conn.push({"type": "response.event", "delegation_id": "d2", "event": {"type": "response.completed"}})
        await until(lambda: any(c["name"] == "record_fields" and c["status"] not in ("실행 중", "ok") for c in s.tool_calls))
        conn.push({"type": "response.event", "delegation_id": "d2", "event": {"type": "response.completed"}})
        await asyncio.sleep(0.15)
        assert s.state.pending is None and not _asks(conn) and not s.state.awaiting_fix  # 거절(needs) 위임엔 되읽기를 얹지 않음
        await ai(conn, "오전 열 시 이후로 괜찮으신가요?", 8000)
        await say(conn, "그렇게 해요", 9500)                                   # confirm=not_answer
        conn.push({"type": "session.delegation.created", "delegation": {"id": "d3"}, "offset_ms": 9500})
        conn.push({"type": "response.event", "delegation_id": "d3", "event": {"type": "response.completed"}})  # 도구 없음
        await until(lambda: len(_asks(conn)) == 1)                             # 서버 되읽기로 대기를 다시 연다
        assert s.state.pending and s.state.parcels == []
        await ai(conn, "받는 분 이영희님, 이대로 접수할까요?", 11000)
        await say(conn, "네 해주세요", 12500)
        await until(lambda: s.state.parcels)
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s

    s = run(scenario())
    assert len(s.state.parcels) == 1 and s.state.parcels[0].confirmed_snapshot["client_comment"] == "승용차"


def test_no_answer_waits_for_fix_without_rereading_then_fix_reopens(tmp_path):
    """'아니요' 직후 도구 없이 끝난 위임(Live가 어디를 고칠지 물음)에는 되읽기를 다시 열지 않고,
    고친 값이 기록되면 record_fields가 새 되읽기를 준다."""
    svc, client = flow(tmp_path)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await _collect_full(conn, s)
        await ai(conn, "받는 분 이영희님, 이대로 접수할까요?", 5000)
        await say(conn, "아니요 틀렸어요", 6500)                               # confirm=no
        await until(lambda: s.state.pending is None)
        conn.push({"type": "session.delegation.created", "delegation": {"id": "d2"}, "offset_ms": 6500})
        conn.push({"type": "response.event", "delegation_id": "d2", "event": {"type": "response.completed"}})  # 도구 없음
        await asyncio.sleep(0.15)
        assert s.state.pending is None and not _asks(conn)                    # 고칠 값을 기다린다
        conn.push({"type": "session.delegation.created", "delegation": {"id": "d3"}, "offset_ms": 8000})
        conn.push({"type": "response.event", "delegation_id": "d3", "event": {
            "type": "response.output_item.done", "item": {"type": "function_call", "call_id": "call_3", "name": "record_fields",
                                                         "arguments": json.dumps({"receiver_name": "박영희"})}}})
        conn.push({"type": "response.event", "delegation_id": "d3", "event": {"type": "response.completed"}})
        await until(lambda: s.state.pending)
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s

    s = run(scenario())
    assert s.state.pending.snapshot["receiver_name"] == "박영희" and not s.state.awaiting_fix
    assert s.tool_calls[-1]["output"]["facts"]["readback"]["receiver_name"] == "박영희"


def test_cancel_reask_carries_cancel_target_not_parcel_readback():
    from app.domain.confirm import issue_cancel_confirmation
    from app.tests.test_domain import P, filled
    from app.tests.test_results import session
    sent = []

    async def notify(s, level, facts, again=False):
        sent.append((level, facts, again))

    lf = LiveFlow.__new__(LiveFlow)
    lf.policy, lf.notify = P, notify
    st = filled()  # 받던 택배가 있어도 취소 확인이면 택배 되읽기를 주지 않는다
    st.selected_order = {"receiver_name": "홍길동", "status": "COLLECTING", "order_seq": 1, "order_parcel_seq": 2}
    p = issue_cancel_confirmation(st, 100.0)
    run(lf._follow(session(st), "ask_confirm", p.id))
    [(level, facts, again)] = sent
    assert level == "N2" and again and facts["confirmation"] == "ask_again" and "readback" not in facts
    assert facts["cancel_target"]["receiver_name"] == "홍길동"


@pytest.mark.parametrize("answer", ["yes", "no"])
def test_box_proposal_uses_separate_confirmation(answer):
    from app.calls.live import Spoken
    from app.domain.state import Items
    from app.policy.render import decision_questions
    from app.tests.test_domain import P, filled
    from app.tests.test_results import session
    from app.tools import run_tool

    svc, _ = flow()
    lf = LiveFlow(svc)
    st = filled()
    st.clear("items")
    st.clear("item_price")
    s = session(st)
    s.tools.clock = lambda: 100

    async def scenario():
        s.tools.item_utterance = (1, "냉장고 하나 보내려고요")
        old = await run_tool(s.tools, "record_fields", json.dumps({"item_evidence": [
            {"rule": "format", "quote": "냉장고 하나", "status": "included"}]}), "unfounded-format")
        assert old["code"] == "ITEM_UNSPECIFIED" and not st.current.item_issues
        st.record("items", Items(document_count=10))
        s.tools.item_utterance = (2, "신발 한 켤레 보내려고요")
        result = await run_tool(s.tools, "record_fields", json.dumps({"box_suggestion": {
            "size": "small", "count": 1, "quote": "신발 한 켤레"}}), "box-suggest")
        assert result["facts"]["box_proposal"]["label"] == "소형 박스 1개"
        assert result["missing"] == ["items", "item_price"] and result["box_size_pending"]
        assert st.current["items"].value == Items(document_count=10)
        assert st.pending is None
        box = st.current.box_proposal
        questions = decision_questions(P, "item", box_label=box.label)
        assert [q["name"] for q in questions] == ["box", "switch"]
        reply = Spoken(3, "네" if answer == "yes" else "아니요", 1800, 1900, 102, 103)
        unrelated = Spoken(1, "잠시 기다려 주시겠어요?", 1100, 1500, 101, 101)
        await lf.apply(s, reply, unrelated, {"box": (answer, 1.0)}, None, box=box)
        assert st.current.box_proposal is box
        question = Spoken(1, "소형 박스 한 개 정도로 보면 될까요?", 1100, 1500, 101, 101)
        await lf.apply(s, reply, question, {"box": (answer, 1.0)}, None, box=box)
        assert st.current.box_proposal is None and st.pending is None and not st.parcels
        if answer == "yes":
            assert st.current["items"].value == Items(document_count=10, small_box_count=1)
            assert any((e.get("data") or {}).get("content", {}).get("summary", {}).get("missing") == ["item_price"]
                       for e in s.events)
        else:
            assert st.current.box_size_pending and st.current["items"].value == Items(document_count=10)
            assert any((e.get("data") or {}).get("content", {}).get("box_proposal_declined") for e in s.events)

    run(scenario())


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
    """매뉴얼 검색이 3번 연속 실패하면 상담원 권유, 성공하면 0으로."""
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


@pytest.mark.parametrize(("customer_request", "intent"), [("상담원 연결해 주세요", "agent"), ("끊어 주세요", "end")])
def test_readback_handoff_or_end_takes_priority_over_yes(customer_request, intent):
    from app.calls.live import Spoken
    from app.calls.session import CallSession
    from app.domain.confirm import issue_parcel_confirmation
    from app.tests.test_calls import INCOMING_AT
    from app.tests.test_domain import filled
    from app.tools.context import ToolContext

    client = FakeClient()
    client.decisions = FakeDecisions()
    svc = service(client)
    lf = LiveFlow(svc)
    lf._follow = AsyncMock()
    state, policy = filled(), svc.d.policy
    pending = issue_parcel_confirmation(state, policy, 1.0)
    session = CallSession("live_1", "t", CALLER, INCOMING_AT, ToolContext("live_1", state, policy, None))
    previous = Spoken(1, "이대로 접수할까요?", 1000, 1800, 2.0, 2.8)
    utterance = Spoken(2, f"네, 그런데 {customer_request}", 2000, 2800, 3.0, 3.8)

    run(lf.judge(session, utterance, previous))

    assert client.decisions.calls[0][1] == ["confirm", "switch"]
    lf._follow.assert_awaited_once_with(session, "intent", intent)
    assert state.pending is pending and not state.parcels and lf.rt(session).commit is None


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


def test_customer_info_saved_on_commit_without_asking():
    """택배를 담으면 묻지 않고 저장 대상(성함·보내는 곳·받는 곳)을 저장한다(2026-11-06). 담기 전에는 저장하지 않는다."""
    from app.domain.confirm import issue_parcel_confirmation
    from app.policy.render import decision_questions
    from app.tests.test_domain import P, filled
    from app.tests.test_results import session
    saved, sent = [], []

    async def save_addresses(s, seq, snap, offer):
        saved.append(offer)

    async def notify(s, level, facts):
        sent.append((level, facts))

    lf = LiveFlow.__new__(LiveFlow)
    lf.policy, lf.notify = P, notify
    lf.svc = SimpleNamespace(results=SimpleNamespace(save_addresses=save_addresses), call_session_seq=None)
    st = filled()
    s = session(st)
    spawned = []
    s.spawn = lambda coro, name: spawned.append(coro)
    p = issue_parcel_confirmation(st, P, 100.0)
    st.address_offer = {"name": True, "sender": True, "receiver": True}
    lf._maybe_save_addresses(s)
    assert not spawned  # 되읽기 중(담기 전)에는 저장하지 않는다
    run(lf.commit(s, p.id))
    [(level, facts)] = sent
    assert level == "N2" and facts["parcel_added"] and "address_save" not in facts  # 저장 여부를 묻지 않는다
    run(spawned[0])
    assert saved == [{"name": True, "sender": True, "receiver": True, "parcel": facts["parcel_added"]}]
    assert st.address_offer is None
    assert [q["name"] for q in decision_questions(P, "more_parcels")] == ["more", "switch"]  # 저장 질문 없음


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



@pytest.mark.parametrize(("greeting_address", "reply", "expected"), [
    ("서울 강남구 가람구길 이백십이에서 보내시는 ", "네", "prefilled"),
    ("서울 강남구 가람구길 이백십이에서 보내시는 ", "네, 다른 주소에서 보낼게요", "name_only"),
    ("서울 강남구 가람구길 이백십삼에서 보내시는 ", "예", "ask_origin"),
    ("", "예", "ask_origin"),
])
def test_registered_greeting_answer_preserves_address_scope_without_model(greeting_address, reply, expected):
    from app.domain.state import Source
    from backend_client.order import Geo as BGeo, Place as BPlace
    svc, client = flow()
    client.decisions.create = AsyncMock(side_effect=AssertionError("명확한 첫 인사 답변은 모델 호출이 필요 없다"))
    db = svc.d.backend.api
    db.add_customer(CALLER, "김철수", default_origin=BPlace(name="김철수", phone=CALLER, address="서울특별시 강남구 가람9길 212",
                                                        address_detail="1201호", geo=BGeo(jibun_address="서울 강남구 역삼동 737",
                                                                                         dong_name="역삼동", postal_code="06236")))

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await ai(conn, f"안녕하세요, 김철수님, {greeting_address}택배 접수 도와드릴까요?", 0)
        await say(conn, reply, 1500)
        await until(lambda: any('"greeting_confirmation"' in e.get("content", "") for e in conn.sent))
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s, conn

    s, conn = run(scenario())
    client.decisions.create.assert_not_awaited()
    event = next(e for e in conn.sent if '"greeting_confirmation"' in e.get("content", ""))
    assert event["type"] == "session.commentary.append"
    facts = json.loads(event["content"].split("[서버 결과] ", 1)[1])
    assert facts["greeting_confirmation"] == "confirmed" and facts["intent"] == "order"
    cur = s.state.parcels[0].draft if s.state.parcels else s.state.current
    assert cur["sender_name"].source == Source.CALLER_ID
    if expected == "prefilled":
        assert facts["origin"] == "prefilled" and facts["summary"]["missing"][0] == "receiver_name"
        assert all(cur[n].source == Source.PROFILE for n in ("sender_address", "sender_address_detail"))
        assert cur.sender_geo is not None and cur["sender_address_detail"].value == "1201호"
    else:
        assert facts["summary"]["missing"][0] == "sender_address" and not cur["sender_address"].valid
        assert ("origin_confirm" in facts) == (expected == "ask_origin")
        assert s.state.origin_answer is (False if expected == "name_only" else None)


def test_unclear_greeting_timeout_asks_only_for_intent():
    svc, client = flow()

    async def slow(**kwargs):
        await asyncio.sleep(10)

    client.decisions.create = slow

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await ai(conn, "안녕하세요. 택배 접수 도와드릴까요?", 0)
        await say(conn, "음 글쎄요", 1500)
        await until(lambda: any('"ask_intent"' in e.get("content", "") for e in conn.sent), timeout=3.0)
        assert s.state.intent is None and s.state.origin_answer is None
        assert any("DECISION_TIMEOUT" in e["text"] for e in s.events)
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task

    run(scenario())


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

    st = ConversationState(customer=Customer(customer_seq=12, name="김철수", origin_place=recent), intent="order")
    st.record("sender_address", "서울 강남구 테헤란로 212")
    st.origin_answer = True
    assert lf._origin_step(st) == {"origin": "address_recorded"}
    assert st.current["sender_address"].value == "서울 강남구 테헤란로 212"
    assert not st.current["sender_address_detail"].valid


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


def test_inquiry_intent_still_hears_end_and_hangs_up():
    """문의로 시작한 통화도 '끊어 주세요'를 듣고 마무리 인사 뒤 끊는다(운영 통화 8df5dd7f·6cb7ff73: 판단이 없어 무음 종료)."""
    svc, client = flow()

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await say(conn, "궁금한 게 있어요", 1000)
        intent = s.state.intent
        await say(conn, "네 끊어주세요", 2000)
        await until(lambda: s.phase == Phase.CLOSING)
        reason = s.close_reason
        await ai(conn, "감사합니다. 좋은 하루 보내세요.", 3000)
        await task
        return intent, reason

    intent, reason = run(scenario())
    assert intent == "inquiry" and reason == "customer_end" and client.hangups == ["live_1"]


def test_order_tool_after_inquiry_or_lookup_switches_intent_to_order():
    """문의·조회 뒤 접수 도구를 부르면 접수로 바뀌어 더 보낼 택배·마무리 판단을 받는다. 접수 중 조회 도구는 접수를 유지."""
    from app.domain.assess import assess
    from app.policy.render import decision_questions
    from app.tests.test_domain import P, filled
    from app.tests.test_results import session
    lf = LiveFlow.__new__(LiveFlow)
    lf.svc = SimpleNamespace(stage2=lambda s: None)
    lf.rt = lambda s: SimpleNamespace(intent_started=True)
    for before in ("inquiry", "lookup", "cancel", "agent"):
        assert [q["name"] for q in decision_questions(P, before)] == ["switch"]  # 끝내기·전환을 듣는다
        st = filled()
        st.intent = before
        lf._business(session(st), "order")
        assert st.intent == "order" and assess(st, P).stage == "readback"
    lf._business(session(st), "lookup")
    lf._business(session(st), "inquiry")
    assert st.intent == "order"


class SlowResults:
    """결과 전송이 끝나지 않는 가짜(마무리 결과 대기 상한 확인)."""
    def __init__(self):
        self.tasks = {}

    def start(self, s, on_result):
        self.tasks[s.call_id] = asyncio.ensure_future(asyncio.sleep(30))


def test_flow_complete_without_result_reminds_until_full_greeting():
    """완료 단계: 결과가 상한 안에 안 오면 pending으로 마무리 인사를 시키고, 맞장구만 하면 인사를 다시 요청한 뒤
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
        await ai(conn, "네, 없습니다.", 6000)
        await until(lambda: sum("closing" in e.get("content", "") for e in conn.sent) == 2, timeout=6.0)
        assert not client.hangups
        await ai(conn, "이용해 주셔서 감사합니다.", 9000)
        assert not client.hangups
        await ai(conn, "좋은 하루 보내세요.", 9800)
        said_t = s.last_output_t
        await task
        svc.results.tasks["live_1"].cancel()
        return conn, said_t

    conn, said_t = run(scenario())
    closings = [e["content"] for e in conn.sent if e["type"] == "session.commentary.append" and "closing" in e["content"]]
    assert len(closings) == 2 and all('"pending"' in c for c in closings)
    assert client.hangups == ["live_1"] and hung[0] - said_t >= 1.0


def test_cancel_target_carries_status_meaning():
    from app.calls.live import _order_facts
    facts = _order_facts({"receiver_name": "홍길동", "status": "COLLECTING", "receiver_address": "부산"})
    assert facts == {"receiver_name": "홍길동", "status": "COLLECTING", "status_text": "접수 미완료(정보 수집 중), 최종 접수 전"}


def test_call_record_keeps_decision_io_backend_text_tool_args_and_delivery():
    """관제·통화 기록: Decision 입력·답 확률, 위임 메타, Backend 출력 문장·추론 요약, 도구 인수(dict)·결과, 전달 원문."""
    svc, client = flow()

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        s = svc.registry.calls["live_1"]
        await ai(conn, "안녕하세요, 디바콜입니다.", 0)
        await say(conn, "택배 보내려고요", 1000)
        conn.push({"type": "session.delegation.created", "delegation": {"id": "d1", "target": "responses"},
                   "offset_ms": 2100})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {"type": "response.created"}})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {
            "type": "response.output_item.done", "item": {"type": "reasoning", "summary": [
                {"type": "summary_text", "text": "보내는 분 성함을 기록한다"}]}}})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {
            "type": "response.output_item.done", "item": {"type": "function_call", "call_id": "call_1",
                                                          "name": "record_fields",
                                                          "arguments": json.dumps({"sender_name": "김철수"})}}})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {
            "type": "response.output_item.done", "item": {"type": "message", "content": [
                {"type": "output_text", "text": "김철수 님으로 적었습니다."}]}}})
        conn.push({"type": "response.event", "delegation_id": "d1", "event": {
            "type": "response.completed", "response": {"status": "completed", "usage": {"total_tokens": 42}}}})
        await until(lambda: s.tool_calls and s.tool_calls[0]["done_at"])
        await until(lambda: any(e["kind"] == "전달 N2" for e in s.events))

        by = {}
        for e in s.events:
            by.setdefault(e["kind"], []).append(e)
        dec = by["Decision"][0]["data"]
        assert "고객 발화: 택배 보내려고요" in dec["input"] and dec["answers"]["task"]["choice"] == "order"
        assert dec["answers"]["task"]["probabilities"] == {"order": 0.97}
        assert by["위임 시작"][0]["data"]["target"] == "responses"
        assert by["위임 시작"][0]["data"]["last_customer"].strip() == "택배 보내려고요"
        assert by["Backend 추론 요약"][0]["text"] == "보내는 분 성함을 기록한다"
        assert by["Backend 출력"][0]["text"] == "김철수 님으로 적었습니다."
        assert by["함수 호출 도착"][0]["data"]["arguments"] == {"sender_name": "김철수"}
        assert by["Backend 응답 끝"][0]["data"]["usage"] == {"total_tokens": 42}
        tool = s.tool_calls[0]
        assert tool["args"] == {"sender_name": "김철수"} and tool["delegation"] == "d1" and tool["call_id"] == "call_1"
        assert tool["output"]["status"] and isinstance(by["전달 N2"][0]["data"]["content"], dict)
        snap = s.snapshot()
        assert snap["transcript"][0]["t"] and any("data" in e for e in snap["events"])
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task

    run(scenario())
