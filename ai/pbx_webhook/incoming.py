"""OpenAI 웹훅(SIP 수신): 서명 검증 → 같은 webhook-id 무시 → 바로 200 → 콜백은 백그라운드(spec/pbx-sip.md).
accept·reject는 콜백이 client.live.sessions.accept/reject로 한다(세션 설정은 재구성할 서버의 몫)."""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Request, Response

from pbx_webhook.sip import caller_from_headers, iso_utc

log = logging.getLogger(__name__)

INCOMING = ("live.transport.incoming", "live.call.incoming")


@dataclass(frozen=True)
class IncomingCall:
    session_id: str
    caller: str | None  # SIP From의 발신번호(미신뢰, 정규화만)
    incoming_at: str | None  # 수신 이벤트 created_at(ISO 8601). 백엔드가 녹취와 통화를 잇는 기준
    data: Any  # 웹훅 이벤트의 data 원본(sip_headers 등)


class _Dedupe:
    """같은 webhook-id는 한 번만. 오래된 기록은 지운다."""

    def __init__(self, ttl_sec: float):
        self.ttl, self.seen = ttl_sec, {}

    def first_time(self, webhook_id: str | None) -> bool:
        now = time.time()
        for k in [k for k, t in self.seen.items() if now - t > self.ttl]:
            del self.seen[k]
        if not webhook_id:
            return True
        if webhook_id in self.seen:
            return False
        self.seen[webhook_id] = now
        return True


def create_incoming_router(client: Any, on_incoming: Callable[[IncomingCall], Awaitable[None]],
                           path: str = "/api/webhooks/openai/call-incoming", dedupe_sec: float = 3600) -> APIRouter:
    """client: AsyncOpenAI(OPENAI_WEBHOOK_SECRET으로 client.webhooks.unwrap). on_incoming의 예외는 로그만 남긴다."""
    router = APIRouter()
    dedupe = _Dedupe(dedupe_sec)
    tasks: set[asyncio.Task] = set()  # 백그라운드 작업 참조(가비지 수집으로 사라지지 않게)

    async def run(call: IncomingCall) -> None:
        try:
            await on_incoming(call)
        except Exception:
            log.exception("수신 처리 실패 %s", call.session_id)

    @router.post(path)
    async def openai_webhook(request: Request) -> Response:
        body = await request.body()
        try:
            event = client.webhooks.unwrap(body, request.headers)
        except Exception:
            log.warning("웹훅 서명 검증 실패")
            return Response(status_code=400)
        if not dedupe.first_time(request.headers.get("webhook-id")):
            return Response(status_code=200)
        if event.type in INCOMING and getattr(event.data, "type", None) == "sip":
            call = IncomingCall(event.data.session_id, caller_from_headers(event.data.sip_headers),
                                iso_utc(event.created_at), event.data)
            task = asyncio.create_task(run(call))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
        # realtime.call.incoming 등 다른 이벤트는 무시한다
        return Response(status_code=200)

    return router


async def hangup_quietly(client: Any, session_id: str) -> bool:
    """세션을 끊는다. 고객이 먼저 끊어 세션이 이미 없으면(404) 오류로 보지 않는다. 끊었으면 True."""
    try:
        await client.live.sessions.hangup(session_id)
        return True
    except Exception as e:
        if getattr(e, "status_code", None) == 404:
            log.info("세션이 이미 끝남 %s", session_id)
            return False
        raise
