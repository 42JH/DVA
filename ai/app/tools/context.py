"""도구가 쓰는 통화 하나의 자원. 업무 상태는 state(도메인)에만 있고, 도구끼리 몰래 값을 넘기지 않는다
(옛 ToolContext의 pin_candidates·orders → state.candidates). 상태 변경은 lock 안에서만(concurrency.md §3.1)."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
import time
from typing import Any

from app.domain.state import ConversationState
from app.policy.model import Policy


@dataclass
class ToolContext:
    session_id: str
    state: ConversationState
    policy: Policy
    backend: Any                                  # app.integrations.backend.gateway.BackendGateway
    address: Any = None                           # app.integrations.address.AddressService(없으면 보정 없이 들은 그대로)
    rag: Callable[[str], Awaitable[dict]] | None = None   # 원본 RagService(수정 금지) 검색 함수
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
    clock: Callable[[], float] = time.time       # 서버 수신 시계(확인 발급 issued_t)
    # 설정(기존 값: tools/context.py·config)
    tool_budget_sec: float = 3.0                  # error-recovery.md §3 읽기 도구
    rag_budget_sec: float = 12.0                  # 원본 [rag] timeout_sec(RAG 담당 설정을 따른다)
    rag_min_score: float | None = None
    pin_recent_count: int = 5
    max_pin_options: int = 3
    lookup_limit: int = 5                         # P10
    draft_intake: bool = False
    pending_drafts: Callable[[], bool] | None = None
    ops: dict[str, dict] = field(default_factory=dict)       # 쓰기 작업(취소) 상태: 중복 실행 방지
    outputs: dict[str, dict] = field(default_factory=dict)   # call_id → 결과(같은 함수 호출 재수신, F15)
    item_utterance: tuple[int, str] | None = None  # 이 도구 호출과 연결된 고객 발화
