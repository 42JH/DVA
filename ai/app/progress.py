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


def agent_speaking(call) -> bool:
    """상담원 음성이 아직 나가는 중: 출력 받아쓰기 조각이 말 멈춤 대기 안에 왔거나, 마지막 조각의 끝 시각(세션 타임라인)이
    지금보다 뒤(받아쓰기는 음성보다 먼저 온다). 음성 출력 이벤트(output_audio.delta)는 말하지 않을 때도 계속 와서
    기준으로 쓰지 않는다(2026-10-31 통화: 확정 뒤 진행 상태가 "상담원 말하는 중"으로 끝까지 미뤄져 32초 침묵)."""
    if time.monotonic() - call.agent_text_at < call.cfg.listener.pause_ms / 1000:
        return True
    end = call.agent_deltas[-1][2] if call.agent_deltas else None
    return call.clock_offset is not None and end is not None and end > call.now_ms()


def speaking(call) -> bool:
    return customer_speaking(call) or agent_speaking(call)


async def send_progress(call, conn, delivered: bool = False, speak: bool = False) -> None:
    """음성 모델에 "다음에 할 말 + 기록된 값". 바뀌었을 때만 보낸다. 한 번만 붙이는 말(정정 확인)은 보낸 뒤 지운다.
    delivered: 도구 결과로 이미 전해졌다(보내지 않고 보낸 것으로 친다). 고객이나 상담원이 말하는 중이면 미뤘다가 말이
    멈추면 보낸다(watch_flow): 진행 상태가 오면 음성 모델이 바로 말을 시작해 고객 말·자기 말 위로 겹친다(2026-10-31 통화).
    speak: 고객 말 없이 서버가 단계를 옮겼다(확정·검색 시간 초과·서버 도구 결과). thinking.append는 말없이 주는 맥락이라
    음성 모델이 다음 고객 말까지 말하지 않아 통화가 멈췄다(2026-10-31). 다음 할 말을 commentary.append로도 보낸다."""
    text = engine.progress_text(call, call.cfg.progress.max_chars)
    call.progress_speak = call.progress_speak or speak
    if text != call.last_progress and not delivered:
        if speaking(call):
            if not call.progress_due:
                log.info("진행 상태 미룸 %s 단계=%s 고객=%s 상담원=%s 말하게=%s", call.session_id, call.flow.stage,
                         customer_speaking(call), agent_speaking(call), call.progress_speak)
            call.progress_due = True
            return
        await conn.session.thinking.append(content=text, delegation_id=None)
        if call.progress_speak:
            await conn.session.commentary.append(content=call.texts.speak.format(next=engine.next_text(call)),
                                                 delegation_id=None)
        log.info("진행 상태 보냄 %s 단계=%s 말하게=%s", call.session_id, call.flow.stage, call.progress_speak)
    call.last_progress, call.progress_due, call.progress_speak = text, False, False
    call.flow.notice = []


async def update_backend(call, conn) -> None:
    """백엔드 모델 지시문 끝의 "지금 상태"를 상태가 바뀔 때마다 갱신한다(session.update, 이후 위임부터 적용).
    백엔드는 위임을 받을 때 단계를 몰라 get_state부터 부르거나 엉뚱한 도구를 고르고 정정을 기록하지 않았다
    (2026-10-31 실측: 상태를 미리 주면 get_state 선행·엉뚱한 도구 0회, 정정 기록). 말하는 중이어도 미루지 않는다.
    도구 결과에는 늘 최신 state가 붙고, 이 상태가 늦을 수 있어 get_state는 그대로 둔다."""
    if call.delegation_mode != "responses" or not call.backend_instructions:
        return
    state = call.texts.backend_state.format(state=json.dumps(engine.summary(call), ensure_ascii=False))
    if state == call.backend_state:
        return
    try:
        await conn.session.update(session={"delegation": {"type": "responses", "responses": {
            "instructions": call.backend_instructions + state}}})
    except Exception:
        log.exception("백엔드 상태 갱신 실패 %s", call.session_id)
        call.add_error("백엔드 상태 갱신 실패")
        return
    call.backend_state = state
    log.info("백엔드 상태 갱신 %s 단계=%s", call.session_id, call.flow.stage)


async def after_change(call, conn, delivered: bool = False, speak: bool = False) -> None:
    """상태를 바꾼 뒤(판별·도구·감시): 서버가 실행할 도구가 생겼으면 시작하고, 백엔드 상태를 갱신하고 진행 상태를 보낸다."""
    if call.server_tool:
        name, args, fail_event = call.server_tool
        call.server_tool = None
        task = asyncio.create_task(run_server_tool(call, conn, name, args, fail_event))
        call.write_tasks.add(task)
        task.add_done_callback(call.write_tasks.discard)
    await update_backend(call, conn)
    await send_progress(call, conn, delivered, speak)


async def run_server_tool(call, conn, name: str, args: dict, fail_event: str) -> None:
    """백엔드 모델이 아니라 서버가 부르는 쓰기 도구(취소). 디스패처를 그대로 거친다(인수 검증·허용 단계·시간 제한·기록).
    도구가 결과 사건 없이 실패하면(시간 초과·예외) fail_event로 실패 분기를 탄다."""
    op = args["operation_id"]
    async with call.lock:
        output = await dispatch(call, name, json.dumps(args, ensure_ascii=False), op)
        try:
            if not output["ok"] and not call.tool_calls[op].get("events"):
                await engine.apply(call, [fail_event], name)
            await after_change(call, conn, speak=True)
        except Exception:
            log.exception("서버 도구 결과 반영 실패 %s %s", call.session_id, name)
