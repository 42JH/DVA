"""OpenAI 웹훅: 서명 검증 → 바로 200 → accept는 백그라운드(spec/pbx-sip.md)."""

import asyncio
import logging

from fastapi import APIRouter, Request, Response

from app.call import Call, caller_from_headers, iso_utc
from app.flow import engine
from app.live_session import LiveConfigError, build_session, build_backend, load_live_toml
from app.services import Services
from app.sideband import hangup_now, run_call

log = logging.getLogger(__name__)
router = APIRouter()

INCOMING = ("live.transport.incoming", "live.call.incoming")


@router.post("/api/webhooks/openai/call-incoming")
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
        svc.spawn(handle_incoming(svc, event.data, iso_utc(event.created_at)))
    # realtime.call.incoming 등 다른 이벤트는 무시한다
    return Response(status_code=200)


async def _reject(svc: Services, session_id: str) -> None:
    try:
        await svc.client.live.sessions.reject(session_id, status_code=svc.cfg.call.reject_status_code)
    except Exception:
        log.exception("reject 실패 %s", session_id)


async def handle_incoming(svc: Services, data, incoming_at: str | None = None) -> None:
    """incoming_at: 수신 이벤트 created_at(ISO 8601). 서버 수신 시각이 아니라 이 값으로 백엔드가 녹취와 통화를 잇는다."""
    session_id = data.session_id
    call = Call(session_id, caller_from_headers(data.sip_headers), svc.cfg, svc.texts, svc.backend, incoming_at)
    status = svc.registry.try_register(call)
    if status == "duplicate":
        return
    if status == "full":
        log.warning("동시 통화 상한 초과, reject %s", session_id)
        await _reject(svc, session_id)
        return
    try:
        await call.prepare()
        call_info = svc.texts.call_info.format(**call.text_vars(), first=engine.next_text(call))
        settings = load_live_toml()
        session = build_session(call_info, data=settings)
        call.backend_settings = build_backend(settings)
        call.delegation_mode = session['delegation']['type']
        call.rag = svc.rag
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
    if call.pbx_ended:  # accept하는 사이 PBX가 통화 종료를 알렸다
        call.end("pbx_hangup")
        await hangup_now(svc, call)
        return
    call.task = asyncio.create_task(run_call(call, svc.client))  # 참조는 통화 객체(레지스트리)가 든다
