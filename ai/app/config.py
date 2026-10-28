"""서버 설정(config/server.toml)과 진행 문구(prompts/flow.toml) 읽기."""

import os
import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ROOT = Path(__file__).resolve().parent.parent


def config_dir() -> Path:
    return Path(os.environ.get("CONFIG_DIR", ROOT / "config"))


def prompts_dir() -> Path:
    return Path(os.environ.get("PROMPTS_DIR", ROOT / "prompts"))


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CallConfig(_Strict):
    max_concurrent: int = Field(ge=1, le=500)
    reject_status_code: int = Field(ge=300, le=699)
    hangup_silence_sec: float = Field(gt=0)
    hangup_max_wait_sec: float = Field(gt=0)
    idle_hangup_sec: float = Field(gt=0)
    max_call_sec: float = Field(gt=0)
    refer_target_uri: str = Field(pattern=r"^sips?:")
    webhook_dedupe_sec: int = Field(ge=60)
    tool_timeout_sec: float = Field(gt=0)


class BusinessConfig(_Strict):
    company_name: str = Field(min_length=1)
    submitted_message: str
    goodbye_message: str


class ProgressConfig(_Strict):
    max_chars: int = Field(ge=100, le=1000)


class BackendConfig(_Strict):
    mock: bool = False
    timeout_sec: float = Field(gt=0)
    submit_timeout_sec: float = Field(gt=0)
    submit_retry_sec: float = Field(ge=0)
    retry_interval_sec: float = Field(gt=0)
    lookup_limit: int = Field(ge=1, le=20)
    monitor_orders_limit: int = Field(ge=1, le=1000)


class MonitorConfig(_Strict):
    sse_keepalive_sec: float = Field(gt=0)
    retain_ended_sec: int = Field(ge=0)
    call_history_keep: int = Field(ge=0)
    bubble_gap_ms: int = Field(ge=0)


class ListenerConfig(_Strict):
    model: str = Field(min_length=1)
    reasoning_effort: Literal["none", "minimal", "low", "medium", "high"]
    pause_ms: int = Field(ge=100, le=5000)
    timeout_sec: float = Field(gt=0)
    max_heard_chars: int = Field(ge=50, le=2000)
    max_agent_chars: int = Field(ge=0, le=2000)
    max_choices: int = Field(ge=2, le=100)


class AddressConfig(_Strict):
    db_path: str = Field(min_length=1)
    kakao_timeout_sec: float = Field(gt=0)


class PersonaConfig(_Strict):
    wait_poll_sec: float = Field(gt=0)
    retry_sec: float = Field(gt=0)
    report_attempts: int = Field(ge=1, le=10)
    max_prompt_chars: int = Field(ge=100, le=20000)


class ServerConfig(_Strict):
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"]
    call: CallConfig
    business: BusinessConfig
    progress: ProgressConfig
    backend: BackendConfig
    monitor: MonitorConfig
    listener: ListenerConfig
    address: AddressConfig
    persona: PersonaConfig
    rag: 'RagConfig'
    client_backend: 'ClientBackendConfig'


class RagConfig(_Strict):
    collection: str = Field(min_length=1)
    embedding_model: Literal['text-embedding-3-large']
    dimensions: Literal[3072]
    bm25_weight: float = Field(gt=0, lt=1)
    rrf_c: int = Field(ge=1)
    candidate_k: Literal[5]
    context_k: Literal[3]
    timeout_sec: float = Field(gt=0)
    http_timeout_sec: float = Field(gt=0)
    retry_cooldown_sec: float = Field(gt=0)


class ClientBackendConfig(_Strict):
    timeout_sec: float = Field(gt=0)
    transcript_wait_sec: float = Field(gt=0)
    history_chars: int = Field(ge=200, le=16000)
    max_delegations: int = Field(ge=1, le=1000)
    context_chunk_tokens: int = Field(ge=50, le=350)
    append_timeout_sec: float = Field(gt=0)


def load_server_config(path: Path | None = None) -> ServerConfig:
    path = path or config_dir() / "server.toml"
    with path.open("rb") as f:
        return ServerConfig.model_validate(tomllib.load(f))


class Texts(_Strict):
    """모델에게 줄 진행 문구. 단계 정의에 문구를 박지 않고 여기서 가져온다."""

    labels: dict[str, str]
    fields: dict[str, str]
    stages: dict[str, str]
    customer_types: dict[str, str]
    call_info: str
    progress: str
    progress_then: str
    progress_item: str
    progress_sep: str
    saved_value: str
    caller_value: str
    empty_value: str
    classifier: str
    answer_error: str


def load_texts(path: Path | None = None) -> Texts:
    path = path or prompts_dir() / "flow.toml"
    with path.open("rb") as f:
        return Texts.model_validate(tomllib.load(f))
