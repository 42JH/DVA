"""관제 라우터(원본 ai/app/monitor/router.py). 개인정보가 보이므로 HTTP Basic 인증(MONITOR_USER·MONITOR_PASSWORD),
값이 없으면 503으로 닫는다.

원본에서 뺀 것: /api/graph(옛 흐름 엔진 app.flow.engine 전용), /api/orders(BE에 없는 옛 계약 /internal/ai/orders,
docs/contracts/be-api.md B-9). 통화 목록은 list_calls로, 실시간 갱신은 Bus로 받는다(통화 레지스트리 의존 제거).

통화 스냅샷(dict) 형식은 docs/ops/monitor.md. 화면은 모르는 키를 "상세" 표에 그대로 보여 준다."""

import asyncio
import json
import os
import secrets
from collections.abc import Callable
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from monitor.bus import Bus

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


def _sse(message: dict) -> str:
    return f"data: {json.dumps(message, ensure_ascii=False, default=str)}\n\n"


def create_monitor_router(list_calls: Callable[[], list[dict]], bus: Bus, keepalive_sec: float = 15.0,
                          prefix: str = "/monitor") -> APIRouter:
    """list_calls: 진행 중·최근 통화 스냅샷 목록. bus: 통화 쪽이 {"type": "call", "call": 스냅샷}을 publish."""
    router = APIRouter(prefix=prefix, dependencies=[Depends(require_auth)])

    @router.get("")
    async def page() -> FileResponse:
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})

    @router.get("/api/calls")
    async def calls() -> list[dict]:
        return list_calls()

    @router.get("/api/stream")
    async def stream(request: Request) -> StreamingResponse:
        async def events():
            q = bus.subscribe()
            try:
                for c in list_calls():
                    yield _sse({"type": "call", "call": c})
                while not await request.is_disconnected():
                    try:
                        yield _sse(await asyncio.wait_for(q.get(), keepalive_sec))
                    except TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                bus.unsubscribe(q)

        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})

    return router
