"""sideband 연결 하나 = 통화 하나의 작업(spec/sideband.md).
백엔드 function_call 실행·결과 반환, 진행 상태 thinking.append, 받아쓰기·고객 답 판별, 종료·전환 타이밍."""

import asyncio
import json
import logging
import time

from app import listener
from app import client_backend
from app import insights
from app.call import Call
from app.dispatcher import dispatch
from app.flow import engine
from app.progress import after_change, send_progress, speaking, update_backend

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
            await update_backend(call, conn)
            await send_progress(call, conn)
            watchers = [asyncio.create_task(watch_end(call, client, conn)), asyncio.create_task(watch_idle(call, conn)),
                        asyncio.create_task(watch_flow(call, conn, client))]
            tool_tasks: set[asyncio.Task] = set()
            try:
                async for event in conn:
                    closed = handle_event(call, conn, event, tool_tasks, client)
                    if closed:
                        reason = closed
                        break
            finally:
                if call.write_tasks:  # 실행 중인 쓰기(취소)는 끊지 않고 결과를 기록한 뒤 끝낸다(§2.5(8))
                    await asyncio.wait(list(call.write_tasks), timeout=call.cfg.call.tool_timeout_sec)
                jobs = [t for t in [*watchers, *tool_tasks, *call.listen_tasks, call.listen_timer, call.side_timer,
                                    *call.write_tasks] if t]
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
        try:
            await insights.send(call)  # 받아쓰기·도구 실행·분석(결과를 보낸 뒤라 접수 결과를 담는다)
        except Exception:
            log.exception("통화 기록 전송 오류 %s", call.session_id)


def handle_event(call: Call, conn, event, tool_tasks: set, client=None) -> str | None:
    """이벤트 하나 처리. 통화가 닫혔으면 이유를 돌려준다. 도구 실행은 별도 작업으로(받기를 막지 않게)."""
    etype = getattr(event, "type", None)
    if etype not in call.event_types:  # 위임·도구 이벤트가 오는지 실제 통화에서 확인하려고
        call.event_types.add(etype)
        log.info("sideband 이벤트 %s %s", call.session_id, etype)
    if etype == 'session.updated':  # 백엔드 상태 갱신(session.update)을 받았는지
        log.info("세션 갱신 받음 %s", call.session_id)
    if etype == 'session.delegation.created':
        call.delegated_at = time.monotonic()
        trace(call, "위임 생성")
    if etype == 'session.delegation.created' and call.delegation_mode == 'client':
        value = _dump(event)
        client_backend.start_delegation(call, conn, value.get('delegation') or {}, tool_tasks, client)
    elif etype in ('session.thinking.appended', 'session.commentary.appended'):
        if etype == 'session.commentary.appended':  # 말하게 한 진행 상태를 GPT-Live가 받았는지(확정 뒤 멈춤 확인용)
            log.info("commentary 받음 %s", call.session_id)
        client_backend.acknowledge(call, _dump(event))
    elif etype == "response.event" and call.delegation_mode == 'responses':
        inner = event.event or {}
        itype = inner.get("type")
        item = inner.get("item") or {}
        if itype in ("response.created", "response.done"):  # 서버가 대신 기록 요청을 보낼 때 응답과 겹치지 않게
            call.backend_busy = itype == "response.created"
        if itype in TRACED:
            usage = (inner.get("response") or {}).get("usage") or {}
            trace(call, itype, item.get("type") or "", usage and {
                "in": usage.get("input_tokens"), "out": usage.get("output_tokens"),
                "reason": (usage.get("output_tokens_details") or {}).get("reasoning_tokens")})
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
        start_ms = getattr(event, "start_ms", None)
        call.add_transcript("customer", event.delta, start_ms, getattr(event, "end_ms", None))
        call.last_input_at = time.monotonic()
        if event.delta.strip():
            call.customer_said_at = time.monotonic()
            call.input_ready.set()
        listener.heard(call, event.delta, conn, client, start_ms)
    elif etype == "session.output_transcript.delta":
        call.add_transcript("agent", event.delta, getattr(event, "start_ms", None), getattr(event, "end_ms", None))
        client_backend.observe_output(call, 'transcript', getattr(event, 'start_ms', None))
        check_drift(call, conn, tool_tasks)
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


