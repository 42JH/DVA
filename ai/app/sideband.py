"""sideband 연결 하나 = 통화 하나의 작업(spec/sideband.md).
백엔드 function_call 실행·결과 반환, 진행 상태 thinking.append, 받아쓰기, 종료·전환 타이밍."""

import asyncio
import json
import logging
import time

from app.call import Call
from app.dispatcher import dispatch
from app.flow import engine

log = logging.getLogger(__name__)

POLL_SEC = 0.1


async def run_call(call: Call, client) -> None:
    """한 통화의 실패는 그 통화에서 끝낸다(로그·관제 표시·가능하면 hangup)."""
    reason = "sideband_closed"
    try:
        async with client.live.sideband.connect(session_id=call.session_id) as conn:
            call.status = "active"
            call.notify()
            await send_progress(call, conn)
            watcher = asyncio.create_task(watch_end(call, client))
            tool_tasks: set[asyncio.Task] = set()
            try:
                async for event in conn:
                    closed = handle_event(call, conn, event, tool_tasks)
                    if closed:
                        reason = closed
                        break
            finally:
                watcher.cancel()
                for t in tool_tasks:
                    t.cancel()
    except Exception as e:
        log.exception("sideband 오류 %s", call.session_id)
        call.add_error(f"sideband 오류: {type(e).__name__}")
        reason = "error"
        try:
            await client.live.sessions.hangup(call.session_id)
        except Exception:
            log.warning("오류 후 hangup 실패 %s", call.session_id)
    finally:
        call.end(reason)


def handle_event(call: Call, conn, event, tool_tasks: set) -> str | None:
    """이벤트 하나 처리. 통화가 닫혔으면 이유를 돌려준다. 도구 실행은 별도 작업으로(받기를 막지 않게)."""
    etype = getattr(event, "type", None)
    if etype == "response.event":
        inner = event.event or {}
        itype = inner.get("type")
        item = inner.get("item") or {}
        if itype == "response.output_item.added" and item.get("type") == "function_call":
            call.tool_calls[item.get("call_id") or item.get("id")] = {
                "call_id": item.get("call_id"), "item_id": item.get("id"), "name": item.get("name"),
                "status": "writing", "arguments": "", "started": time.time()}
            call.notify()
        elif itype == "response.function_call_arguments.delta":
            for rec in call.tool_calls.values():
                if rec.get("item_id") == inner.get("item_id") and rec["status"] == "writing":
                    rec["arguments"] += inner.get("delta") or ""
        elif itype == "response.output_item.done" and item.get("type") == "function_call":
            # name·call_id는 여기에만 있다. 여기서만 실행한다
            task = asyncio.create_task(run_tool(call, conn, item))
            tool_tasks.add(task)
            task.add_done_callback(tool_tasks.discard)
    elif etype == "session.input_transcript.delta":
        call.add_transcript("customer", event.delta, getattr(event, "start_ms", None), getattr(event, "end_ms", None))
    elif etype == "session.output_transcript.delta":
        call.add_transcript("agent", event.delta, getattr(event, "start_ms", None), getattr(event, "end_ms", None))
    elif etype == "session.output_audio.delta":
        call.last_output_at = time.monotonic()
    elif etype == "session.usage.updated":
        call.usage = _dump(getattr(event, "usage", None))
    elif etype == "error":
        err = getattr(event, "error", None)
        log.warning("GPT-Live 오류 %s %s", call.session_id, err)
        call.add_error(f"GPT-Live 오류: {getattr(err, 'code', None) or getattr(err, 'type', '')}")
    elif etype == "transport.failed":
        call.add_error(f"전송 실패: {getattr(event.error, 'code', '')}")
    elif etype == "session.closed":
        call.usage = _dump(getattr(event, "usage", None))
        return event.reason
    return None


def _dump(obj):
    return obj.model_dump() if hasattr(obj, "model_dump") else obj


async def run_tool(call: Call, conn, item: dict) -> None:
    """한 통화 안의 도구는 순서대로(통화별 잠금, FIFO). 결과는 꼭 돌려주고 response.create를 보낸다."""
    async with call.lock:
        output = await dispatch(call, item.get("name") or "", item.get("arguments") or "", item.get("call_id") or "")
        try:
            await conn.response.item.create(item={
                "type": "function_call_output",
                "call_id": item.get("call_id"),
                "output": json.dumps(output, ensure_ascii=False, default=str),
            })
            await conn.response.create()
            await send_progress(call, conn)
        except Exception:
            log.exception("도구 결과 전송 실패 %s", call.session_id)
            call.add_error("도구 결과 전송 실패")


async def send_progress(call: Call, conn) -> None:
    """음성 모델에 "다음에 물을 것 + 기록된 값". 바뀌었을 때만 보낸다."""
    text = engine.progress_text(call, call.cfg.progress.max_chars)
    if text != call.last_progress:
        await conn.session.thinking.append(content=text, delegation_id=None)
        call.last_progress = text


async def wait_quiet(call: Call) -> None:
    """요청 뒤에 음성 출력이 한 번 이상 나오고, 그 뒤 설정한 시간만큼 멈출 때까지(최대 대기 있음)."""
    cfg = call.cfg.call
    requested = time.monotonic()
    while True:
        now = time.monotonic()
        spoke = call.last_output_at > requested
        if spoke and now - call.last_output_at >= cfg.hangup_silence_sec:
            return
        if now - requested >= cfg.hangup_max_wait_sec:
            return
        await asyncio.sleep(POLL_SEC)


async def watch_end(call: Call, client) -> None:
    """end_call·transfer_to_agent 뒤 안내 말이 끝나면 hangup·refer. 바로 끊으면 인사가 잘린다."""
    hangup = asyncio.create_task(call.hangup_requested.wait())
    refer = asyncio.create_task(call.refer_requested.wait())
    try:
        done, _ = await asyncio.wait({hangup, refer}, return_when=asyncio.FIRST_COMPLETED)
        await wait_quiet(call)
        if refer in done:
            await client.live.sessions.refer(call.session_id, target_uri=call.cfg.call.refer_target_uri)
        else:
            await client.live.sessions.hangup(call.session_id)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("종료·전환 실패 %s", call.session_id)
        call.add_error("종료·전환 실패")
    finally:
        hangup.cancel()
        refer.cancel()
