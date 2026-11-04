"""페르소나 연동(spec/persona.md): 내부 API, 진행 통화와 무관하게 다음 통화부터 적용, 통화 진입 동기화, 실패·교체·회신 유실."""

import asyncio
import uuid
from types import SimpleNamespace as NS

import pytest
from conftest import CFG, TEXTS, FakeBackend, FakeClient, run
from fastapi.testclient import TestClient

from app.backend_api import BackendError
from app.call import Call, Registry
from app.main import create_app
from app.persona import OPTIONS, PersonaManager, PersonaUnavailable
from app.services import Services

TOKEN = "t" * 40


def version(seq, prompt="- 밝게 말합니다.", voice="marin", status="PENDING", **extra):
    return {"aiPersonaVersionSeq": seq, "applicationId": str(uuid.uuid4()), "promptText": prompt, "voiceId": voice,
            "speakingRate": None, "turnWaitLevel": "NORMAL", "status": status, "applyErrorCode": None, **extra}


def manager(db=None, **cfg):
    db = db or FakeBackend()
    return PersonaManager(db, CFG.persona.model_copy(update=cfg), enabled=True), db


async def enter(m):
    async with m.entry() as persona:
        return persona


# --- 내부 API ---

def test_internal_api_requires_token(monkeypatch):
    with TestClient(create_app(client=FakeClient(), backend=FakeBackend())) as http:
        monkeypatch.delenv("AI_PERSONA_TOKEN", raising=False)
        assert http.get("/internal/persona/options").status_code == 503
        monkeypatch.setenv("AI_PERSONA_TOKEN", TOKEN)
        assert http.get("/internal/persona/options", headers={"Authorization": "Bearer nope"}).status_code == 401
        resp = http.get("/internal/persona/options", headers={"Authorization": f"Bearer {TOKEN}"})
        assert resp.status_code == 200 and resp.json() == OPTIONS
        assert {"id": "noeul", "label": "noeul"} in resp.json()["voices"] and len(resp.json()["voices"]) == 31
        assert resp.json()["speakingRate"] == {"min": None, "max": None}
        auth = {"Authorization": f"Bearer {TOKEN}"}
        assert http.post("/internal/persona/refresh", json={"aiPersonaVersionSeq": 7}, headers=auth).status_code == 400
        body = {"aiPersonaVersionSeq": 7, "applicationId": str(uuid.uuid4())}
        assert http.post("/internal/persona/refresh", json=body, headers=auth).status_code == 202


# --- 적용 ---

def test_nothing_configured_rejects_new_calls():
    m, _ = manager()
    with pytest.raises(PersonaUnavailable):
        run(enter(m))


def test_disabled_uses_local_voice_prompt():
    m = PersonaManager(FakeBackend(), CFG.persona, enabled=False)
    assert run(enter(m)) is None


def test_restart_restores_active():
    m, db = manager()
    db.personas["ACTIVE"] = version(3, status="ACTIVE")
    run(m.sync())
    assert m.active.version_seq == 3 and m.active.voice == "marin"


def test_restart_with_only_pending_applies_first():
    m, db = manager()
    db.personas["PENDING"] = pending = version(2)
    assert run(enter(m)).version_seq == 2
    assert db.personas["ACTIVE"]["applicationId"] == pending["applicationId"] and "PENDING" not in db.personas


def test_new_call_picks_up_pending_before_refresh_arrives():
    """알림이 오기 전이어도 새 통화 진입 때 대기를 조회해 적용한다. 회신에는 통화 수를 넣지 않는다."""
    m, db = manager()
    db.personas["ACTIVE"] = version(1, voice=None, status="ACTIVE")
    assert run(enter(m)).version_seq == 1
    db.personas["PENDING"] = version(2)
    sent = []
    real = db.persona_result

    async def spy(body):
        sent.append(body)
        return await real(body)

    db.persona_result = spy
    assert run(enter(m)).version_seq == 2
    assert set(sent[0]) == {"aiPersonaVersionSeq", "applicationId", "result"}


def test_unsupported_option_reports_failed_and_keeps_active():
    m, db = manager()
    db.personas["ACTIVE"] = version(1, status="ACTIVE")
    db.personas["PENDING"] = version(2, voice="robot")
    assert run(enter(m)).version_seq == 1
    assert db.personas["PENDING"]["applyErrorCode"] == "UNSUPPORTED_OPTIONS"
    db.persona_result = None  # 같은 실패 요청은 다시 적용·회신하지 않는다
    assert run(enter(m)).version_seq == 1


