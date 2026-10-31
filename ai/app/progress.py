import asyncio
import json
import logging

from app.dispatcher import dispatch
from app.flow import engine

log = logging.getLogger(__name__)


async def send_progress(call, conn) -> None:
    """음성 모델에 "다음에 할 말 + 기록된 값". 바뀌었을 때만 보낸다. 한 번만 붙이는 말(정정 확인)은 보낸 뒤 지운다."""
    text = engine.progress_text(call, call.cfg.progress.max_chars)
    if text != call.last_progress:
        await conn.session.thinking.append(content=text, delegation_id=None)
        call.last_progress = text
    call.flow.notice = []


async def after_change(call, conn) -> None:
    """상태를 바꾼 뒤(판별·도구·감시): 서버가 실행할 도구가 생겼으면 시작하고 진행 상태를 보낸다."""
    if call.server_tool:
        name, args, fail_event = call.server_tool
        call.server_tool = None
        task = asyncio.create_task(run_server_tool(call, conn, name, args, fail_event))
        call.write_tasks.add(task)
        task.add_done_callback(call.write_tasks.discard)
    await send_progress(call, conn)


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
