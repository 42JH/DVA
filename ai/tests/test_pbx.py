"""PBX 통화 종료 웹훅: Bearer 토큰을 붙인 가짜 요청으로 해당 통화의 OpenAI 세션을 끝내는지 확인한다."""

import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from conftest import CALLER, FakeBackend, FakeClient, signed_webhook
from fastapi.testclient import TestClient

from app.main import create_app

SECRET = "pbx-test-secret"


def ended_body(call_from: str = CALLER, ended_at: datetime | None = None) -> dict:
    """PBX가 팀 백엔드에 보내는 것과 같은 형식."""
    ended_at = ended_at or datetime.now(timezone.utc)
    return {"recordingId": "rec-1", "callFrom": call_from, "callTo": "07012345678",
            "startedAt": (ended_at - timedelta(seconds=180)).isoformat(), "endedAt": ended_at.isoformat(),
            "durationSeconds": 180, "recordingUrl": "https://pbx.example/recordings/rec-1.mp3"}


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("PBX_WEBHOOK_SECRET", SECRET)
    client = FakeClient()
    with TestClient(create_app(client=client, backend=FakeBackend())) as http:
        yield http, client


def wait(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < end, "시간 안에 조건이 맞지 않음"
        time.sleep(0.01)


def incoming(http, session_id):
    body, headers = signed_webhook("live.transport.incoming", session_id)
    http.post("/api/webhooks/openai/call-incoming", content=body, headers=headers)


def active(http, session_id):
    incoming(http, session_id)
    wait(lambda: (c := http.app.state.svc.registry.get(session_id)) is not None and c.status == "active")
    return http.app.state.svc.registry.get(session_id)


def end(http, body, token: str | None = SECRET, scheme: str = "Bearer"):
    headers = {"content-type": "application/json"}
    if token is not None:
        headers["authorization"] = f"{scheme} {token}"
    return http.post("/pbx/webhook/call-ended", content=json.dumps(body).encode(), headers=headers)


def test_active_call_is_hung_up_once(env):
    http, client = env
    call = active(http, "live_1")
    assert end(http, ended_body(call_from="+8210" + CALLER[3:])).status_code == 200  # +82 형식도 같은 번호
    wait(lambda: client.live.sessions.of("hangup"))
    assert client.live.sessions.of("hangup") == [("hangup", "live_1")]
    assert call.pbx_ended["recording_id"] == "rec-1"
    assert end(http, ended_body()).status_code == 200  # 다시 와도 한 번만
    time.sleep(0.05)
    assert len(client.live.sessions.of("hangup")) == 1


def test_other_caller_is_ok_and_does_nothing(env):
    http, client = env
    active(http, "live_x")
    assert end(http, ended_body(call_from="01099998888")).status_code == 200
    time.sleep(0.05)
    assert client.live.sessions.of("hangup") == []


def test_call_started_after_ended_at_is_not_hung_up(env):
    """웹훅이 늦게 오는 사이 같은 번호로 다시 건 통화는 끊지 않는다."""
    http, client = env
    earlier = datetime.now(timezone.utc) - timedelta(seconds=5)
    active(http, "live_new")
    assert end(http, ended_body(ended_at=earlier)).status_code == 200
    time.sleep(0.05)
    assert client.live.sessions.of("hangup") == []


def test_ended_during_accept_hangs_up_after_accept(env):
    http, client = env
    client.live.sessions.accept_delay = 0.3
    incoming(http, "live_2")
    wait(lambda: http.app.state.svc.registry.get("live_2") is not None)
    assert http.app.state.svc.registry.get("live_2").status == "accepting"
    assert end(http, ended_body(ended_at=datetime.now(timezone.utc) + timedelta(seconds=1))).status_code == 200
    wait(lambda: client.live.sessions.of("hangup"))
    call = http.app.state.svc.registry.get("live_2")
    assert call.status == "ended" and call.end_reason == "pbx_hangup"
    assert "live_2" not in client.live.sideband.conns  # sideband를 열지 않는다


def test_rejects_bad_token_and_bad_body(env):
    http, client = env
    assert end(http, ended_body(), token="wrong").status_code == 401
    assert end(http, ended_body(), token=None).status_code == 401  # 헤더 없음
    assert end(http, ended_body(), scheme="Basic").status_code == 401
    assert end(http, {"recordingId": "rec-1"}).status_code == 400  # callFrom·endedAt 없음
    assert end(http, ended_body() | {"endedAt": "2026-03-25T15:33:00"}).status_code == 400  # 시간대 없는 시각


def test_closed_without_secret(monkeypatch):
    monkeypatch.delenv("PBX_WEBHOOK_SECRET", raising=False)
    with TestClient(create_app(client=FakeClient(), backend=FakeBackend())) as http:
        assert end(http, ended_body()).status_code == 503


def test_hangup_404_means_already_ended(env):
    """고객이 끊으면 OpenAI가 세션을 먼저 닫아 hangup이 404다. 오류로 남기지 않는다."""
    http, client = env
    call = active(http, "live_404")
    client.live.sessions.hangup_error = type("NotFound", (Exception,), {"status_code": 404})()
    assert end(http, ended_body()).status_code == 200
    wait(lambda: client.live.sessions.of("hangup"))
    time.sleep(0.05)
    assert call.errors == []
