import pytest

from app.config import config_dir, prompts_dir
from app.live_session import LiveConfigError, build_session, build_backend, load_live_toml

BASE = (config_dir() / "live.toml").read_text(encoding="utf-8")


def write(tmp_path, text):
    p = tmp_path / "live.toml"
    p.write_text(text, encoding="utf-8")
    return p


def test_build_session_fills_server_owned_parts(tmp_path):
    text = BASE.replace('# format = { type = "audio/pcm", rate = 24000 }', 'format = { type = "audio/pcm", rate = 24000 }')
    s = build_session("\n[통화 정보] 테스트", write(tmp_path, text))
    assert s["type"] == "live" and s["model"] == "gpt-live-1"
    assert "format" not in s["audio"]
    assert s["instructions"].endswith("[통화 정보] 테스트")
    assert 'backend' not in s and s['delegation']['type'] == 'responses'
    assert s['delegation']['responses']['tools'] and 'acknowledgement_delay_ms' not in s['delegation']
    backend = build_backend(load_live_toml(write(tmp_path, text)))
    assert backend['instructions'].startswith('# 역할')
    tool = backend['tools'][0]
    assert tool["strict"] is True and tool["description"] and tool["parameters"]["type"] == "object"
    assert s["input"][0]["role"] == "developer"


@pytest.mark.parametrize("change, message", [
    (lambda t: t.replace('type = "responses"', 'type = "other"'), "delegation.type"),
    (lambda t: t.replace('name = "cancel_order"', 'name = "launch_rocket"'), "launch_rocket"),
    (lambda t: t.replace('instructions_file = "voice.md"', 'instructions_file = "nope.md"'), "nope.md"),
    (lambda t: t + "\n[broken", "live.toml"),
    (lambda t: t.replace('model = "gpt-6-luna"', ""), "model"),
    (lambda t: t.replace("store = false", 'store = "yes please"'), "형식"),
])
def test_bad_config_raises(tmp_path, change, message):
    with pytest.raises(LiveConfigError, match=message):
        build_session("", write(tmp_path, change(BASE)), prompts_dir())


def test_missing_file(tmp_path):
    with pytest.raises(LiveConfigError):
        build_session("", tmp_path / "none.toml")


def test_client_delegation_remains_valid():
    import tomllib
    data = tomllib.loads(BASE)
    data['delegation']['type'] = 'client'  # 실제 통화 확인 전까지 보류한 방식(docs/WORKLOG.md 2026-10-28)
    session = build_session('', data=data)
    assert 'responses' not in session['delegation'] and 'backend' not in session
    assert session['delegation']['acknowledgement_delay_ms'] == 800
