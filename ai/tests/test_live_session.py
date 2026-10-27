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
    assert 'backend' not in s and 'responses' not in s['delegation']
    assert s['delegation']['type'] == 'client'
    backend = build_backend(load_live_toml(write(tmp_path, text)))
    assert backend['instructions'].startswith('# 역할')
    tool = backend['tools'][0]
    assert tool["strict"] is True and tool["description"] and tool["parameters"]["type"] == "object"
    assert s["input"][0]["role"] == "developer"


@pytest.mark.parametrize("change, message", [
    (lambda t: t.replace('type = "client"', 'type = "other"'), "delegation.type"),
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


def test_legacy_responses_remains_valid_for_rollback():
    import tomllib
    data = tomllib.loads(BASE)
    data['delegation'] = {'type': 'responses', 'responses': data.pop('backend'), 'acknowledgement_delay_ms': 800}
    session = build_session('', data=data)
    assert session['delegation']['responses']['tools'][0]['strict'] is True
    assert 'acknowledgement_delay_ms' not in session['delegation']
