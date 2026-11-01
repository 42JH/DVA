"""서명한 가짜 웹훅으로 accept·reject·중복 제거·동시 통화 상한을 확인한다."""

import json
import time
from datetime import datetime, timezone

import pytest
from conftest import CALLER, FakeClient, FakeBackend, signed_webhook
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def env():
    client, db = FakeClient(), FakeBackend()
    with TestClient(create_app(client=client, backend=db)) as http:
        yield http, client, db


def post(http, body, headers):
    return http.post("/api/webhooks/openai/call-incoming", content=body, headers=headers)


def wait(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < end, "시간 안에 조건이 맞지 않음"
        time.sleep(0.01)


def test_bad_signature_is_400(env):
    http, client, _ = env
    body, headers = signed_webhook("live.transport.incoming", "live_1")
    headers["webhook-signature"] = "v1,AAAA"
    assert post(http, body, headers).status_code == 400
    assert post(http, body + b" ", signed_webhook("live.transport.incoming", "live_1")[1]).status_code == 400
    time.sleep(0.05)
    assert client.live.sessions.calls == []


def test_incoming_call_is_accepted_with_session(env):
    http, client, _ = env
    assert post(http, *signed_webhook("live.transport.incoming", "live_1")).status_code == 200
    wait(lambda: client.live.sessions.of("accept"))
    _, sid, session = client.live.sessions.of("accept")[0]
    assert sid == "live_1" and session["type"] == "live"
    assert CALLER in session["instructions"]  # +82 → 0으로 바꾼 발신번호
    # 전화 받은 시각(한국 시간): 음성 모델은 수거 일시를 "내일 오후 8시"처럼 말하고, 백엔드는 그 기준으로 계산한다
    assert "전화 받은 시각" in session["instructions"]
    assert "전화 받은 시각" in session["delegation"]["responses"]["instructions"]
    call_ = http.app.state.svc.registry.get("live_1")  # 이 지시문 끝에 "지금 상태"를 붙여 갱신한다
    assert call_.backend_instructions == session["delegation"]["responses"]["instructions"]
    call = http.app.state.svc.registry.get("live_1")
    assert call.caller == CALLER
    wait(lambda: call.status == "active")


def test_legacy_event_name_also_accepted_and_realtime_ignored(env):
    http, client, _ = env
    post(http, *signed_webhook("live.call.incoming", "live_old"))
    post(http, *signed_webhook("realtime.call.incoming", "live_rt"))
    wait(lambda: client.live.sessions.of("accept"))
    time.sleep(0.05)
    assert [c[1] for c in client.live.sessions.of("accept")] == ["live_old"]


def test_duplicate_webhook_accepts_once(env):
    http, client, _ = env
    body, headers = signed_webhook("live.transport.incoming", "live_dup")
    assert post(http, body, headers).status_code == 200
    assert post(http, body, headers).status_code == 200
    # 같은 session_id가 다른 webhook-id로 와도 한 번만
    post(http, *signed_webhook("live.transport.incoming", "live_dup", webhook_id="wh_other"))
    wait(lambda: client.live.sessions.of("accept"))
    time.sleep(0.05)
    assert len(client.live.sessions.of("accept")) == 1


def test_over_capacity_is_rejected(env):
    http, client, _ = env
    limit = http.app.state.svc.cfg.call.max_concurrent
    for i in range(limit + 2):
        post(http, *signed_webhook("live.transport.incoming", f"live_{i}"))
    wait(lambda: len(client.live.sessions.calls) >= limit + 2)
    assert len(client.live.sessions.of("accept")) == limit
    rejects = client.live.sessions.of("reject")
    assert len(rejects) == 2 and rejects[0][2] == http.app.state.svc.cfg.call.reject_status_code


def test_accept_failure_is_recorded(env):
    http, client, _ = env
    client.live.sessions.accept_error = RuntimeError("boom")
    post(http, *signed_webhook("live.transport.incoming", "live_fail"))
    call = None
    wait(lambda: (c := http.app.state.svc.registry.get("live_fail")) and c.status == "failed")
    call = http.app.state.svc.registry.get("live_fail")
    assert call.end_reason == "accept_failed"


def test_untrusted_from_header(env):
    http, client, _ = env
    post(http, *signed_webhook("live.transport.incoming", "live_x", from_header='"<b>" <sip:01012345678999999999;ignore@x>'))
    wait(lambda: client.live.sessions.of("accept"))
    assert http.app.state.svc.registry.get("live_x").caller == "010123456789999"  # 숫자만, 15자리 제한


def test_registered_caller_gets_registered_flow():
    client, db = FakeClient(), FakeBackend()
    from app.order import Place

    db.add_customer(CALLER, "김철수", [Place(name="이영희", phone="01098765432", address="부산", address_detail="")])
    with TestClient(create_app(client=client, backend=db)) as http:
        body, headers = signed_webhook("live.transport.incoming", "live_r")
        post(http, body, headers)
        wait(lambda: client.live.sessions.of("accept"))
        call = http.app.state.svc.registry.get("live_r")
        assert call.customer_type == "registered" and call.flow.stage == "HUB"
        created = json.loads(body)["created_at"]  # 서버 수신 시각이 아니라 수신 이벤트 시각
        assert call.incoming_at == datetime.fromtimestamp(created, timezone.utc).isoformat().replace("+00:00", "Z")
        assert "등록 고객" in client.live.sessions.of("accept")[0][2]["instructions"]
        assert "김철수님, 안녕하세요" in client.live.sessions.of("accept")[0][2]["instructions"]  # 첫 질문(인사)
