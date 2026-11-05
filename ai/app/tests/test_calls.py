"""S4 통화 생명주기: 수신·accept·sideband·2단계 고객 확인·PBX 종료 매칭·마무리·정리(자원 0). 가짜 OpenAI·가짜 BE."""

import asyncio
import json
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from conftest import CALLER, run

from app.calls.service import CallDeps, CallService
from app.calls.session import Phase
from app.config import CallConfig
from app.integrations.backend.gateway import BackendGateway
from app.policy.model import load_policy
from app.policy.render import default_persona
from backend_client.mock import MockBackend
from backend_client.order import Place as BEPlace
from pbx_webhook import IncomingCall

P = load_policy()
INCOMING_AT = "2026-11-03T01:00:00Z"


class FakeConn:
    def __init__(self):
        self.q: asyncio.Queue = asyncio.Queue()
        self.sent, self.closed = [], False

    def push(self, ev):
        self.q.put_nowait(ev if isinstance(ev, (bytes, Exception)) else json.dumps(ev).encode())

    async def recv_bytes(self):
        item = await self.q.get()
        if isinstance(item, Exception):
            raise item
        return item

    async def send(self, ev):
        self.sent.append(ev)


class FakeClient:
    def __init__(self, accept_error=None, accept_delay=0.0):
        self.accepted, self.rejected, self.hangups, self.conns = [], [], [], []
        self.accept_error, self.accept_delay = accept_error, accept_delay
        client = self

        class Sessions:
            async def accept(self, sid, session):
                await asyncio.sleep(client.accept_delay)
                if client.accept_error:
                    raise client.accept_error
                client.accepted.append((sid, session))

            async def reject(self, sid, status_code):
                client.rejected.append((sid, status_code))

            async def hangup(self, sid):
                client.hangups.append(sid)
                if sid in client.by_sid:
                    client.by_sid[sid].push({"type": "session.closed", "reason": "close_requested"})

        class Manager:
            def __init__(self, sid):
                self.conn = FakeConn()
                client.conns.append(self.conn)
                client.by_sid[sid] = self.conn

            async def __aenter__(self):
                return self.conn

            async def __aexit__(self, *exc):
                self.conn.closed = True

        self.by_sid = {}
        self.live = SimpleNamespace(sessions=Sessions(),
                                    sideband=SimpleNamespace(connect=lambda **kw: Manager(kw["session_id"])))


def service(client=None, backend=None, **cfg) -> CallService:
    base = {"closing_quiet_ms": 50, "closing_max_sec": 1.0, "silence_sec": 30.0, "finalize_wait_sec": 0.5} | cfg
    svc = CallService(CallDeps(client or FakeClient(), BackendGateway(backend or MockBackend()), P,
                               CallConfig(**base), "gpt-6-luna"))
    svc.done = []
    svc.snapshot_errors = []

    def on_change(s):  # 실제 서버처럼 관제 알림마다 스냅샷을 JSON으로(중간 상태에서도 깨지면 안 된다)
        try:
            json.dumps(s.snapshot(), ensure_ascii=False, default=str)
        except Exception as e:
            svc.snapshot_errors.append(repr(e))
            raise

    svc.on_change = on_change

    async def record(s):
        svc.done.append(s)

    svc.on_finalize.append(record)
    return svc


def incoming(sid="live_1", caller=CALLER, at=INCOMING_AT):
    return IncomingCall(sid, caller, at, None)


async def until(cond, timeout=2.0):
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError("시간 초과")
        await asyncio.sleep(0.01)


def started(expires_in=600):
    return {"type": "session.started", "session": {"expires_at": time.time() + expires_in}}


