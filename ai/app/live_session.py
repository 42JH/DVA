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
    tools = backend_settings(data).get('tools') or []
    return [t.get("name") for t in tools if t.get("type") == "function"]


def backend_settings(data: dict) -> dict:
    return data.get('backend') or ((data.get('delegation') or {}).get('responses') or {})


def build_backend(data: dict, prompts: Path | None = None) -> dict:
    import copy
    responses = copy.deepcopy(backend_settings(data))
    if not responses.get('model'):
        raise LiveConfigError('백엔드 model이 없음')
    if 'instructions_file' in responses:
        responses['instructions'] = _read_prompt(responses.pop('instructions_file'), prompts or prompts_dir())
    tools = []
    for tool in responses.get('tools') or []:
        if tool.get('type') != 'function' or tool.get('name') not in TOOLS:
            raise LiveConfigError(f"없는 함수 도구: {tool.get('name')}")
        tools.append(TOOLS[tool['name']].spec())
    responses['tools'] = tools
    return responses


def load_live_toml(path: Path | None = None) -> dict:
    path = path or config_dir() / "live.toml"
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise LiveConfigError(f"live.toml 읽기 실패: {e}") from e


def build_session(call_info: str, path: Path | None = None, prompts: Path | None = None, *, data: dict | None = None) -> dict:
    """서버가 바꿔 넣는 것만 바꾸고 나머지 키는 그대로 보낸다."""
    import copy
    data = copy.deepcopy(data) if data is not None else load_live_toml(path)
    prompts = prompts or prompts_dir()
    delegation = data.get("delegation") or {}
    if delegation.get('type') not in ('responses', 'client'):
        raise LiveConfigError('delegation.type은 responses 또는 client만 쓴다')
    responses = build_backend(data, prompts)
    data.pop('backend', None)  # 서버 전용 설정은 Live API에 보내지 않는다.

    if "instructions_file" in data:
        data["instructions"] = _read_prompt(data.pop("instructions_file"), prompts)
    data["instructions"] = (data.get("instructions") or "") + call_info
    if delegation['type'] == 'responses':
        delegation.pop('acknowledgement_delay_ms', None)  # client 전용 맞장구 지연 설정
        delegation['responses'] = responses
    else:
        delegation.pop('responses', None)

    # audio.format은 WebSocket 전용. SIP는 협상하므로 뺀다
    (data.get("audio") or {}).pop("format", None)
    try:
        SessionConfig.model_validate(data)
    except ValidationError as e:
        raise LiveConfigError(f"세션 설정 형식 오류: {e}") from e
    data["type"] = "live"
    return data
