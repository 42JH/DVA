"""수신 웹훅(서명한 가짜 OpenAI 웹훅)과 PBX 종료 웹훅(Bearer 토큰). 실제 OpenAI·PBX를 부르지 않는다."""

import json
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from conftest import CALLER, WEBHOOK_SECRET, run, signed_webhook
from fastapi import FastAPI
from fastapi.testclient import TestClient
from openai import AsyncOpenAI

from pbx_webhook import (CallEnded, caller_from_headers, create_call_ended_router, create_incoming_router,
                         hangup_quietly, mask_phone, normalize_caller, token_ok)

URL = "/api/webhooks/openai/call-incoming"
SECRET = "pbx-test-secret"


def wait(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < end, "시간 안에 조건이 맞지 않음"
        time.sleep(0.01)


@pytest.fixture
def incoming():
    got = []

    async def on_incoming(call):
        got.append(call)

    client = AsyncOpenAI(api_key="test", webhook_secret=WEBHOOK_SECRET)
    app = FastAPI()
    app.include_router(create_incoming_router(client, on_incoming))
    with TestClient(app) as http:
        yield http, got


def test_signed_sip_incoming_reaches_callback_once(incoming):
    http, got = incoming
    body, headers = signed_webhook("live.transport.incoming", "live_1")
    assert http.post(URL, content=body, headers=headers).status_code == 200
    assert http.post(URL, content=body, headers=headers).status_code == 200  # 같은 webhook-id 재전송
    wait(lambda: got)
    time.sleep(0.05)
    assert len(got) == 1
    call = got[0]
    assert call.session_id == "live_1" and call.caller == CALLER and call.incoming_at.endswith("Z")


def test_bad_signature_and_other_events_are_ignored(incoming):
    http, got = incoming
    body, headers = signed_webhook("live.transport.incoming", "live_2", secret="whsec_" + "d3Jvbmc=")
    assert http.post(URL, content=body, headers=headers).status_code == 400
    body, headers = signed_webhook("realtime.call.incoming", "live_3")
    assert http.post(URL, content=body, headers=headers).status_code == 200
    time.sleep(0.05)
    assert got == []


def test_callback_failure_does_not_break_webhook():
    async def boom(call):
        raise RuntimeError("accept 실패")

    app = FastAPI()
    app.include_router(create_incoming_router(AsyncOpenAI(api_key="test", webhook_secret=WEBHOOK_SECRET), boom))
    with TestClient(app) as http:
        body, headers = signed_webhook("live.transport.incoming", "live_4")
        assert http.post(URL, content=body, headers=headers).status_code == 200


def ended_body(call_from: str = CALLER, ended_at: datetime | None = None) -> dict:
    """PBX가 팀 백엔드에 보내는 것과 같은 형식."""
    ended_at = ended_at or datetime.now(timezone.utc)
    return {"recordingId": "rec-1", "callFrom": call_from, "callTo": "07012345678",
            "startedAt": (ended_at - timedelta(seconds=180)).isoformat(), "endedAt": ended_at.isoformat(),
            "durationSeconds": 180, "recordingUrl": "https://pbx.example/recordings/rec-1.mp3"}


@pytest.fixture
def ended(monkeypatch):
    monkeypatch.setenv("PBX_WEBHOOK_SECRET", SECRET)
    got: list[CallEnded] = []

    async def on_ended(event):
        got.append(event)

    app = FastAPI()
    app.include_router(create_call_ended_router(on_ended))
    with TestClient(app) as http:
        yield http, got


def post_end(http, body, token=SECRET, scheme="Bearer"):
    headers = {"content-type": "application/json"}
    if token is not None:
        headers["authorization"] = f"{scheme} {token}"
    return http.post("/pbx/webhook/call-ended", content=json.dumps(body).encode(), headers=headers)


def test_call_ended_parses_and_normalizes_caller(ended):
    http, got = ended
    assert post_end(http, ended_body(call_from="+8210" + CALLER[3:])).status_code == 200
    assert got[0].caller == CALLER and got[0].recording_id == "rec-1" and got[0].ended_at.tzinfo


def test_call_ended_auth_and_validation(ended, monkeypatch):
    http, got = ended
    assert post_end(http, ended_body(), token=None).status_code == 401
    assert post_end(http, ended_body(), token="wrong").status_code == 401
    assert post_end(http, ended_body(), scheme="Basic").status_code == 401
    assert post_end(http, {"callFrom": CALLER}).status_code == 400  # endedAt 없음
    assert post_end(http, {**ended_body(), "endedAt": "2026-11-03T10:00:00"}).status_code == 400  # 시간대 없음
    monkeypatch.delenv("PBX_WEBHOOK_SECRET")
    assert post_end(http, ended_body()).status_code == 503
    assert got == []


def test_sip_helpers():
    headers = [SimpleNamespace(name="To", value="<sip:x@y>"), SimpleNamespace(name="From", value="<sip:+821012345678@pbx>")]
    assert caller_from_headers(headers) == CALLER
    assert caller_from_headers([SimpleNamespace(name="f", value="anonymous")]) is None
    assert normalize_caller("010-1234-5678") == CALLER and normalize_caller("abc") is None
    assert mask_phone(CALLER) == "010****5678" and mask_phone(None) == "알 수 없음"
    assert token_ok("s", "Bearer s") and not token_ok("s", "Bearer t") and not token_ok("s", None)


def test_hangup_quietly_treats_404_as_already_ended():
    class Gone(Exception):
        status_code = 404

    class Sessions:
        def __init__(self, error=None):
            self.error, self.calls = error, []

        async def hangup(self, session_id):
            self.calls.append(session_id)
            if self.error:
                raise self.error

    ok = SimpleNamespace(live=SimpleNamespace(sessions=Sessions()))
    assert run(hangup_quietly(ok, "live_1")) is True
    gone = SimpleNamespace(live=SimpleNamespace(sessions=Sessions(Gone())))
    assert run(hangup_quietly(gone, "live_1")) is False
    broken = SimpleNamespace(live=SimpleNamespace(sessions=Sessions(RuntimeError("500"))))
    with pytest.raises(RuntimeError):
        run(hangup_quietly(broken, "live_1"))
