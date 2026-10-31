"""서버 설정(config/server.toml)과 진행 문구(prompts/flow.toml) 읽기."""

import os
import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
    record_heard: bool = False


class AddressConfig(_Strict):
    db_path: str = Field(min_length=1)
    kakao_timeout_sec: float = Field(gt=0)


class PersonaConfig(_Strict):
    wait_poll_sec: float = Field(gt=0)
    retry_sec: float = Field(gt=0)
    report_attempts: int = Field(ge=1, le=10)
    max_prompt_chars: int = Field(ge=100, le=20000)


class FlowConfig(_Strict):
    pin_recent_count: int = Field(ge=1, le=50)
    commit_delay_ms: int = Field(ge=100, le=5000)
    max_pin_options: int = Field(ge=2, le=10)
    rag_wait_sec: float = Field(gt=0)
    retry_limit: int = Field(ge=0, le=5)
    agent_open_hour: int = Field(ge=0, le=24)
    agent_close_hour: int = Field(ge=0, le=24)
    heard_grace_ms: int = Field(ge=0, le=2000)
    flush_wait_sec: float = Field(gt=0)


class FareConfig(_Strict):
    """규격 하나당 배송비(원). 없으면 그 규격의 배송비를 모른다(미완료로 넘김)."""
    document: int | None = Field(None, gt=0, le=2_147_483_647)
    small_box: int | None = Field(None, gt=0, le=2_147_483_647)
    medium_box: int | None = Field(None, gt=0, le=2_147_483_647)
    big_box: int | None = Field(None, gt=0, le=2_147_483_647)


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
    flow: FlowConfig
    fare: FareConfig = FareConfig()
    rag: 'RagConfig'
    client_backend: 'ClientBackendConfig'
    faq_sync: 'FaqSyncConfig'

    @model_validator(mode='after')
    def separate_faq_collection(self):
        if self.faq_sync.collection == self.rag.collection:
            raise ValueError('FAQ 관리 컬렉션은 기존 MD 검색 컬렉션과 분리해야 합니다.')
        return self

    @model_validator(mode="after")
    def _commit_after_pause(self):
        # 확정 지연 중 들어온 말을 판별하려면 말 멈춤 대기보다 길어야 한다(LANGGRAPH_REBUILD §9)
        if self.flow.commit_delay_ms <= self.listener.pause_ms:
            raise ValueError("flow.commit_delay_ms는 listener.pause_ms보다 길어야 한다")
        return self


class FaqSyncConfig(_Strict):
    receive_enabled: bool
    db_path: str = Field(min_length=1)
    max_pending: int = Field(ge=1, le=100000)
    max_body_bytes: int = Field(ge=4096, le=102400)
    accept_timeout_sec: float = Field(gt=0, lt=2)
    busy_timeout_sec: float = Field(gt=0, le=0.5)
    chunk_size: int = Field(ge=1, le=20000)
    chunk_overlap: int = Field(ge=0)
    collection: str = Field(min_length=1)
    embedding_batch_size: int = Field(ge=1, le=100)
    process_enabled: bool
    poll_sec: float = Field(gt=0, le=60)
    retry_base_sec: float = Field(gt=0, le=300)
    retry_max_sec: float = Field(gt=0, le=3600)
    reconcile_sec: float = Field(gt=0, le=3600)

    @model_validator(mode='after')
    def valid_chunk_overlap(self):
        if self.chunk_overlap >= self.chunk_size:
            raise ValueError('FAQ 청크 겹침은 청크 크기보다 작아야 합니다.')
        if self.retry_max_sec < self.retry_base_sec:
            raise ValueError('FAQ 재시도 최대 간격은 최초 간격 이상이어야 합니다.')
        if self.process_enabled and not self.receive_enabled:
            raise ValueError('FAQ 자동 처리를 켜려면 영속 접수도 켜야 합니다.')
        return self


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
    min_score: float | None = None  # 1등 근거의 리랭커 점수가 이보다 낮으면 답할 자료 없음(RAG No). 없으면 근거 유무만 본다


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
    """모델에게 줄 진행 문구. 단계 정의에 문구를 박지 않고 여기서 가져온다.
    say: 고객에게 할 말(키 = LANGGRAPH_REBUILD 표의 ID), note: 따옴표 없이 주는 할 일, core: 질문의 핵심 구간."""

    labels: dict[str, str]
    say: dict[str, str]
    note: dict[str, str]
    core: dict[str, str]
    correction_labels: dict[str, str]
    task_names: dict[str, str]
    status_names: dict[str, str]
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
    record_heard: str
    reask: str
    drift_fix: str
    drift_markers: list[str]


def load_texts(path: Path | None = None) -> Texts:
    path = path or prompts_dir() / "flow.toml"
    with path.open("rb") as f:
        return Texts.model_validate(tomllib.load(f))
