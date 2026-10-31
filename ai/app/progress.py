import asyncio
import json
import logging
import time

from app.dispatcher import dispatch
from app.flow import engine

log = logging.getLogger(__name__)


def customer_speaking(call) -> bool:
    """고객 말 조각이 말 멈춤 대기(listener.pause_ms) 안에 왔다: 아직 말하는 중으로 본다."""
    return time.monotonic() - call.customer_said_at < call.cfg.listener.pause_ms / 1000


async def send_progress(call, conn, delivered: bool = False) -> None:
    """음성 모델에 "다음에 할 말 + 기록된 값". 바뀌었을 때만 보낸다. 한 번만 붙이는 말(정정 확인)은 보낸 뒤 지운다.
    delivered: 도구 결과로 이미 전해졌다(보내지 않고 보낸 것으로 친다). 고객이 말하는 중이면 미뤘다가 말이 멈추면 보낸다
    (watch_flow): 진행 상태가 오면 음성 모델이 바로 말을 시작해 고객 말 위로 겹친다(2026-10-31 통화)."""
    text = engine.progress_text(call, call.cfg.progress.max_chars)
    if text != call.last_progress and not delivered:
        if customer_speaking(call):
            call.progress_due = True
            return
        await conn.session.thinking.append(content=text, delegation_id=None)
    call.last_progress, call.progress_due = text, False
    call.flow.notice = []


async def after_change(call, conn, delivered: bool = False) -> None:
    """상태를 바꾼 뒤(판별·도구·감시): 서버가 실행할 도구가 생겼으면 시작하고 진행 상태를 보낸다."""
    if call.server_tool:
        name, args, fail_event = call.server_tool
        call.server_tool = None
        task = asyncio.create_task(run_server_tool(call, conn, name, args, fail_event))
        call.write_tasks.add(task)
        task.add_done_callback(call.write_tasks.discard)
    await send_progress(call, conn, delivered)


async def run_server_tool(call, conn, name: str, args: dict, fail_event: str) -> None:
    """백엔드 모델이 아니라 서버가 부르는 쓰기 도구(취소). 디스패처를 그대로 거친다(인수 검증·허용 단계·시간 제한·기록).
    도구가 결과 사건 없이 실패하면(시간 초과·예외) fail_event로 실패 분기를 탄다."""
    op = args["operation_id"]
    async with call.lock:
        output = await dispatch(call, name, json.dumps(args, ensure_ascii=False), op)
        try:
            if not output["ok"] and not call.tool_calls[op].get("events"):
                await engine.apply(call, [fail_event], name)
            await after_change(call, conn)
        except Exception:
            log.exception("서버 도구 결과 반영 실패 %s %s", call.session_id, name)
