"""OpenAI 웹훅: 서명 검증 → 바로 200 → accept는 백그라운드(spec/pbx-sip.md)."""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Request, Response

from app.call import Call, Registry, caller_from_headers
from app.config import ServerConfig, Texts
from app.live_session import LiveConfigError, build_session
from app.sideband import run_call

log = logging.getLogger(__name__)
router = APIRouter()

INCOMING = ("live.transport.incoming", "live.call.incoming")


@dataclass
class Services:
    cfg: ServerConfig
    texts: Texts
    client: Any  # AsyncOpenAI(테스트에서는 가짜)
    db: Any
    registry: Registry
    seen_webhooks: dict[str, float] = field(default_factory=dict)
    tasks: set[asyncio.Task] = field(default_factory=set)

    def first_time(self, webhook_id: str | None) -> bool:
        """같은 webhook-id는 한 번만. 오래된 기록은 지운다."""
        now = time.time()
        ttl = self.cfg.call.webhook_dedupe_sec
        for k in [k for k, t in self.seen_webhooks.items() if now - t > ttl]:
            del self.seen_webhooks[k]
        if not webhook_id:
            return True
        if webhook_id in self.seen_webhooks:
            return False
        self.seen_webhooks[webhook_id] = now
        return True

    def spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task


@router.post("/openai/webhook")
async def openai_webhook(request: Request) -> Response:
    svc: Services = request.app.state.svc
    body = await request.body()
    try:
        event = svc.client.webhooks.unwrap(body, request.headers)
    except Exception:
        log.warning("웹훅 서명 검증 실패")
        return Response(status_code=400)
    if not svc.first_time(request.headers.get("webhook-id")):
        return Response(status_code=200)
    if event.type in INCOMING and getattr(event.data, "type", None) == "sip":
        svc.spawn(handle_incoming(svc, event.data))
    # realtime.call.incoming 등 다른 이벤트는 무시한다
    return Response(status_code=200)


async def _reject(svc: Services, session_id: str) -> None:
    try:
        await svc.client.live.sessions.reject(session_id, status_code=svc.cfg.call.reject_status_code)
    except Exception:
        log.exception("reject 실패 %s", session_id)


async def handle_incoming(svc: Services, data) -> None:
    session_id = data.session_id
    call = Call(session_id, caller_from_headers(data.sip_headers), svc.cfg, svc.texts, svc.db)
    status = svc.registry.try_register(call)
    if status == "duplicate":
        return
    if status == "full":
        log.warning("동시 통화 상한 초과, reject %s", session_id)
        await _reject(svc, session_id)
        return
    try:
        await call.prepare()
        call_info = svc.texts.call_info.format(**call.text_vars())
        session = build_session(call_info)
    except LiveConfigError as e:
        log.error("세션 설정 오류, reject %s: %s", session_id, e)
        call.end("config_error", status="failed")
        await _reject(svc, session_id)
        return
    except Exception:
        log.exception("통화 준비 실패, reject %s", session_id)
        call.end("prepare_error", status="failed")
        await _reject(svc, session_id)
        return
    try:
        await svc.client.live.sessions.accept(session_id, session=session)
    except Exception as e:
        log.exception("accept 실패 %s", session_id)
        call.add_error(f"accept 실패: {type(e).__name__}")
        call.end("accept_failed", status="failed")
        return
    call.task = asyncio.create_task(run_call(call, svc.client))  # 참조는 통화 객체(레지스트리)가 든다