def test_happy_path_accept_config_and_full_cleanup():
    svc, client = service(), None
    client = svc.d.client

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: client.conns)
        conn = client.conns[0]
        conn.push(b'{"type":"session.output_audio.delta","delta":"AAAA"}')  # 오디오 반사: 파싱하지 않음
        conn.push(started())
        await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return conn

    conn = run(scenario())
    sid, cfg = client.accepted[0]
    assert sid == "live_1" and "triggers" not in cfg  # S0c: 트리거 없음
    r = cfg["delegation"]["responses"]
    assert r["service_tier"] == "priority" and {t["name"] for t in r["tools"]} == {
        "record_fields", "find_destination", "lookup_orders", "search_manual", "get_state"}
    assert cfg["instructions"].startswith(default_persona()[:30])  # 페르소나 없음 → 기본 페르소나(P2)
    s = svc.done[0]
    assert s.phase == Phase.DONE and s.close_reason == "remote_hangup" and s.closed
    assert not s.tasks and not s.timers and conn.closed and not svc.registry.calls  # 종료 시 자원 0
    assert client.hangups == []  # 고객이 먼저 끊음: 끊기 요청 없음


def test_persona_prompt_and_stage1_context():
    db = MockBackend()
    db.personas["ACTIVE"] = {"promptText": "페르소나 지시문", "aiPersonaVersionSeq": 7}
    db.add_customer(CALLER, "김철수", payment_methods=["billing", "credit"])
    svc = service(backend=db)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: svc.d.client.conns)
        svc.d.client.conns[0].push({"type": "session.closed", "reason": "remote_hangup"})
        await task

    run(scenario())
    cfg = svc.d.client.accepted[0][1]
    assert cfg["instructions"].startswith("페르소나 지시문") and "고객 성함: 김철수" in cfg["instructions"]
    s = svc.done[0]
    assert s.persona_version_seq == 7 and s.state.customer.customer_seq and s.state.customer.call_session_seq is None
    assert s.state.customer.payment_methods == ("billing", "credit")


def test_stage1_failure_still_accepts_as_unregistered():
    class Down(MockBackend):
        async def caller_context(self, *a, **kw):
            import httpx2
            raise httpx2.ConnectError("down")

    svc = service(backend=Down())

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: svc.d.client.conns)
        svc.d.client.conns[0].push({"type": "session.closed", "reason": "remote_hangup"})
        await task

    run(scenario())
    assert svc.d.client.accepted and "처음 이용하는 고객" in svc.d.client.accepted[0][1]["instructions"]


def test_capacity_reject_and_duplicate_session():
    svc = service(max_active_calls=1)

    async def scenario():
        first = asyncio.create_task(svc.on_incoming(incoming("live_1")))
        await until(lambda: svc.d.client.conns)
        await svc.on_incoming(incoming("live_2"))        # 상한 초과
        await svc.on_incoming(incoming("live_1"))        # 같은 session_id(다른 webhook-id)
        svc.d.client.conns[0].push({"type": "session.closed", "reason": "remote_hangup"})
        await first

    run(scenario())
    assert svc.d.client.rejected == [("live_2", 486)] and len(svc.d.client.accepted) == 1


def test_accept_failure_is_failed_without_hangup_or_sideband():
    svc = service(FakeClient(accept_error=RuntimeError("decision_already_made")))
    run(svc.on_incoming(incoming()))
    s = svc.done[0]
    assert s.close_reason == "accept_failed" and not svc.d.client.conns and not svc.d.client.hangups
    assert not svc.registry.calls


def test_pbx_ended_during_accept_hangs_up_after_accept():
    svc = service(FakeClient(accept_delay=0.1))
    ended = SimpleNamespace(caller=CALLER, ended_at=datetime(2026, 11, 3, 1, 1, tzinfo=timezone.utc))

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: svc.registry.calls.get("live_1") and svc.registry.calls["live_1"].phase == Phase.ACCEPTING)
        await svc.on_call_ended(ended)
        await task

    run(scenario())
    assert svc.d.client.hangups == ["live_1"] and not svc.d.client.conns  # sideband 미개시
    assert svc.done[0].close_reason == "pbx_ended_during_accept"


