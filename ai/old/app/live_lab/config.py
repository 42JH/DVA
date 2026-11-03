"""웹 실험 전용 설정. 기존 운영 세션과 서버 설정을 변경하지 않는다."""

import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.config import config_dir


class LabConfig(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)
    host: Literal['127.0.0.1', 'localhost']
    port: int = Field(ge=1024, le=65535)
    live_model: Literal['gpt-live-1']
    voice: str
    backend_model: str
    reasoning_effort: str
    voice_prompt: str
    backend_prompt: str
    qwen_python: str
    search_backend: Literal['remote', 'local'] = 'remote'
    max_sessions: int = Field(ge=1, le=10)
    max_session_seconds: float = Field(gt=0)
    retention_seconds: float = Field(gt=0)
    backend_timeout_seconds: float = Field(gt=0)
    search_timeout_seconds: float = Field(gt=0)
    sideband_timeout_seconds: float = Field(gt=0)
    append_timeout_seconds: float = Field(gt=0)
    transcript_wait_seconds: float = Field(gt=0)
    sse_keepalive_seconds: float = Field(gt=0)
    max_events: int = Field(ge=100, le=10000)
    max_turns: int = Field(ge=1, le=1000)
    max_traces: int = Field(ge=1, le=1000)
    backend_max_output_tokens: int = Field(ge=128, le=4096)
    transcript_gap_ms: int = Field(ge=100)
    context_chunk_tokens: int = Field(ge=100, le=400)
    history_chars: int = Field(ge=100, le=16000)


def load_lab_config(path: Path | None = None):
    with (path or config_dir()/'live-lab.toml').open('rb') as file:
        return LabConfig.model_validate(tomllib.load(file))
