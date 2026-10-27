"""인증된 WebRTC 실험 페이지. PBX·주문 API 없이 독립 실행한다."""

import asyncio
import json
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.config import prompts_dir
from app.monitor.router import require_auth
from app.live_lab.bridge import DirectRagBridge, LabSession
from app.live_lab.config import load_lab_config


STATIC = Path(__file__).with_name('static')


class Offer(BaseModel):
    model_config = ConfigDict(extra='forbid')
    sdp: str = Field(min_length=1, max_length=65536)


class BrowserMeasurement(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: Literal['user_speech_end', 'playback_start', 'playback_after_handoff']
    client_ms: float = Field(ge=0, allow_inf_nan=False)
    user_to_audio_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    after_handoff_notice_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)


def create_lab_app(client, search_factory, cfg=None):
    cfg = cfg or load_lab_config()
    sessions = {}
    lock = asyncio.Lock()

    async def close(session):
        if not session.closed and session.connection is not None:
            try:
                await asyncio.wait_for(session.connection.session.close(), cfg.sideband_timeout_seconds)
            except Exception:
                session.emit('error', message='원격 종료 확인 실패. 브라우저 미디어 연결도 종료하세요.')
        session.closed = True
        if session.expiry_task is not None and session.expiry_task is not asyncio.current_task():
            session.expiry_task.cancel()
        for job in tuple(session.jobs):
            job.cancel()
        if session.task is not None and not session.task.done():
            session.task.cancel()
            await asyncio.gather(session.task, return_exceptions=True)

    @asynccontextmanager
    async def lifespan(app):
        app.state.ready = False
        search = await asyncio.to_thread(search_factory)
        bridge = DirectRagBridge(client, search, cfg, (prompts_dir()/cfg.backend_prompt).read_text(encoding='utf-8'))
        app.state.bridge = bridge
        app.state.ready = True
        try:
            yield
        finally:
            for session in list(sessions.values()):
                await close(session)
            if hasattr(search, 'close'):
                await asyncio.to_thread(search.close)
            await client.close()

    app = FastAPI(title='Live-1 RAG 음성 실험', lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['localhost', '127.0.0.1'])

    def owner(request):
        key = request.cookies.get('live_lab_owner')
        if not key:
            raise HTTPException(403, '먼저 실험 페이지를 열어 주세요.')
        return key

    def owned(request, lab_id):
        session = sessions.get(lab_id)
        if session is None or not secrets.compare_digest(session.owner, owner(request)):
            raise HTTPException(404, '실험 세션을 찾을 수 없습니다.')
        return session

    def same_origin(request):
        expected = str(request.base_url).rstrip('/')
        if request.headers.get('origin') != expected:
            raise HTTPException(403, '같은 출처의 실험 화면에서 요청하세요.')

    @app.get('/health')
    async def health():
        return {'status': 'ok', 'service': 'live-lab', 'ready': app.state.ready}

    @app.get('/live-lab', dependencies=[Depends(require_auth)])
    async def page(request: Request):
        response = FileResponse(STATIC/'index.html', headers={'Cache-Control': 'no-store'})
        response.set_cookie('live_lab_owner', request.cookies.get('live_lab_owner') or secrets.token_urlsafe(32),
                            httponly=True, samesite='strict', secure=request.url.scheme == 'https')
        return response

    @app.get('/live-lab/assets/{name}', dependencies=[Depends(require_auth)])
    async def asset(name: str):
        if name not in ('app.js', 'style.css'):
            raise HTTPException(404)
        return FileResponse(STATIC/name, headers={'Cache-Control': 'no-store'})

    @app.get('/live-lab/api/config', dependencies=[Depends(require_auth)])
    async def info():
        return {'live_model': cfg.live_model, 'backend_model': cfg.backend_model,
                'max_session_seconds': cfg.max_session_seconds, 'ready': app.state.ready}

    @app.post('/live-lab/api/sessions', dependencies=[Depends(require_auth)])
    async def start(offer: Offer, request: Request):
        same_origin(request)
        browser_owner = owner(request)
        if not offer.sdp.strip().startswith('v=0'):
            raise HTTPException(422, '유효한 SDP offer가 필요합니다.')
        async with lock:
            now = time.monotonic()
            for key, session in list(sessions.items()):
                if session.closed and now-session.created > cfg.retention_seconds:
                    sessions.pop(key, None)
            if sum(not session.closed for session in sessions.values()) >= cfg.max_sessions:
                raise HTTPException(429, '동시 실험 세션 상한입니다. 기존 세션을 종료하세요.')
            from openai.types.live import SessionConfig
            configuration = {'model': cfg.live_model, 'store': False,
                             'instructions': (prompts_dir()/cfg.voice_prompt).read_text(encoding='utf-8'),
                             'audio': {'output': {'voice': cfg.voice}}, 'delegation': {'type': 'client'}}
            SessionConfig.model_validate(configuration)
            try:
                result = await asyncio.wait_for(client.live.create(session=configuration,
                    transport={'type': 'webrtc', 'sdp': offer.sdp}), cfg.sideband_timeout_seconds)
            except Exception as error:
                raise HTTPException(502, f'Live 세션 생성 실패: {type(error).__name__}') from None
            session = LabSession(result.session.id, browser_owner, cfg)
            sessions[session.id] = session
            session.task = asyncio.create_task(app.state.bridge.run(session))
            try:
                await asyncio.wait_for(session.ready.wait(), cfg.sideband_timeout_seconds)
                if session.closed:
                    raise RuntimeError('sideband 연결 실패')
            except Exception:
                await close(session)
                raise HTTPException(502, 'Live 제어 연결을 준비하지 못했습니다.') from None

            async def expire():
                await asyncio.sleep(cfg.max_session_seconds)
                if not session.closed:
                    session.emit('expired')
                    await close(session)
            session.expiry_task = asyncio.create_task(expire())
            return {'lab_id': session.id, 'session': {'id': session.id},
                    'transport': {'type': 'webrtc', 'sdp': result.transport.sdp}}

    @app.get('/live-lab/api/sessions/{lab_id}/events', dependencies=[Depends(require_auth)])
    async def events(lab_id: str, request: Request):
        session = owned(request, lab_id)
        async def stream():
            q = asyncio.Queue(maxsize=cfg.max_events)
            session.subscribers.add(q)
            try:
                yield 'data: '+json.dumps({'type': 'snapshot', 'snapshot': session.snapshot()}, ensure_ascii=False)+'\n\n'
                while not await request.is_disconnected():
                    try:
                        value = await asyncio.wait_for(q.get(), cfg.sse_keepalive_seconds)
                        yield 'data: '+json.dumps(value, ensure_ascii=False)+'\n\n'
                    except TimeoutError:
                        yield ': keepalive\n\n'
            finally:
                session.subscribers.discard(q)
        return StreamingResponse(stream(), media_type='text/event-stream', headers={'Cache-Control': 'no-store'})

    @app.post('/live-lab/api/sessions/{lab_id}/measurements', dependencies=[Depends(require_auth)])
    async def measurement(lab_id: str, value: BrowserMeasurement, request: Request):
        same_origin(request)
        session = owned(request, lab_id)
        session.emit('browser_measurement', **value.model_dump())
        return {'ok': True}

    @app.get('/live-lab/api/sessions/{lab_id}/export', dependencies=[Depends(require_auth)])
    async def export(lab_id: str, request: Request):
        return owned(request, lab_id).snapshot()

    @app.delete('/live-lab/api/sessions/{lab_id}', dependencies=[Depends(require_auth)])
    async def stop(lab_id: str, request: Request):
        same_origin(request)
        await close(owned(request, lab_id))
        return {'ok': True}

    return app
