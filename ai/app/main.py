"""새 서버 조립(overview.md §2.1). 공유 클라이언트·게이트웨이를 프로세스에 하나씩 만들고 종료 때 닫는다.

S1: 설정, BE 게이트웨이, trace, /healthz. S4: 통화 수신(OpenAI 웹훅)·PBX 종료 웹훅·관제, 통화 생명주기(app/calls).
함수 호출 처리·발화 끝 Decision은 S5, 결과 전송은 S6 — 그 전까지는 실통화에 쓰지 않는다(Dockerfile CMD는 스파이크).
실행: uv run --env-file .env python -m uvicorn app.main:app --port 8000 --workers 1   (단일 워커, decisions.md P3)
"""

import asyncio
import logging
import os
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import partial
from pathlib import Path

import httpx2
from fastapi import FastAPI

from app.config import ROOT, BackendConfig, ServerConfig, load_server_config
from app.domain.fare import parcel_fare
from app.address.gazetteer import open_db
from app.integrations.address import AddressService
from app.integrations.backend.gateway import BackendGateway
from app.calls.live import LiveFlow
from app.calls.results import ResultService
from app.calls.service import CallDeps, CallService
from app.persistence.outbox import Outbox
from app.observability.trace import TraceFilter
from app.policy.model import load_policy
from app.webhooks.faqs import router as faq_router
from app.webhooks.persona import router as persona_router
from monitor import Bus, create_monitor_router
from pbx_webhook import create_call_ended_router, create_incoming_router
from backend_client.api import BackendAPI
from backend_client.mock import MockBackend

log = logging.getLogger(__name__)


@dataclass
class Services:
    """app.state.svc. 원본 FAQ 웹훅(app/webhooks/faqs.py, 수정 금지)이 cfg·faq_events·faq_processor를 읽는다 — 이름 유지."""
    cfg: ServerConfig
    backend: BackendGateway
    fare_of: Callable[[dict], int | None]   # 택배 스냅샷 → 배송비(config [fare]), decide_outcome에 넘긴다
    address: AddressService | None = None   # 주소DB 보정 + 카카오(공유 클라이언트·전용 스레드풀)
    calls: CallService | None = None        # OPENAI_API_KEY가 있을 때만(없으면 통화 수신 끔)
    faq_events: object | None = None
    faq_processor: object | None = None
    rag: object | None = None               # 원본 RagService(수정 금지). search_manual이 부른다
    faq_runtime: object | None = None


async def build_rag(svc: "Services") -> list[asyncio.Task]:
    """원본 main.py lifespan의 RAG 조립을 그대로 따른다(FAQ 알림 저장소 → 관리 색인 → 처리기 → RagService).
    다른 점: 기동 때 RAG·리랭커를 확인하지 않고(사용자 지시 2026-11-03), Qdrant·리랭커 장애로 서버가 못 뜨지 않게
    실패하면 그 기능만 끈다 — 검색은 search_manual이 KB_UNAVAILABLE로 답한다."""
    from app.rag.service import RagService
    from app.webhooks.faqs import valid_token

    cfg = svc.cfg
    f = cfg.faq_sync
    if f.receive_enabled:
        if not valid_token(os.environ.get("AI_FAQ_TOKEN")):
            raise RuntimeError("FAQ 알림 활성화에는 올바른 AI_FAQ_TOKEN이 필요합니다.")  # 원본과 같은 설정 오류
        from app.rag.faq_events import FaqEventStore
        svc.faq_events = await asyncio.to_thread(FaqEventStore, ROOT / f.db_path, max_pending=f.max_pending,
                                                 busy_timeout_sec=f.busy_timeout_sec)
        await asyncio.to_thread(svc.faq_events.recover_interrupted)
    if f.process_enabled:
        try:
            from app.rag.faq_processor import FaqProcessor
            from app.rag.faq_runtime import create_faq_runtime
            svc.faq_runtime = await asyncio.to_thread(create_faq_runtime, svc.faq_events, f, cfg.rag)
            FaqProcessor.check_bindings(svc.faq_events, svc.faq_runtime.index, f, cfg.rag)
            svc.faq_processor = FaqProcessor(svc.faq_events, svc.backend.api, svc.faq_runtime.index, f, cfg.rag)
            svc.rag = RagService(cfg.rag, faq_index=svc.faq_runtime.index, reranker=svc.faq_runtime.reranker)
            return [asyncio.create_task(svc.faq_processor.run())]
        except Exception as e:  # Qdrant 장애 등: 서버는 뜨고 매뉴얼 검색만 끈다(알림은 저장소에 쌓여 재시작 때 처리)
            log.warning("FAQ 관리 색인 준비 실패, 매뉴얼 검색 끔: %s", type(e).__name__)
            if svc.faq_runtime is not None:
                await asyncio.to_thread(svc.faq_runtime.close)
            svc.faq_runtime = svc.faq_processor = None
            return []
    svc.rag = RagService(cfg.rag)  # 원본 경로: 첫 검색 때 연결(warmup은 같은 준비를 백그라운드에서 — 리랭커는 부르지 않음)
    return [asyncio.create_task(svc.rag.warmup())]


