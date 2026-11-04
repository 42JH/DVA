"""페르소나 다음 통화 적용(backend/docs/ai-persona-next-call.md 'AI 팀 확인 항목'). 가짜 BE."""

import asyncio

import pytest
from conftest import CALLER, run
from fastapi.testclient import TestClient

from app.calls.persona import PersonaManager, PersonaUnavailable, check
from backend_client.api import BackendError
from backend_client.mock import MockBackend


def pending(db, seq, app_id, prompt="새 지시문", **kw):
    db.personas["PENDING"] = {"aiPersonaVersionSeq": seq, "applicationId": app_id, "promptText": prompt,
                              "voiceId": None, "speakingRate": None, "turnWaitLevel": "NORMAL",
                              "status": "PENDING", "applyErrorCode": None, **kw}


def manager(db, **kw):
    return PersonaManager(db, entry_wait_sec=1.0, retry_sec=0.01, **kw)


def test_new_call_applies_pending_without_waiting_for_active_calls():
    db = MockBackend()
    db.use_prompt("옛 지시문")
    m = manager(db)
    a = run(m.entry())  # 통화 A: 버전 1
    pending(db, 2, "app-2", voiceId="marin")
    b = run(m.entry())  # 알림 전이어도 통화 진입에서 PENDING 확인 → APPLIED → ACTIVE 확인
    assert (a.version_seq, a.prompt) == (1, "옛 지시문") and (b.version_seq, b.voice) == (2, "marin")
    assert db.personas["ACTIVE"]["aiPersonaVersionSeq"] == 2 and "PENDING" not in db.personas


def test_invalid_pending_reports_failed_and_keeps_active():
    db = MockBackend()
    db.use_prompt("옛 지시문")
    m = manager(db)
    pending(db, 2, "app-2", voiceId="없는-음성")
    p = run(m.entry())
    assert p.version_seq == 1 and db.personas["PENDING"]["applyErrorCode"] == "UNSUPPORTED_OPTIONS"
    assert run(m.entry()).version_seq == 1  # 이미 실패를 회신한 대기는 다시 적용하지 않는다


def test_unresolved_apply_rejects_new_calls_until_confirmed():
    class Lost(MockBackend):
        lose = True

        async def persona_result(self, body):
            if self.lose:
                raise BackendError("timeout")
            return await super().persona_result(body)

    db = Lost()
    db.use_prompt("옛 지시문")
    pending(db, 2, "app-2")
    m = manager(db)
    with pytest.raises(PersonaUnavailable):
        run(m.entry())  # 회신 응답 유실: 옛 캐시로 통화를 먼저 열지 않는다
    db.lose = False
    assert run(m.entry()).version_seq == 2  # 같은 회신 재시도로 확인되면 연다


def test_no_active_uses_server_default_and_disabled_without_token():
    assert run(manager(MockBackend()).entry()) is None  # 임의 버전을 고르지 않는다 → 서버 기본(P2, 버전 null)
    from backend_client.api import BackendAPI
    assert not PersonaManager(BackendAPI("http://be", 1.0)).enabled


def test_check_rejects_bad_config():
    ok = {"aiPersonaVersionSeq": 3, "promptText": "지시문", "turnWaitLevel": None}
    assert check(ok, 100).prompt == "지시문"
    for bad, code in (({"promptText": " "}, "INVALID_CONFIG"), ({"speakingRate": 1.2}, "UNSUPPORTED_OPTIONS"),
                      ({"turnWaitLevel": "LONG"}, "UNSUPPORTED_OPTIONS")):
        with pytest.raises(Exception, match=code):
            check(ok | bad, 100)


def test_call_fixes_version_and_voice_and_rejects_when_unresolved():
    from app.tests.test_calls import incoming, service, until
    db = MockBackend()
    db.use_prompt("옛 지시문")
    pending(db, 2, "app-2", voiceId="cedar")
    svc = service(backend=db)

    async def one():
        task = asyncio.create_task(svc.on_incoming(incoming()))
        await until(lambda: svc.d.client.conns)
        svc.d.client.conns[-1].push({"type": "session.closed", "reason": "remote_hangup"})
        await task

    run(one())
    cfg = svc.d.client.accepted[0][1]
    assert cfg["instructions"].startswith("새 지시문") and cfg["audio"] == {"output": {"voice": "cedar"}}
    assert svc.done[0].persona_version_seq == 2
    svc.persona.unresolved = True
    svc.persona.api = type("Down", (), {"persona_config": lambda *a: (_ for _ in ()).throw(BackendError("x"))})()
    run(svc.on_incoming(incoming("live_2")))
    assert svc.done[-1].close_reason == "persona_unresolved" and svc.d.client.rejected == [("live_2", 503)]


def test_persona_webhook_auth_and_refresh(monkeypatch):
    from app.main import app
    token = "t" * 40
    monkeypatch.setenv("BACKEND_MOCK", "true")
    monkeypatch.setenv("AI_PERSONA_TOKEN", token)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with TestClient(app) as c:
        assert c.get("/internal/persona/options").status_code == 401
        r = c.get("/internal/persona/options", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200 and r.json()["turnWaitLevels"] == ["NORMAL"]
        bad = c.post("/internal/persona/refresh", headers={"Authorization": f"Bearer {token}"}, content=b"{}")
        assert bad.status_code == 400
