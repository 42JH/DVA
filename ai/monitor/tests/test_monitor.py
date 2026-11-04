"""관제 라우터(원본 ai/tests/test_monitor.py 중 흐름 엔진·옛 주문 API와 무관한 것)."""

import re
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from monitor import Bus, create_monitor_router

AUTH = ("admin", "pw")
CALL = {"session_id": "live_m", "caller": "010****5678", "started_at": 1.0, "status": "active",
        "transcript": [], "tool_calls": [], "events": [], "errors": [], "detail": {}}


def make_app(calls):
    app = FastAPI()
    app.include_router(create_monitor_router(lambda: list(calls), Bus(), keepalive_sec=0.05))
    return app


@pytest.fixture
def http(monkeypatch):
    monkeypatch.setenv("MONITOR_USER", AUTH[0])
    monkeypatch.setenv("MONITOR_PASSWORD", AUTH[1])
    with TestClient(make_app([CALL])) as c:
        yield c


def test_monitor_requires_auth(http):
    for path in ("/monitor", "/monitor/api/calls", "/monitor/api/stream"):
        assert http.get(path).status_code == 401
        assert http.get(path, auth=("admin", "wrong")).status_code == 401


def test_monitor_closed_without_credentials(monkeypatch):
    monkeypatch.delenv("MONITOR_USER", raising=False)
    monkeypatch.delenv("MONITOR_PASSWORD", raising=False)
    with TestClient(make_app([])) as c:
        assert c.get("/monitor", auth=AUTH).status_code == 503


def test_monitor_lists_calls_and_serves_page(http):
    assert http.get("/monitor/api/calls", auth=AUTH).json() == [CALL]
    page = http.get("/monitor", auth=AUTH)
    assert page.text.startswith("<!doctype html>") and page.headers["cache-control"] == "no-store"


def test_bus_drops_for_slow_subscriber():
    bus = Bus()
    q = bus.subscribe()
    for i in range(300):
        bus.publish({"i": i})
    assert q.qsize() == 256  # 넘친 알림은 버린다(통화 쪽은 기다리지 않음)
    bus.unsubscribe(q)
    bus.publish({"i": -1})
    assert q.qsize() == 256


@pytest.mark.skipif(shutil.which("node") is None, reason="node가 없으면 문법 검사를 건너뛴다")
def test_monitor_page_script_parses(tmp_path):
    """인라인 스크립트에 문법 오류가 있으면 화면 전체(통화 목록·SSE)가 멈춘다."""
    html = (Path(__file__).parents[1] / "static/index.html").read_text(encoding="utf-8")
    script = tmp_path / "monitor.js"
    script.write_text(re.findall(r"<script>(.*?)</script>", html, re.S)[-1], encoding="utf-8")
    result = subprocess.run(["node", "--check", str(script)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
