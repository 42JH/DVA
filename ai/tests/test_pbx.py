"""PBX 통화 종료 웹훅: 서명한 가짜 요청으로 해당 통화의 OpenAI 세션을 끝내는지 확인한다."""

import hashlib
import hmac
import json
import time

import pytest
from conftest import FakeBackend, FakeClient, signed_webhook
from fastapi.testclient import TestClient

from app.main import create_app

SECRET = "pbx-test-secret"


def pbx_request(body: dict, secret: str = SECRET, ts: int | None = None):
    raw = json.dumps(body).encode()
    ts = str(ts if ts is not None else int(time.time()))
    sig = hmac.new(secret.encode(), ts.encode() + b"." + raw, hashlib.sha256).hexdigest()
    return raw, {"x-pbx-timestamp": ts, "x-pbx-signature": f"sha256={sig}", "content-type": "application/json"}


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


def incoming(http, session_id, sip_call_id):
    http.post("/api/webhooks/openai/call-incoming", content=(w := signed_webhook("live.transport.incoming", session_id,
                                                               sip_call_id=sip_call_id))[0], headers=w[1])


def end(http, body, **kw):
    raw, headers = pbx_request(body, **kw)
    return http.post("/pbx/webhook/call-ended", content=raw, headers=headers)


def test_active_call_is_hung_up_once(env):
    http, client = env
    incoming(http, "live_1", "abc@pbx")
    call = None
    wait(lambda: (c := http.app.state.svc.registry.get("live_1")) is not None and c.status == "active")
    call = http.app.state.svc.registry.get("live_1")
    assert call.sip_call_id == "abc@pbx"
    assert end(http, {"call_id": "abc@pbx", "reason": "caller_hangup"}).status_code == 200
    wait(lambda: client.live.sessions.of("hangup"))
    assert client.live.sessions.of("hangup") == [("hangup", "live_1")]
    assert call.pbx_ended["reason"] == "caller_hangup"
    assert end(http, {"call_id": "abc@pbx"}).status_code == 200  # 다시 와도 한 번만
    time.sleep(0.05)
    assert len(client.live.sessions.of("hangup")) == 1


def test_unknown_call_is_ok_and_does_nothing(env):
    http, client = env
    assert end(http, {"call_id": "nobody@pbx"}).status_code == 200
    time.sleep(0.05)
    assert client.live.sessions.of("hangup") == []


def test_ended_during_accept_hangs_up_after_accept(env):
    http, client = env
    client.live.sessions.accept_delay = 0.3
    incoming(http, "live_2", "slow@pbx")
    wait(lambda: http.app.state.svc.registry.get("live_2") is not None)
    assert http.app.state.svc.registry.get("live_2").status == "accepting"
    assert end(http, {"call_id": "slow@pbx"}).status_code == 200
    wait(lambda: client.live.sessions.of("hangup"))
    call = http.app.state.svc.registry.get("live_2")
    assert call.status == "ended" and call.end_reason == "pbx_hangup"
    assert "live_2" not in client.live.sideband.conns  # sideband를 열지 않는다


def test_rejects_bad_signature_old_timestamp_and_bad_body(env):
    http, client = env
    assert end(http, {"call_id": "x"}, secret="wrong").status_code == 401
    assert end(http, {"call_id": "x"}, ts=int(time.time()) - 3600).status_code == 401
    assert http.post("/pbx/webhook/call-ended", content=b"{}").status_code == 401  # 서명 없음
    assert end(http, {"no_call_id": 1}).status_code == 400


def test_closed_without_secret(monkeypatch):
    monkeypatch.delenv("PBX_WEBHOOK_SECRET", raising=False)
    with TestClient(create_app(client=FakeClient(), backend=FakeBackend())) as http:
        assert end(http, {"call_id": "x"}).status_code == 503