@pytest.mark.parametrize("bad", [{"promptText": "  "}, {"promptText": "가" * 20001}, {"speakingRate": 1.2},
                                 {"turnWaitLevel": "LONG"}])
def test_invalid_versions_fail(bad):
    m, db = manager()
    db.personas["PENDING"] = {**version(2), **bad}
    run(m.sync())
    assert db.personas["PENDING"]["applyErrorCode"] in ("INVALID_CONFIG", "UNSUPPORTED_OPTIONS")
    assert m.active is None


def test_replaced_pending_conflict_applies_newest():
    m, db = manager()
    db.personas["ACTIVE"] = version(1, status="ACTIVE")
    old, new = version(2), version(3)
    db.personas["PENDING"] = old
    real = db.persona_result

    async def replaced(body):  # 회신 직전에 관리자가 다른 버전으로 교체(첫 회신만)
        db.persona_result = real
        db.personas["PENDING"] = new
        return await real(body)

    db.persona_result = replaced
    assert run(enter(m)).version_seq == 3  # 409 → 다시 조회해 새 대기를 적용한 뒤 통화를 연다
    assert db.personas["ACTIVE"]["applicationId"] == new["applicationId"]


def test_lost_reply_rejects_until_confirmed():
    m, db = manager(retry_sec=0.01)
    db.personas["ACTIVE"] = version(1, status="ACTIVE")
    db.personas["PENDING"] = pending = version(2)
    real_result, real_config = db.persona_result, db.persona_config

    async def applied_but_lost(body):  # 백엔드는 적용했지만 응답이 안 왔다
        await real_result(body)
        raise BackendError("timeout")

    async def down(status):
        raise BackendError("down")

    db.persona_result = applied_but_lost
    with pytest.raises(PersonaUnavailable):  # 결과가 불명확한 동안 옛 캐시로 통화를 열지 않는다
        run(enter(m))
    assert m.unresolved
    db.persona_config = down
    with pytest.raises(PersonaUnavailable):
        run(enter(m))
    db.persona_config = real_config
    assert run(enter(m)).version_seq == 2  # ACTIVE가 이번 요청이라 완료
    assert not m.unresolved and db.personas["ACTIVE"]["applicationId"] == pending["applicationId"]


def test_lookup_failure_uses_cache():
    m, db = manager()
    db.personas["ACTIVE"] = version(1, status="ACTIVE")
    run(m.sync())

    async def down(status):
        raise BackendError("down")

    db.persona_config = down
    assert run(enter(m)).version_seq == 1


def test_entry_waits_for_running_sync():
    m, db = manager(entry_wait_sec=0.05)
    db.personas["ACTIVE"] = version(1, status="ACTIVE")

    async def scenario():
        await m.lock.acquire()  # 알림 처리 중
        with pytest.raises(PersonaUnavailable):
            await enter(m)
        task = asyncio.create_task(enter(m))
        await asyncio.sleep(0.01)
        assert not task.done()
        m.lock.release()
        return await task

    assert run(scenario()).version_seq == 1


# --- 통화 ---

def test_new_call_uses_new_version_while_other_call_keeps_old(monkeypatch):
    from app.webhooks import openai as webhook

    async def no_sideband(call, client):
        pass

    monkeypatch.setattr(webhook, "run_call", no_sideband)
    db = FakeBackend()
    svc = Services(CFG, TEXTS, FakeClient(), db, Registry(CFG))
    svc.persona = PersonaManager(db, CFG.persona, enabled=True)
    run(webhook.handle_incoming(svc, NS(session_id="s0", sip_headers=[])))
    assert svc.client.live.sessions.of("reject") and "s0" not in svc.registry.calls  # 설정 없음

    db.personas["ACTIVE"] = version(1, status="ACTIVE")
    a = Call("a", None, CFG, TEXTS, None)
    a.status, a.persona_version = "active", 1
    svc.registry.calls["a"] = a
    db.personas["PENDING"] = version(5, prompt="- 느긋하게 말합니다.", voice="cedar")

    async def accept():
        await webhook.handle_incoming(svc, NS(session_id="s2", sip_headers=[]))
        await svc.registry.get("s2").task

    run(accept())
    session = svc.client.live.sessions.of("accept")[0][2]
    assert session["instructions"].startswith("- 느긋하게 말합니다.") and "# 업무 규칙" not in session["instructions"]
    assert session["audio"]["output"]["voice"] == "cedar"
    assert svc.registry.get("s2").persona_version == 5 and a.persona_version == 1
