"""config/live.toml → accept 본문의 session. 통화가 올 때마다 읽는다(spec/gpt-live-session.md)."""

import tomllib
from pathlib import Path

from openai.types.live import SessionConfig
from pydantic import ValidationError

from app.config import config_dir, prompts_dir
from app.tools._base import TOOLS


class LiveConfigError(Exception):
    pass


def _read_prompt(name: str, base: Path) -> str:
    path = base / name
    if not path.is_file():
        raise LiveConfigError(f"지시문 파일 없음: {path}")
    return path.read_text(encoding="utf-8")


def function_tool_names(data: dict) -> list[str]:
    tools = ((data.get("delegation") or {}).get("responses") or {}).get("tools") or []
    return [t.get("name") for t in tools if t.get("type") == "function"]


def load_live_toml(path: Path | None = None) -> dict:
    path = path or config_dir() / "live.toml"
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise LiveConfigError(f"live.toml 읽기 실패: {e}") from e


def build_session(call_info: str, path: Path | None = None, prompts: Path | None = None) -> dict:
    """서버가 바꿔 넣는 것만 바꾸고 나머지 키는 그대로 보낸다."""
    data = load_live_toml(path)
    prompts = prompts or prompts_dir()
    delegation = data.get("delegation") or {}
    if delegation.get("type") != "responses":
        raise LiveConfigError("delegation.type은 responses만 쓴다")
    responses = delegation.get("responses")
    if not isinstance(responses, dict) or not responses.get("model"):
        raise LiveConfigError("delegation.responses.model이 없음")

    if "instructions_file" in data:
        data["instructions"] = _read_prompt(data.pop("instructions_file"), prompts)
    data["instructions"] = (data.get("instructions") or "") + call_info
    if "instructions_file" in responses:
        responses["instructions"] = _read_prompt(responses.pop("instructions_file"), prompts)

    tools = []
    for t in responses.get("tools") or []:
        if t.get("type") == "function":
            if t.get("name") not in TOOLS:
                raise LiveConfigError(f"없는 함수 도구: {t.get('name')}")
            tools.append(TOOLS[t["name"]].spec())
        else:
            tools.append(t)
    responses["tools"] = tools

    # audio.format은 WebSocket 전용. SIP는 협상하므로 뺀다
    (data.get("audio") or {}).pop("format", None)
    try:
        SessionConfig.model_validate(data)
    except ValidationError as e:
        raise LiveConfigError(f"세션 설정 형식 오류: {e}") from e
    data["type"] = "live"
    return data