def check_drift(call: Call, conn, tasks: set) -> None:
    """음성 모델이 그래프와 다르게 스스로 마무리 인사를 하면(출력 받아쓰기로 감지) 지시를 덧붙여 바로잡는다(§2.5(7)).
    단계마다 한 번만. 받아쓰기 조각이 잘려 와도 보이게 마지막 말풍선을 본다."""
    stage = call.flow.stage
    if not stage or engine.STAGES[stage].final or call.drift_fixed == stage or not call.transcript:
        return  # 끝내는 단계(마무리 인사·상담원 이관)의 인사는 맞다
    last = call.transcript[-1]
    if last["speaker"] != "agent" or not any(m in last["text"] for m in call.texts.drift_markers):
        return
    call.drift_fixed = stage
    task = asyncio.create_task(fix_drift(call, conn, stage))
    tasks.add(task)
    task.add_done_callback(tasks.discard)


async def fix_drift(call: Call, conn, stage: str) -> None:
    """고객이 "더 없어요"라고 해서 음성 모델이 먼저 인사했을 수 있다: 아직 판별하지 않은 고객 말의 판별을 기다린 뒤에도
    같은 단계(끝내는 단계가 아님)일 때만 바로잡는다."""
    cfg = call.cfg.listener
    deadline = time.monotonic() + cfg.pause_ms / 1000 + cfg.timeout_sec
    while (call.listen_tasks or call.heard_text.strip()) and time.monotonic() < deadline:
        await asyncio.sleep(POLL_SEC)
    if call.flow.stage != stage:
        return
    log.info("음성 모델 마무리 인사 바로잡기 %s 단계=%s", call.session_id, stage)
    try:
        await conn.session.instructions.append(content=call.texts.drift_fix, delegation_id=None)
    except Exception:
        log.exception("마무리 인사 바로잡기 실패 %s", call.session_id)


# 위임 지연을 구간별로 보려고 남기는 백엔드 응답 이벤트(글자 조각 이벤트는 빼고)
TRACED = ("response.created", "response.output_item.added", "response.output_item.done",
          "response.output_text.delta", "response.done")


def trace(call: Call, what: str, kind: str = "", usage=None) -> None:
    """위임 구간 시각(통화 시작부터 ms)을 로그에 남긴다. 글자 조각(output_text.delta)은 응답마다 첫 조각만."""
    if what == "response.output_text.delta":
        if call.trace_text_started:
            return
        call.trace_text_started = True
    elif what == "response.created":
        call.trace_text_started = False
    log.info("위임 %s +%dms %s %s %s", call.session_id, (time.time() - call.started_at) * 1000, what, kind, usage or "")


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
            trace(call, "도구 결과 보냄", item.get("name") or "")
            # 도구 결과의 state.next가 백엔드 모델을 거쳐 음성 모델에 간다. 같은 내용을 진행 상태로 또 보내면 두 번 말한다
            await after_change(call, conn, delivered="state" in output)
        except Exception:
            log.exception("도구 결과 전송 실패 %s", call.session_id)
            call.add_error("도구 결과 전송 실패")


async def wait_quiet(call: Call, since: float) -> None:
    """마무리 안내(진행 상태)를 since 뒤에 음성 모델에 전한 다음 상담원 말(출력 받아쓰기)이 나오고, 그 말이 실제로 다 나간
    뒤 설정한 시간만큼 멈출 때까지. 안내 전의 맞장구는 인사로 치지 않는다. 음성 출력 이벤트는 말하지 않을 때도 와서
    기준으로 쓰지 않고, 받아쓰기는 음성보다 먼저 와서 받은 시각이 아니라 끝 시각(세션 타임라인)으로 본다.
    최대 대기는 안내를 전한 때(못 전했으면 since)부터 재고 말하는 중에는 끊지 않는다. 요청부터 재면 인사가 늦게
    시작될 때 중간에 잘린다(2026-11-01 통화들: "이용해 주셔서 감사합니다. 좋은"에서 끊김)."""
    cfg = call.cfg.call
    while True:
        now = time.monotonic()
        sent = call.progress_sent_at if call.progress_sent_at >= since else 0.0
        end = call.agent_deltas[-1][2] if call.agent_deltas else None
        played = call.clock_offset is None or end is None or call.now_ms() - end >= cfg.hangup_silence_sec * 1000
        quiet = now - call.agent_text_at >= cfg.hangup_silence_sec and played
        if quiet and (sent and call.agent_text_at > sent or now - (sent or since) >= cfg.hangup_max_wait_sec):
            return
        await asyncio.sleep(POLL_SEC)


