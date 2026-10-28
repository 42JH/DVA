"""페르소나 연동(spec/persona.md): 내부 API, 통화 0건에서 잠그고 적용, 실패·교체·회신 유실, 통화별 설정 고정."""

import asyncio
import uuid
from types import SimpleNamespace as NS

import pytest
from conftest import CFG, TEXTS, FakeBackend, FakeClient, run
from fastapi.testclient import TestClient

from app.backend_api import BackendError
from app.call import Call, Registry
from app.main import create_app
from app.persona import OPTIONS, PersonaManager
from app.services import Services

TOKEN = "t" * 40


def version(seq, prompt="## 말투\n- 밝게 말합니다.", voice="marin", status="PENDING", **extra):
    return {"aiPersonaVersionSeq": seq, "applicationId": str(uuid.uuid4()), "promptText": prompt, "voiceId": voice,
            "speakingRate": None, "turnWaitLevel": "NORMAL", "status": status, "applyErrorCode": None, **extra}


def manager(db=None, registry=None):
    db = db or FakeBackend()
    return PersonaManager(db, registry or Registry(CFG), CFG.persona, enabled=True), db


def busy_call(registry, session_id="busy"):
    call = Call(session_id, None, CFG, TEXTS, None)
    call.status = "active"
    registry.calls[session_id] = call
    return call


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

def test_no_backend_persona_uses_local_default():
    m, _ = manager()
    run(m.sync())
    assert m.active is None and not m.locked


def test_restart_restores_active():
    m, db = manager()
    db.personas["ACTIVE"] = version(3, status="ACTIVE")
    run(m.sync())
    assert m.active.version_seq == 3 and m.active.voice == "marin"


def test_pending_waits_for_last_call_then_applies():
    registry = Registry(CFG)
    m, db = manager(registry=registry)
    db.personas["ACTIVE"] = version(1, voice=None, status="ACTIVE")
    db.personas["PENDING"] = pending = version(2)
    call = busy_call(registry)

    async def scenario():
        task = asyncio.create_task(m.sync())
        await asyncio.sleep(0.05)
        assert not m.locked and m.active.version_seq == 1  # 통화 중에는 기존 설정으로 새 통화도 받는다
        assert "PENDING" in db.personas
        call.status = "ended"
        await asyncio.wait_for(task, 3)

    run(scenario())
    assert m.active.version_seq == 2 and not m.locked
    assert db.personas["ACTIVE"]["applicationId"] == pending["applicationId"] and "PENDING" not in db.personas


def test_unsupported_option_reports_failed_and_keeps_active():
    m, db = manager()
    db.personas["ACTIVE"] = version(1, status="ACTIVE")
    db.personas["PENDING"] = version(2, voice="robot")
    run(m.sync())
    assert m.active.version_seq == 1 and not m.locked
    assert db.personas["PENDING"]["applyErrorCode"] == "UNSUPPORTED_OPTIONS"
    db.persona_result = None  # 같은 실패 요청은 다시 적용·회신하지 않는다
    run(m.sync())
    assert m.active.version_seq == 1


@pytest.mark.parametrize("bad", [{"promptText": "  "}, {"promptText": "[[페르소나]]"}, {"speakingRate": 1.2},
                                 {"turnWaitLevel": "LONG"}])
def test_invalid_versions_fail(bad):
    m, db = manager()
    db.personas["PENDING"] = {**version(2), **bad}
    run(m.sync())
    assert db.personas["PENDING"]["applyErrorCode"] in ("INVALID_CONFIG", "UNSUPPORTED_OPTIONS")
    assert m.active is None


def test_replaced_pending_conflict_resyncs():
    m, db = manager()
    db.personas["ACTIVE"] = version(1, status="ACTIVE")
    old, new = version(2), version(3)
    db.personas["PENDING"] = old
    real = db.persona_result

    async def replaced(body):  # 회신 직전에 관리자가 다른 버전으로 교체
        db.personas["PENDING"] = new
        return await real(body)

    db.persona_result = replaced

    async def scenario():
        await m.sync()  # 409 → ACTIVE 다시 맞춤, 새 대기를 이어서 처리하도록 깨움
        assert m.active.version_seq == 1 and not m.locked and m._wake.is_set()
        db.persona_result = real
        await m.sync()

    run(scenario())
    assert m.active.version_seq == 3


def test_lost_reply_keeps_lock_until_active_confirmed(monkeypatch):
    m, db = manager()
    monkeypatch.setattr(m, "cfg", CFG.persona.model_copy(update={"retry_sec": 0.01}))
    db.personas["PENDING"] = pending = version(2)
    real_result, real_config = db.persona_result, db.persona_config

    async def applied_but_lost(body):  # 백엔드는 적용했지만 응답이 안 왔다
        await real_result(body)
        raise BackendError("timeout")

    calls = {"n": 0}

    async def flaky(status):
        calls["n"] += 1
        if calls["n"] == 4:  # ACTIVE·PENDING·(잠근 뒤)PENDING 다음, 회신 유실 뒤 ACTIVE 확인이 실패
            raise BackendError("down")
        return await real_config(status)

    db.persona_result, db.persona_config = applied_but_lost, flaky
    with pytest.raises(BackendError):
        run(m.sync())
    assert m.locked
    db.persona_config = real_config
    run(m.sync())  # 다시 맞추면 ACTIVE가 이번 요청이라 완료
    assert not m.locked and m.active.version_seq == 2
    assert db.personas["ACTIVE"]["applicationId"] == pending["applicationId"]


# --- 통화 ---

def _services(db):
    svc = Services(CFG, TEXTS, FakeClient(), db, Registry(CFG))
    svc.persona = PersonaManager(db, svc.registry, CFG.persona, enabled=True)
    return svc


def test_locked_rejects_new_calls_and_call_keeps_its_persona(monkeypatch):
    from app.webhooks import openai as webhook

    async def no_sideband(call, client):
        pass

    monkeypatch.setattr(webhook, "run_call", no_sideband)
    db = FakeBackend()
    svc = _services(db)
    svc.persona.locked = True
    run(webhook.handle_incoming(svc, NS(session_id="s1", sip_headers=[])))
    assert svc.client.live.sessions.of("reject") and "s1" not in svc.registry.calls

    db.personas["ACTIVE"] = version(5, prompt="## 말투\n- 느긋하게 말합니다.", voice="cedar", status="ACTIVE")
    svc.persona.locked = False
    run(svc.persona.sync())

    async def accept():
        await webhook.handle_incoming(svc, NS(session_id="s2", sip_headers=[]))
        await svc.registry.get("s2").task

    run(accept())
    session = svc.client.live.sessions.of("accept")[0][2]
    assert "- 느긋하게 말합니다." in session["instructions"] and "## 인사 문구" not in session["instructions"]
    assert session["audio"]["output"]["voice"] == "cedar"
    assert svc.registry.get("s2").persona_version == 5