def test_pbx_ended_active_and_redial_is_protected():
    svc = service()
    ended = SimpleNamespace(caller=CALLER, ended_at=datetime(2026, 11, 3, 1, 5, tzinfo=timezone.utc))

    async def scenario():
        old = asyncio.create_task(svc.on_incoming(incoming("live_old", at="2026-11-03T01:00:00Z")))
        new = asyncio.create_task(svc.on_incoming(incoming("live_new", at="2026-11-03T01:06:00Z")))  # 종료 뒤 재통화
        await until(lambda: len(svc.d.client.conns) == 2)
        for c in svc.d.client.conns:
            c.push(started())
        await until(lambda: all(s.phase == Phase.ACTIVE for s in svc.registry.calls.values()))
        await svc.on_call_ended(ended)
        await old
        assert svc.registry.calls["live_new"].phase == Phase.ACTIVE
        svc.registry.calls["live_new"].sideband.push({"type": "session.closed", "reason": "remote_hangup"})
        await new

    run(scenario())
    assert svc.d.client.hangups == ["live_old"]
    assert {s.call_id: s.close_reason for s in svc.done}["live_old"] in ("pbx_ended", "close_requested")


def test_stage2_runs_once_and_fills_call_seq_and_places():
    db = MockBackend()
    pin = BEPlace(name="이영희", phone="01098765432", address="부산 해운대구 센텀로 10", address_detail="101호")
    recent = BEPlace(name="박민수", phone="01011112222", address="서울 중구 세종대로 110", address_detail="")
    db.add_customer(CALLER, "김철수", pins=[pin], recent=(pin, recent))
    svc = service(backend=db)
    calls = []
    original = db.caller_context

    async def counting(*a, **kw):
        calls.append(a)
        return await original(*a, **kw)

    db.caller_context = counting

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: svc.d.client.conns)
        svc.d.client.conns[0].push(started())
        s = svc.registry.calls["live_1"]
        await until(lambda: s.phase == Phase.ACTIVE)
        seqs = await asyncio.gather(svc.call_session_seq(s), svc.call_session_seq(s))
        svc.d.client.conns[0].push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s, seqs

    s, seqs = run(scenario())
    assert seqs[0] and seqs[0] == seqs[1] and s.state.customer.call_session_seq == seqs[0]
    with_call = [a for a in calls if len(a) > 1 and a[1]]
    assert len(with_call) == 1 and with_call[0][1] == {"providerCallId": "live_1", "incomingAt": INCOMING_AT}
    assert [p.name for p in s.state.customer.places] == ["박민수", "이영희"]  # 최근 도착지 → 주소록


def test_stage2_keeps_call_seq_when_history_lookup_fails():
    """BE 확인 1번: 통화 등록은 성공했는데 이전 접수 주소 조회가 실패·지연해도 통화 번호는 보관한다."""
    from backend_client.api import BackendError
    db = MockBackend()
    pin = BEPlace(name="이영희", phone="01098765432", address="부산 해운대구 센텀로 10", address_detail="101호")
    recent = BEPlace(name="박민수", phone="01011112222", address="서울 중구 세종대로 110", address_detail="")
    home = BEPlace(name="김철수", phone=CALLER, address="서울 강남구 테헤란로 212", address_detail="1201호")
    db.add_customer(CALLER, "김철수", pins=[pin], recent=(pin, recent), default_origin=home)

    async def broken(*a, **kw):
        raise BackendError("history down", 503)

    db.address_history = broken
    svc = service(backend=db)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: svc.d.client.conns)
        svc.d.client.conns[0].push(started())
        s = svc.registry.calls["live_1"]
        await until(lambda: s.phase == Phase.ACTIVE)
        seq = await svc.call_session_seq(s)
        await until(lambda: any(e["kind"] == "이전 접수 주소 조회 실패" for e in s.events))
        svc.d.client.conns[0].push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s, seq

    s, seq = run(scenario())
    assert seq and s.state.customer.call_session_seq == seq and s.tools.ops["stage2"]["status"] == "done"
    assert [p.name for p in s.state.customer.places] == ["이영희"]  # 주소록(PIN)만, 이력 없음
    assert s.state.customer.origin_place.address == home.address  # 기본 주소는 context 응답에 있어 이력 실패와 무관


