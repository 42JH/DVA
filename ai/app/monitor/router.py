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
from app.flow import engine

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
    return await svc.backend.recent_orders(svc.cfg.backend.monitor_orders_limit)


@router.get("/api/graph")
async def graph() -> dict:
    """상태 그래프 그림(Mermaid 글). 단계 정의의 전이만 그린다. 어디서나 들어가는 단계(enter_on)와
    복귀(RETURN)는 엣지가 너무 많아 노드 이름 옆에 표시만 한다. 같은 단계에 머무는 STAY는 그리지 않는다."""
    lines = ["flowchart TD"]
    groups: dict[str, list[str]] = {}
    for s in engine.STAGES.values():
        groups.setdefault(engine.GROUPS.get(s.name, ""), []).append(s.name)
    for group, names in groups.items():
        lines.append(f"  subgraph {group}")
        for name in names:
            s = engine.STAGES[name]
            mark = " ⟵ 어디서나" if s.enter_on else ""
            mark += " ⟶ 복귀" if any(t.target == engine.RETURN for t in s.transitions) else ""
            lines.append(f'    {name}["{name}{_q(mark)}"]')
        lines.append("  end")
    edges: dict[tuple[str, str], list[str]] = {}
    for s in engine.STAGES.values():
        for t in s.transitions:
            if t.target in engine.STAGES:
                edges.setdefault((s.name, t.target), []).append("자동" if t.event == engine.ENTERED else t.event)
    lines += [f'  {a} -->|"{_q(", ".join(dict.fromkeys(ev)))}"| {b}' for (a, b), ev in edges.items()]
    return {"mermaid": "\n".join(lines), "stages": list(engine.STAGES)}


def _q(text: str) -> str:
    return text.replace('"', "#quot;")


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
