import pytest
from conftest import FakeClient, FakeBackend, signed_webhook
from fastapi.testclient import TestClient

from app.main import create_app

AUTH = ("admin", "pw")


@pytest.fixture
def http(monkeypatch):
    monkeypatch.setenv("MONITOR_USER", AUTH[0])
    monkeypatch.setenv("MONITOR_PASSWORD", AUTH[1])
    with TestClient(create_app(client=FakeClient(), backend=FakeBackend())) as c:
        yield c


def test_monitor_requires_auth(http):
    for path in ("/monitor", "/monitor/api/calls", "/monitor/api/orders", "/monitor/api/stream"):
        assert http.get(path).status_code == 401
        assert http.get(path, auth=("admin", "wrong")).status_code == 401


def test_monitor_closed_without_credentials(monkeypatch):
    monkeypatch.delenv("MONITOR_USER", raising=False)
    monkeypatch.delenv("MONITOR_PASSWORD", raising=False)
    with TestClient(create_app(client=FakeClient(), backend=FakeBackend())) as c:
        assert c.get("/monitor", auth=AUTH).status_code == 503


def test_monitor_lists_calls_with_masked_caller(http):
    import time

    http.post("/api/webhooks/openai/call-incoming", content=(w := signed_webhook("live.transport.incoming", "live_m"))[0], headers=w[1])
    for _ in range(100):
        calls = http.get("/monitor/api/calls", auth=AUTH).json()
        if calls:
            break
        time.sleep(0.01)
    assert calls[0]["session_id"] == "live_m" and calls[0]["caller"] == "010****5678"
    assert http.get("/monitor", auth=AUTH).text.startswith("<!doctype html>")
    assert http.get("/monitor/api/orders", auth=AUTH).json() == []


def test_health_is_public(http):
    assert http.get("/health").json()["status"] == "ok"
