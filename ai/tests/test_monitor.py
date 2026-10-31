import re
import shutil
import subprocess
from pathlib import Path

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
    for path in ("/monitor", "/monitor/api/calls", "/monitor/api/orders", "/monitor/api/stream", "/monitor/api/graph"):
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


def test_monitor_graph_draws_every_stage(http):
    from app.flow import engine

    g = http.get("/monitor/api/graph", auth=AUTH).json()
    assert g["stages"] == list(engine.STAGES)
    for name in engine.STAGES:
        assert f'    {name}["{name}' in g["mermaid"]
    assert '  HUB -->|"hub.order"| B_ORIGIN_ROUTE' in g["mermaid"]


def test_health_is_public(http):
    assert http.get("/health").json()["status"] == "ok"


def test_mock_backend_used_without_backend_url(monkeypatch):
    """BACKEND_MOCK=true면 BACKEND_API_URL 없이 메모리 가짜 백엔드로 뜬다."""
    from app.mock_backend import MockBackend

    monkeypatch.setenv("BACKEND_MOCK", "true")
    monkeypatch.delenv("BACKEND_API_URL", raising=False)
    with TestClient(create_app(client=FakeClient())) as http:
        assert isinstance(http.app.state.svc.backend, MockBackend)


@pytest.mark.skipif(shutil.which("node") is None, reason="node가 없으면 문법 검사를 건너뛴다")
def test_monitor_page_script_parses(tmp_path):
    """관제 화면의 인라인 스크립트에 문법 오류가 있으면 화면 전체(통화 목록·SSE)가 멈춘다."""
    html = (Path(__file__).parents[1] / "app/monitor/static/index.html").read_text(encoding="utf-8")
    script = tmp_path / "monitor.js"
    script.write_text(re.findall(r"<script>(.*?)</script>", html, re.S)[-1], encoding="utf-8")
    result = subprocess.run(["node", "--check", str(script)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