def build_backend(cfg: BackendConfig, env=os.environ) -> BackendGateway:
    """BACKEND_MOCK=true면 메모리 가짜 BE, 아니면 BACKEND_API_URL의 실제 BE(없으면 시작 실패).
    실통화 시험은 가짜 BE로 한다 — 기존 서버가 실제 BE를 쓰고 있다(사용자 지시 2026-11-03)."""
    if env.get("BACKEND_MOCK", "").lower() == "true":
        log.warning("BE: 메모리 가짜 BE(BACKEND_MOCK=true)")
        api = MockBackend()
    else:
        url = env.get("BACKEND_API_URL", "").strip()
        if not url:
            raise RuntimeError("BACKEND_API_URL이 비어 있습니다(가짜 BE는 BACKEND_MOCK=true)")
        log.warning("BE: 실제 BE %s", url)
        api = BackendAPI(url, cfg.timeout_sec, submit_timeout_sec=cfg.submit_timeout_sec,
                         submit_retry_sec=cfg.submit_retry_sec,
                         persona_token=env.get("AI_PERSONA_TOKEN") or None,
                         insights_token=env.get("AI_INSIGHTS_TOKEN") or None,
                         limits=httpx2.Limits(max_connections=cfg.max_concurrency,
                                              max_keepalive_connections=cfg.max_concurrency))
    return BackendGateway(api, cfg.max_concurrency, cfg.read_budget_sec, cfg.write_budget_sec)


CALL_LOG_DIR = Path(os.environ.get("CALL_LOG_DIR", ROOT / "logs" / "calls"))


async def write_call_log(s) -> None:
    """통화 기록(스냅샷: 업무 값·전사 포함, 사건, 도구 호출). 개인정보 — logs/는 커밋 안 함.
    스냅샷이 실패해도 사건·전사·도구 기록은 남긴다(분석 근거를 잃지 않게)."""
    import json
    CALL_LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = CALL_LOG_DIR / f"{s.trace_id}.json"
    try:
        snap = s.snapshot()
    except Exception as e:
        snap = {"error": f"{type(e).__name__}: {e}"}
    path.write_text(json.dumps({"snapshot": snap, "events": s.events, "tool_calls": s.tool_calls,
                                "transcript": s.transcript}, ensure_ascii=False, indent=1, default=str),
                    encoding="utf-8")
    log.info("통화 기록 %s", path)


