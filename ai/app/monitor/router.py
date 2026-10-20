"""관제 화면(임시, spec/monitor.md). 이 라우터와 static만 지우면 통째로 걷어낼 수 있다.
개인정보가 보이므로 HTTP Basic 인증(MONITOR_USER·MONITOR_PASSWORD). 값이 없으면 열지 않는다."""

import asyncio
import json
import os
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from app.events import bus

STATIC = Path(__file__).with_name("static")
_basic = HTTPBasic()


def require_auth(cred: HTTPBasicCredentials = Depends(_basic)) -> None:
    user, password = os.environ.get("MONITOR_USER"), os.environ.get("MONITOR_PASSWORD")
    if not user or not password:
        raise HTTPException(503, "관제 화면 인증값이 설정되지 않음")
    ok = secrets.compare_digest(cred.username.encode(), user.encode()) & \
        secrets.compare_digest(cred.password.encode(), password.encode())
    if not ok:
        raise HTTPException(401, headers={"WWW-Authenticate": "Basic"})


router = APIRouter(prefix="/monitor", dependencies=[Depends(require_auth)])


@router.get("")
async def page() -> FileResponse:
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


@router.get("/api/calls")
async def calls(request: Request) -> list[dict]:
    return [c.snapshot() for c in request.app.state.svc.registry.list()]


@router.get("/api/orders")
async def orders(request: Request) -> list[dict]:
    svc = request.app.state.svc
    return await svc.db.recent_orders(svc.cfg.storage.monitor_orders_limit)


def _sse(message: dict) -> str:
    return f"data: {json.dumps(message, ensure_ascii=False, default=str)}\n\n"


@router.get("/api/stream")
async def stream(request: Request) -> StreamingResponse:
    svc = request.app.state.svc
    keepalive = svc.cfg.monitor.sse_keepalive_sec

    async def events():
        q = bus.subscribe()
        try:
            for c in svc.registry.list():
                yield _sse({"type": "call", "call": c.snapshot()})
            while not await request.is_disconnected():
                try:
                    yield _sse(await asyncio.wait_for(q.get(), keepalive))
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})
