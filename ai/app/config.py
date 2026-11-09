"""원본 RAG(app/rag/, app/webhooks/faqs.py, scripts/, tests/)가 import하는 원본 서버 설정 모듈의 **호환판**.

RAG는 다른 담당자의 구현이라 수정하지 않는다(docs/architecture/decisions.md RAG). 그래서 원본 app/config.py에서 RAG가 쓰는
이름만 같은 동작으로 둔다: ROOT, config_dir(), prompts_dir(), RagConfig, FaqSyncConfig, load_server_config().rag/.faq_sync.
RagConfig·FaqSyncConfig와 두 설정의 검증은 원본 정의를 그대로 옮겼다. 통화 흐름·BE·관제 등 원본의 나머지 설정은 두지 않는다."""

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
    model_config = ConfigDict(extra="forbid")


# --- 원본 app/config.py 정의 그대로(RAG 담당) ---

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


# --- 호환판: 원본 ServerConfig 중 RAG가 읽는 것만 ---

class BackendConfig(_Strict):
    """[backend]. timeout_sec는 원본 RAG 스크립트(scripts/bootstrap_faq.py, validate_faq_crud.py)도 읽는다.
    나머지는 새 서버 전용(concurrency.md §6, error-recovery.md §3)."""
    timeout_sec: float = Field(gt=0)
    max_concurrency: int = Field(16, gt=0)       # BE 동시 요청 세마포어 = 연결 풀 상한
    read_budget_sec: float = Field(3.0, gt=0)    # 읽기 도구 예산(세마포어 대기 포함)
    write_budget_sec: float = Field(5.0, gt=0)   # 취소 등 쓰기 예산
    submit_timeout_sec: float = Field(15.0, gt=0)  # 통화 결과 요청 1회
    submit_retry_sec: float = Field(40.0, gt=0)    # 통화 결과 같은 키 재확인 총 시간
    result_resend_sec: float = Field(60.0, ge=0)   # SENT_UNCERTAIN 결과를 실행 중 같은 키로 재확인하는 주기(0이면 끔)
    # 분석에 hasCallbackRequest를 넣는다. 048 + 새 BE(feature/ai-call-updates) 배포 전에는 false(구버전 BE가 400으로 거절)
    analysis_callback_field: bool = False
    parcel_draft_intake: bool = False   # 055 백엔드와 함께 전환


class FareConfig(_Strict):
    """규격 하나당 배송비(원). 없으면 그 규격의 배송비를 모른다(미완료로 넘김). 원본 app/config.py FareConfig 그대로."""
    document: int | None = Field(None, gt=0, le=2_147_483_647)
    small_box: int | None = Field(None, gt=0, le=2_147_483_647)
    medium_box: int | None = Field(None, gt=0, le=2_147_483_647)
    big_box: int | None = Field(None, gt=0, le=2_147_483_647)