def test_closing_waits_for_quiet_then_hangs_up_and_silence_timer():
    svc = service(silence_sec=0.1)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: svc.d.client.conns)
        svc.d.client.conns[0].push(started())
        await task  # 무발화 → 마무리 → 조용해지면 끊음 → session.closed

    run(scenario())
    s = svc.done[0]
    assert svc.d.client.hangups == ["live_1"] and s.close_reason in ("silence", "close_requested")


def test_reader_exception_hangs_up_and_finalizes():
    svc = service()

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: svc.d.client.conns)
        svc.d.client.conns[0].push(ConnectionError("lost"))
        await task

    run(scenario())
    s = svc.done[0]
    assert svc.d.client.hangups == ["live_1"] and s.phase == Phase.DONE and not svc.registry.calls
    assert s.close_reason.startswith("connection_")


def test_running_side_effect_becomes_unknown_on_finalize():
    svc = service()

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: svc.d.client.conns)
        s = svc.registry.calls["live_1"]
        s.tools.ops["cancel:1:2"] = {"status": "running"}
        s.spawn(asyncio.sleep(10), "slow")
        svc.d.client.conns[0].push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s

    s = run(scenario())
    assert s.tools.ops["cancel:1:2"]["status"] == "unknown" and not s.tasks


@pytest.mark.parametrize("phase", [Phase.CLOSING, Phase.DONE])
def test_begin_closing_ignored_when_already_ending(phase):
    svc = service()
    from app.calls.session import CallSession
    from app.domain.state import ConversationState
    from app.tools.context import ToolContext
    s = CallSession("x", "t", CALLER, INCOMING_AT, ToolContext("x", ConversationState(), P, None))
    s.phase = phase
    svc.begin_closing(s, "again")
    assert s.close_reason is None




def test_ai_speech_keeps_silence_timer_from_firing():
    """고객이 AI의 긴 되읽기를 듣는 동안(고객 입력 없음)에는 끊지 않는다."""
    svc = service(silence_sec=0.3)

    async def scenario():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: svc.d.client.conns)
        conn = svc.d.client.conns[0]
        conn.push(started())
        for i in range(8):  # 0.8초 동안 AI만 말한다(무발화 0.3초보다 길게)
            conn.push({"type": "session.output_transcript.delta", "delta": "되읽기 ", "start_ms": i * 100,
                       "end_ms": i * 100 + 90})
            await asyncio.sleep(0.1)
        assert svc.registry.calls["live_1"].phase == Phase.ACTIVE
        await task  # AI가 멈추면 그때부터 무발화로 마무리

    run(scenario())
    assert svc.done[0].close_reason in ("silence", "close_requested")


def test_registered_customer_origin_goes_to_call_info_without_detail():
    from types import SimpleNamespace
    from app.calls.service import _apply_context
    from app.domain.state import ConversationState, Customer
    st = ConversationState(customer=Customer(caller_phone=CALLER))
    origin = SimpleNamespace(name="김철수", phone=CALLER, address="서울 강남구 테헤란로 212", address_detail="1201호", geo=None)
    ctx = SimpleNamespace(status="REGISTERED", customer_seq=12, name="김철수", payment_methods=["billing"],
                          call_session_seq=None, recent_destinations=[], places=[], default_origin=origin, recent_origin=None)
    _apply_context(st, ctx, CALLER)
    svc = service()
    from app.calls.session import CallSession
    from app.tools.context import ToolContext
    s = CallSession("live_1", "t", CALLER, INCOMING_AT, ToolContext("live_1", st, svc.d.policy, None))
    text = svc.session_config(s, None)["instructions"]
    assert "- 등록된 출발지: 서울 강남구 테헤란로 212" in text and "1201호" not in text.split("# 통화 정보")[1]