def setup_logging() -> None:
    handler = logging.StreamHandler()
    handler.addFilter(TraceFilter())
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s [%(trace_id)s] %(message)s"))
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), handlers=[handler], force=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    cfg = load_server_config()
    # 행안부 주소DB(compose: ./data → /app/data). 없으면 보정 없이 들은 그대로(open_db가 경고)
    address_db = open_db(Path(os.environ.get("ADDRESS_DB", ROOT / "data" / "address.db")))
    app.state.svc = Services(cfg=cfg, backend=build_backend(cfg.backend),
                             fare_of=partial(parcel_fare, table=cfg.fare.model_dump()), address=AddressService(address_db))
    svc = app.state.svc
    warm = recovery = persona = review_worker = resend_worker = None
    rag_tasks = await build_rag(svc)
    app.include_router(faq_router)
    app.include_router(persona_router)
    if os.environ.get("OPENAI_API_KEY"):
        from openai import AsyncOpenAI
        client = AsyncOpenAI()  # OPENAI_API_KEY·OPENAI_WEBHOOK_SECRET
        model = os.environ.get("BACKEND_MODEL", "")
        if not model:
            raise RuntimeError("BACKEND_MODEL이 비어 있습니다(Responses 위임 Backend 모델)")
        svc.calls = CallService(CallDeps(client, svc.backend, load_policy(), cfg.call, model,
                                         os.environ.get("BACKEND_EFFORT", "low"), svc.address, svc.rag,
                                         cfg.rag.min_score, cfg.rag.timeout_sec))
        LiveFlow(svc.calls)  # S5: 함수 호출·발화 끝 Decision·확인·전달
        warm = asyncio.create_task(svc.calls.warmup())
        # 페르소나: 기동 때 ACTIVE·PENDING 복구, 이후 BE 알림마다 동기화(새 통화 진입도 같은 잠금으로 맞춘다)
        if not svc.calls.persona.enabled:
            log.warning("운영 페르소나 연동을 사용하지 않아 서버 기본 프롬프트(P2)")
        persona = asyncio.create_task(svc.calls.persona.run())
        # S6: 결과 아웃박스(재시작 복구) — 실통화 시험은 가짜 BE(BACKEND_MOCK=true)
        outbox = Outbox(Path(os.environ.get("OUTBOX_PATH", ROOT / "state" / "outbox.sqlite3")))
        reviewer = None
        if cfg.unanswered_review.enabled:
            from app.calls.unanswered import UnansweredReviewer
            from app.config import prompts_dir
            review_cfg = cfg.unanswered_review
            reviewer = UnansweredReviewer(client, model,
                                           (prompts_dir() / "unanswered_review.md").read_text(encoding="utf-8"),
                                           timeout_sec=review_cfg.timeout_sec,
                                           max_input_chars=review_cfg.max_input_chars,
                                           max_output_tokens=review_cfg.max_output_tokens)
            if not review_cfg.reason_contract_enabled:
                log.warning("통화 종료 미답변 검토 활성: reason 계약 대기로 인사이트 전송 보류")
        svc.calls.results = ResultService(svc.backend, outbox, svc.calls.d.policy, svc.fare_of,
                                          cfg.backend.submit_timeout_sec + cfg.backend.submit_retry_sec + 5,
                                          callback_field=cfg.backend.analysis_callback_field,
                                          reviewer=reviewer,
                                          reason_contract_enabled=cfg.unanswered_review.reason_contract_enabled,
                                          review_max_attempts=cfg.unanswered_review.max_attempts,
                                          faq_answered_enabled=cfg.unanswered_review.faq_answered_enabled)
        if reviewer is not None:
            review_worker = asyncio.create_task(svc.calls.results.review_loop(cfg.unanswered_review.poll_sec))
        svc.calls.on_finalize.insert(0, svc.calls.results.finish)
        recovery = asyncio.create_task(svc.calls.results.recover())
        if cfg.backend.result_resend_sec:  # SENT_UNCERTAIN 결과를 실행 중에도 같은 키로 재확인(0이면 재시작 때만)
            resend_worker = asyncio.create_task(svc.calls.results.resend_loop(cfg.backend.result_resend_sec))
        bus = Bus()
        svc.calls.on_change = lambda s: bus.publish({"type": "call", "call": s.snapshot()})  # 전사·사건·단계마다
        svc.calls.on_finalize.append(write_call_log)
        app.include_router(create_incoming_router(client, svc.calls.on_incoming))
        app.include_router(create_call_ended_router(svc.calls.on_call_ended))
        app.include_router(create_monitor_router(svc.calls.registry.snapshots, bus))
    else:
        log.warning("OPENAI_API_KEY가 없어 통화 수신을 켜지 않습니다")
    try:
        yield
    finally:
        for t in (warm, recovery, persona, review_worker, resend_worker, *rag_tasks):
            if t and not t.done():
                t.cancel()
        if svc.calls:
            await svc.calls.shutdown()
            await svc.calls.results.drain()
        await svc.address.close()
        if svc.rag is not None:
            await svc.rag.close()
        if svc.faq_runtime is not None:
            await asyncio.to_thread(svc.faq_runtime.close)
        close = getattr(app.state.svc.backend.api, "close", None)
        if close:
            await close()


app = FastAPI(title="AI voice order server", lifespan=lifespan)


@app.get("/health")  # 원본 서버와 같은 경로(외부 점검용)
@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}