class CallConfig(_Strict):
    """[call] 통화 생명주기(call-lifecycle.md §2). 수치는 실측 후 조정."""
    max_active_calls: int = Field(20, gt=0)          # 넘으면 reject(486)
    stage1_budget_sec: float = Field(1.5, gt=0)      # accept 전 고객 확인(실패 시 UNREGISTERED)
    stage2_budget_sec: float = Field(3.0, gt=0)      # 업무 의도 확정 후 통화 등록
    persona_budget_sec: float = Field(1.0, gt=0)     # 통화 진입 때 페르소나 동기화(넘으면 마지막 ACTIVE, 없으면 서버 기본 P2)
    persona_retry_sec: float = Field(5.0, gt=0)      # 동기화·적용 회신 실패 후 재시도 간격(원본 [persona] retry_sec)
    persona_report_attempts: int = Field(3, gt=0)    # 적용 회신 시도 횟수(원본 report_attempts)
    persona_max_prompt_chars: int = Field(20000, gt=0)  # 넘으면 INVALID_CONFIG 회신(원본 max_prompt_chars)
    recent_destinations: int = Field(5, ge=0)
    # 미완료 주문 이어받기(사용자 결정 2026-11-06, 일주일): 주문 createdAt부터 이 시간 안이면 묻는다. 확인은 접수 의도 때 이만큼 기다린다
    resume_window_sec: float = Field(0.0, ge=0)
    resume_wait_sec: float = Field(1.5, ge=0)
    closing_quiet_ms: int = Field(1200, ge=1000)     # 마무리: AI 발화 끝 뒤 이만큼 조용하면 끊는다(전달 지연 — 최소 1초)
    closing_result_wait_sec: float = Field(5.0, gt=0)  # 접수 완료 단계: 결과를 이만큼 기다려 마무리 안내에 쓴다(넘으면 pending)
    closing_max_sec: float = Field(15.0, gt=0)       # 마무리 최대 대기
    silence_sec: float = Field(30.0, gt=0)           # 고객 무발화
    expire_margin_sec: float = Field(60.0, ge=0)     # 세션 만료 전 마무리
    finalize_wait_sec: float = Field(5.0, gt=0)      # 정리 때 진행 작업 대기 상한
    # S5: 발화 끝 Decision·확정·전달(delegation.md §3·§6)
    utterance_gap_ms: int = Field(800, gt=0)         # 마지막 입력 delta 뒤 무 delta → 발화 끝(S0c·S0d)
    decision_budget_sec: float = Field(1.0, gt=0)    # S0d API p95 943ms — 넘으면 판단 없음
    decision_min_confidence: float = Field(0.6, gt=0, le=1)  # task·switch·pick·pay 적용 하한
    unanswered_agent_after: int = Field(3, gt=0)     # 매뉴얼 검색 연속 미답변 → 상담원 권유(업무 규칙 h)
    # 상담원 연결(업무 규칙 e). 전환 대상 SIP URI가 비면 전환하지 않는다(미준비). 근무 시간 밖이면 콜백 제안
    agent_transfer_uri: str = ""
    agent_open: str = "09:00"
    agent_close: str = "18:00"
    agent_days: tuple[int, ...] = (0, 1, 2, 3, 4)    # 월=0 … 일=6
    commit_delay_ms: int = Field(700, ge=0)          # 확인 "예" 뒤 확정 지연(새 입력이 오면 취소)
    notify_quiet_ms: int = Field(600, gt=0)          # N2는 AI 발화가 이만큼 멈춘 뒤 보낸다
    n3_max: int = Field(3, ge=0)                     # P4: 정정 3회
    response_fallback_sec: float = Field(3.0, gt=0)  # response.completed가 안 와도 결과 뒤 response.create


class UnansweredReviewConfig(_Strict):
    enabled: bool = False
    # 백엔드 reason 허용값·필수 여부·배포 확인 전에는 전송 보류
    reason_contract_enabled: bool = False
    # 첨부 배열 계약 + migration 052·배열 지원 백엔드 배포 후 활성화
    faq_answered_enabled: bool = False
    timeout_sec: float = Field(30.0, gt=0, le=120)
    max_input_chars: int = Field(100000, ge=1000, le=1000000)
    max_output_tokens: int = Field(6000, ge=100, le=30000)
    max_attempts: int = Field(3, ge=1, le=10)
    poll_sec: float = Field(30.0, ge=1, le=300)


class ServerConfig(_Strict):
    rag: RagConfig
    faq_sync: FaqSyncConfig
    backend: BackendConfig
    fare: FareConfig = FareConfig()
    call: CallConfig = CallConfig()
    unanswered_review: UnansweredReviewConfig = UnansweredReviewConfig()

    @model_validator(mode='after')
    def separate_faq_collection(self):  # 원본 ServerConfig의 같은 검증
        if self.faq_sync.collection == self.rag.collection:
            raise ValueError('FAQ 관리 컬렉션은 기존 MD 검색 컬렉션과 분리해야 합니다.')
        return self


def load_server_config(path: Path | None = None) -> ServerConfig:
    """서버·RAG·통화·종료 검토 섹션을 읽는다(호환 대상이 아닌 다른 섹션은 무시)."""
    path = path or config_dir() / "server.toml"
    with path.open("rb") as f:
        data = tomllib.load(f)
    backend = data.get("backend") or {}
    return ServerConfig.model_validate({"rag": data.get("rag"), "faq_sync": data.get("faq_sync"), "backend": backend,
                                        "fare": data.get("fare") or {},
                                        "call": data.get("call") or {},
                                        "unanswered_review": data.get("unanswered_review") or {}})