async def watch_end(call: Call, client, conn) -> None:
    """종료·상담원 연결 요청 뒤 안내 말이 끝나면 hangup·refer. 바로 끊으면 인사가 잘린다.
    전환이 실패하면 고객을 기다리게 두지 않고 실패 안내·마무리 인사 뒤 끊는다."""
    hangup = asyncio.create_task(call.hangup_requested.wait())
    refer = asyncio.create_task(call.refer_requested.wait())
    try:
        done, _ = await asyncio.wait({hangup, refer}, return_when=asyncio.FIRST_COMPLETED)
        await wait_quiet(call, call.end_requested_at)
        if refer in done:
            try:
                await client.live.sessions.refer(call.session_id, target_uri=call.cfg.call.refer_target_uri)
                return
            except Exception:
                log.exception("상담원 전환 실패 %s", call.session_id)
                call.add_error("상담원 전환 실패")
            call.refer_failed = True
            failed_at = time.monotonic()
            await send_progress(call, conn, speak=True)  # 고객 말 없이 보내는 안내: 말하게
            await wait_quiet(call, failed_at)
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
    async with call.lock:  # 실행 중인 쓰기 도구가 있으면 그 결과를 기록한 뒤에 들어온다(통화별 잠금, §2.5(8))
        call.request_hangup()
        await engine.apply(call, ["call.ending"], "watchdog")
        await after_change(call, conn)


async def watch_flow(call: Call, conn, client) -> None:
    """시간으로 정해지는 흐름: 미뤄 둔 확정(§2.5(3)), 검색 결과 대기 시간(RAG), 듣지 않던 단계에서 쌓인 말(§2.5(6))."""
    cfg = call.cfg
    while True:
        await asyncio.sleep(POLL_SEC)
        now = time.monotonic()
        p = call.flow.pending
        if p and not p["suspended"] and now - p["at"] >= cfg.flow.commit_delay_ms / 1000:
            await _fire(call, conn, engine.COMMIT, "commit")
        elif call.rag_deadline and now >= call.rag_deadline and engine.handles(call, "rag.timeout"):
            await _fire(call, conn, "rag.timeout", "watchdog")
        if call.progress_due and not speaking(call):
            async with call.lock:
                if call.progress_due:
                    await send_progress(call, conn)
        side = call.side
        if side["off"] and not side["flushing"] and side["text"].strip() and side["stage"] != call.flow.stage \
                and engine.listening(call):
            # 결과를 안내한 다음에 판별한다(§2.5(5)): 바뀐 단계의 안내를 상담원이 마쳤거나 기다릴 만큼 기다렸으면
            since = time.time() - (call.flow.history[-1]["at"] if call.flow.history else 0.0)  # 단계가 바뀐 지 몇 초
            spoke = now - call.last_output_at < since
            quiet = now - call.last_output_at >= cfg.listener.pause_ms / 1000
            if (spoke and quiet) or since >= cfg.flow.flush_wait_sec:
                side["flushing"] = True
                listener.spawn_classify(call, conn, client, side=True)


async def _fire(call: Call, conn, event: str, by: str) -> None:
    async with call.lock:
        if event == engine.COMMIT:
            if not (call.flow.pending and not call.flow.pending["suspended"]):
                return  # 잠금을 기다리는 사이 새 말이 와서 멈췄다
        elif not engine.handles(call, event):
            return  # 잠금을 기다리는 사이 검색 결과가 와서 단계가 바뀌었다
        try:
            await engine.apply(call, [event], by)
            await after_change(call, conn, speak=True)  # 고객 말 없이 옮겼다: 다음 할 말을 말하게
        except Exception:
            log.exception("흐름 사건 처리 실패 %s %s", call.session_id, event)


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
