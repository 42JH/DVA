import pytest

from app.config import config_dir, prompts_dir
from app.live_session import LiveConfigError, build_session

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
    assert "instructions_file" not in s and "instructions_file" not in s["delegation"]["responses"]
    assert s["delegation"]["responses"]["instructions"].startswith("# 역할")
    tool = s["delegation"]["responses"]["tools"][0]
    assert tool["strict"] is True and tool["description"] and tool["parameters"]["type"] == "object"
    assert s["input"][0]["role"] == "developer"


@pytest.mark.parametrize("change, message", [
    (lambda t: t.replace('type = "responses"', 'type = "client"'), "responses"),
    (lambda t: t.replace('name = "end_call"', 'name = "launch_rocket"'), "launch_rocket"),
    (lambda t: t.replace('instructions_file = "voice.md"', 'instructions_file = "nope.md"'), "nope.md"),
    (lambda t: t + "\n[broken", "live.toml"),
    (lambda t: t.replace('model = "gpt-5.4-mini"', ""), "model"),
    (lambda t: t.replace("store = false", 'store = "yes please"'), "형식"),
])
def test_bad_config_raises(tmp_path, change, message):
    with pytest.raises(LiveConfigError, match=message):
        build_session("", write(tmp_path, change(BASE)), prompts_dir())


def test_missing_file(tmp_path):
    with pytest.raises(LiveConfigError):
        build_session("", tmp_path / "none.toml")
