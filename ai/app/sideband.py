"""sideband 연결 하나 = 통화 하나의 작업(spec/sideband.md).
백엔드 function_call 실행·결과 반환, 진행 상태 thinking.append, 받아쓰기·고객 답 판별, 종료·전환 타이밍."""

import asyncio
import json
import logging
import time

from app import listener
from app import client_backend
from app.call import Call
from app.dispatcher import dispatch
from app.flow import engine
from app.progress import send_progress

log = logging.getLogger(__name__)

POLL_SEC = 0.1


async def run_call(call: Call, client) -> None:
    """한 통화의 실패는 그 통화에서 끝낸다(로그·관제 표시·가능하면 hangup)."""
    reason = "sideband_closed"
    try:
        async with client.live.sideband.connect(session_id=call.session_id) as conn:
            call.status = "active"
            call.last_input_at = time.monotonic()
            call.notify()
            await send_progress(call, conn)
            watchers = [asyncio.create_task(watch_end(call, client, conn)), asyncio.create_task(watch_idle(call, conn))]
            tool_tasks: set[asyncio.Task] = set()
            try:
                async for event in conn:
                    closed = handle_event(call, conn, event, tool_tasks, client)
                    if closed:
                        reason = closed
                        break
            finally:
                jobs = [t for t in [*watchers, *tool_tasks, *call.listen_tasks, call.listen_timer] if t]
                for t in jobs:
                    if t:
                        t.cancel()
                await asyncio.gather(*jobs, return_exceptions=True)
                for future in call.pending_context.values():
                    if not future.done():
                        future.cancel()
                call.pending_context.clear()
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
        try:
            await call.finish()  # 통화 결과를 백엔드에 한 번(접수·미완료·취소)
        except Exception:
            log.exception("통화 결과 전송 실패 %s", call.session_id)


def handle_event(call: Call, conn, event, tool_tasks: set, client=None) -> str | None:
    """이벤트 하나 처리. 통화가 닫혔으면 이유를 돌려준다. 도구 실행은 별도 작업으로(받기를 막지 않게)."""
    etype = getattr(event, "type", None)
    if etype not in call.event_types:  # 위임·도구 이벤트가 오는지 실제 통화에서 확인하려고
        call.event_types.add(etype)
        log.info("sideband 이벤트 %s %s", call.session_id, etype)
    if etype == 'session.delegation.created' and call.delegation_mode == 'client':
        value = _dump(event)
        client_backend.start_delegation(call, conn, value.get('delegation') or {}, tool_tasks, client)
    elif etype in ('session.thinking.appended', 'session.commentary.appended'):
        client_backend.acknowledge(call, _dump(event))
    elif etype == "response.event" and call.delegation_mode == 'responses':
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
        call.last_input_at = time.monotonic()
        if event.delta.strip():
            call.input_ready.set()
        listener.heard(call, event.delta, conn, client)
    elif etype == "session.output_transcript.delta":
        call.add_transcript("agent", event.delta, getattr(event, "start_ms", None), getattr(event, "end_ms", None))
        client_backend.observe_output(call, 'transcript', getattr(event, 'start_ms', None))
    elif etype == "session.output_audio.delta":
        call.last_output_at = time.monotonic()
        client_backend.observe_output(call, 'audio', getattr(event, 'start_ms', None))
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


async def watch_end(call: Call, client, conn) -> None:
    """종료·상담원 연결 요청 뒤 안내 말이 끝나면 hangup·refer. 바로 끊으면 인사가 잘린다.
    전환이 실패하면 고객을 기다리게 두지 않고 실패 안내·마무리 인사 뒤 끊는다."""
    hangup = asyncio.create_task(call.hangup_requested.wait())
    refer = asyncio.create_task(call.refer_requested.wait())
    try:
        done, _ = await asyncio.wait({hangup, refer}, return_when=asyncio.FIRST_COMPLETED)
        await wait_quiet(call)
        if refer in done:
            try:
                await client.live.sessions.refer(call.session_id, target_uri=call.cfg.call.refer_target_uri)
                return
            except Exception:
                log.exception("상담원 전환 실패 %s", call.session_id)
                call.add_error("상담원 전환 실패")
            call.refer_failed = True
            await send_progress(call, conn)
            await wait_quiet(call)
        await client.live.sessions.hangup(call.session_id)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("종료·전환 실패 %s", call.session_id)
        call.add_error("종료·전환 실패")
    finally:
        hangup.cancel()
        refer.cancel()


async def watch_idle(call: Call, conn) -> None:
    """고객 끊김을 못 알아챈 경우의 안전장치. 보통은 고객이 끊으면 OpenAI가 세션을 닫고(remote_hangup)
    PBX 종료 웹훅도 온다. 둘 다 없어 고객 말이 idle_hangup_sec 동안 없거나 통화가 max_call_sec를 넘으면
    마무리 인사 후 끊는다(watch_end)."""
    cfg = call.cfg.call
    started = time.monotonic()
    while True:
        await asyncio.sleep(POLL_SEC)
        now = time.monotonic()
        idle = now - call.last_input_at >= cfg.idle_hangup_sec
        if idle or now - started >= cfg.max_call_sec:
            break
    if call.hangup_requested.is_set() or call.refer_requested.is_set():
        return
    reason = f"고객 무응답 {cfg.idle_hangup_sec:.0f}초" if idle else f"최대 통화 시간 {cfg.max_call_sec:.0f}초"
    log.info("%s로 종료 %s", reason, call.session_id)
    call.add_error(f"{reason}로 종료")
    async with call.lock:
        call.request_hangup()
        await engine.apply(call, ["call.ending"], "watchdog")
        await send_progress(call, conn)


async def hangup_now(svc, call) -> None:
    """PBX가 고객이 끊은 것을 알렸을 때: 마무리 인사를 기다리지 않고 바로 끝낸다.
    보통은 OpenAI가 고객의 SIP 종료로 세션을 이미 닫아서 404(세션 없음)다. 그때는 오류가 아니다."""
    try:
        await svc.client.live.sessions.hangup(call.session_id)
    except Exception as e:
        if getattr(e, "status_code", None) == 404:
            log.info("PBX 종료: 세션이 이미 끝남 %s", call.session_id)
            return
        log.exception("PBX 종료 후 hangup 실패 %s", call.session_id)
        call.add_error("PBX 종료 후 hangup 실패")
