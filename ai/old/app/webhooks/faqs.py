"""BE FAQ 변경 알림 접수. 임베딩/검색 적용은 이 HTTP 요청에서 실행하지 않는다."""

import asyncio
import logging
import os
import sqlite3

from fastapi import APIRouter, Request, Response
from pydantic import ValidationError

from app.rag.faq_events import EventConflict, FaqChange, QueueFull
from app.webhooks.pbx import token_ok

log = logging.getLogger(__name__)
router = APIRouter(prefix='/internal/faqs')


def valid_token(value):
    return bool(value and len(value) >= 32 and value.isascii() and not any(c.isspace() for c in value))


@router.post('/refresh')
async def refresh(request: Request):
    secret = os.environ.get('AI_FAQ_TOKEN')
    if not valid_token(secret):
        return Response(status_code=503)
    if not token_ok(secret, request.headers.get('authorization')):
        return Response(status_code=401)
    svc = request.app.state.svc
    cfg, store = svc.cfg.faq_sync, svc.faq_events
    if store is None:
        return Response(status_code=503)
    try:
        async with asyncio.timeout(cfg.accept_timeout_sec):
            body = bytearray()
            async for part in request.stream():
                if len(body)+len(part) > cfg.max_body_bytes:
                    return Response(status_code=413)
                body.extend(part)
            event = FaqChange.model_validate_json(bytes(body))
            await asyncio.to_thread(store.enqueue, event)
            if svc.faq_processor is not None:
                svc.faq_processor.wake()
    except ValidationError:
        return Response(status_code=400)
    except EventConflict:
        return Response(status_code=409)
    except (TimeoutError, QueueFull, sqlite3.Error, OSError):
        # 타임아웃 뒤 저장 스레드가 커밋할 수 있다. 같은eventId 재전송으로 안전하게 확인한다.
        log.warning('FAQ 알림 영속 접수 실패: 백엔드 재전송 필요')
        return Response(status_code=503)
    return Response(status_code=202)
