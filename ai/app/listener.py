"""고객 말 판별(spec/sideband.md, spec/LANGGRAPH_REBUILD.md §2.1·§2.5). 대화 상태는 백엔드 도구 호출이 아니라
서버가 고객 말을 직접 듣고 바꾼다(① 받아쓰기 경로).

고객 받아쓰기를 모아 두었다가 말이 멈추면 작은 모델로 "이 단계의 답"과 "전역 의도"를 판별한다. 판별 결과는 항상
전역 의도가 먼저다: 질문 → QNA, 제한된 요청 → RESTRICTED_REQUEST, 정정 → 그 항목만 고치기, 그 밖에는 현재 단계의 답.
판별은 정해진 선택지 중 하나만 고르게 하고(추측 금지, 애매하면 none), 분기와 처리는 단계 정의와 상태 엔진이 한다.

끼어들기·정정(§2.5): 판별마다 그때의 말 리비전을 붙여 최신 결과만 쓰고, 질문의 핵심 구간을 듣기 전에 한 답은 다시 묻고,
단계가 바뀌기 전에 한 말의 늦은 조각과 듣지 않는 단계에서 쌓인 말은 단계 답으로 쓰지 않는다. 새 말이 오면 미뤄 둔
확정(취소 "예", 결제 단계 진입)을 멈췄다가, 번복이 아니었으면 다시 잰다.
"""

import asyncio
import json
import logging
import re
import time

from app.flow import engine
from app.progress import after_change

log = logging.getLogger(__name__)

NO_ANSWER = "none"
NO_SLOT = "none"
INTENTS = {
    "none": "끼어드는 용건 없음",
    "question": "서비스·요금·배송·포장·이용 시간·취소 조건 등 안내를 묻는 질문",
    "restricted": "상담원 연결 요청, 또는 민원·보상·분실·결제 오류·지난 주문 수정처럼 AI가 직접 처리할 수 없는 요청",
    "correction": "이미 말한 접수 정보(이름·연락처·주소·물품·가액·수거 일시)를 고치려 함",
    "wait": "'잠깐만요'처럼 기다려 달라고 하거나 방금 한 답을 번복함",
    "end": "통화를 끝내려 함",
}
SLOTS = {
    NO_SLOT: "정정이 아님",
    "sender_name": "보내는 분 성함", "sender_phone": "보내는 분 연락처", "sender_address": "보내는 곳 주소",
    "receiver_name": "받는 분 성함", "receiver_phone": "받는 분 연락처", "receiver_address": "받는 곳 주소",
    "item": "물건 크기·개수", "item_price": "물건 가격", "pickup_at": "수거 일시",
}
# 미뤄 둔 확정을 버리는 용건(번복·끼어드는 용건, §2.5(3))
BLOCKING = ("question", "restricted", "correction", "wait", "end")
# 듣지 않는 단계에서 쌓인 말에서 받는 용건(§2.5(6)). 듣던 단계의 늦은 꼬리 조각은 정정만(§2.5(2))
OFF_INTENTS = BLOCKING


def stage_choices(call) -> dict[str, str]:
    stage = engine.current(call)
    choices = stage.choices(call) if stage.choices and engine.listening(call) else {}
    return {**choices, NO_ANSWER: "이 단계의 질문에 대한 답이 없거나 애매함"}


def _schema(choices: dict[str, str]) -> dict:
    return {
        "type": "object",
        "properties": {"answer": {"type": "string", "enum": list(choices)},
                       "intent": {"type": "string", "enum": list(INTENTS)},
                       "slot": {"type": "string", "enum": list(SLOTS)}},
        "required": ["answer", "intent", "slot"],
        "additionalProperties": False,
    }


def _prompt(call, stage_name: str, choices: dict[str, str], heard: str) -> str:
    agent = next((b["text"] for b in reversed(call.transcript) if b["speaker"] == "agent"), "")
    agent = agent[-call.cfg.listener.max_agent_chars:] if call.cfg.listener.max_agent_chars else ""
    lines = [f"지금 단계: {engine.STAGES[stage_name].description}",
             f"상담원이 방금 한 말: {agent}",
             f"고객이 한 말: {heard}",
             "answer 선택지:", *(f"- {k}: {v}" for k, v in choices.items()),
             "intent 선택지:", *(f"- {k}: {v}" for k, v in INTENTS.items()),
             "slot 선택지:", *(f"- {k}: {v}" for k, v in SLOTS.items())]
    return "\n".join(lines)


def heard(call, delta: str, conn, client, start_ms: int | None = None) -> None:
    """고객 받아쓰기 조각. 지금 단계의 말이면 아직 판별하지 않은 말에 이어 붙이고, 말이 멈추면 판별한다.
    단계가 바뀌기 전에 한 말(시작이 단계 진입보다 이름)과 듣지 않는 단계의 말은 따로 쌓는다."""
    call.heard_rev += 1  # 새 입력: 이 앞의 판별은 낡았고, 미뤄 둔 확정은 멈춘다(§2.5(3))
    if call.flow.pending:
        call.flow.pending["suspended"] = True
    entered = call.flow.entered_ms
    late = start_ms is not None and entered is not None and start_ms < entered
    if late or not engine.listening(call):
        _side(call, delta, start_ms, late)
        if late and not call.side["off"]:  # 듣던 단계의 늦은 꼬리 조각은 말이 멈추면 바로 본다(정정만)
            _schedule(call, conn, client, side=True)
        return
    stage = engine.current(call)
    if call.heard_stage != stage.name or not call.heard_text.strip():
        call.heard_stage, call.heard_text = stage.name, ""
        call.heard_start, call.heard_started_at = start_ms, time.monotonic()
    call.heard_text = (call.heard_text + delta)[-call.cfg.listener.max_heard_chars:]
    call.heard_at = time.monotonic()
    _schedule(call, conn, client)


def _side(call, delta: str, start_ms: int | None, late: bool) -> None:
    """지난 단계의 말을 쌓는다. 그 말을 할 때의 단계가 듣지 않는 단계였으면 off(전역 의도 전부를 본다)."""
    stage = _stage_at(call, start_ms) if late else call.flow.stage
    side = call.side
    if side["stage"] != stage or not side["text"].strip():
        side.update(stage=stage, text="", off=not _listens(call, stage), since=time.monotonic(), flushing=False)
    side["text"] = (side["text"] + delta)[-call.cfg.listener.max_heard_chars:]


def _stage_at(call, ms: int) -> str:
    """세션 타임라인 시각 ms에 머물던 단계(전이 기록의 진입 시각으로)."""
    stage = call.flow.history[0]["from"] if call.flow.history else call.flow.stage
    for h in call.flow.history:
        if h["ms"] is not None and h["ms"] <= ms:
            stage = h["to"]
    return stage


def _listens(call, stage: str) -> bool:
    listen = engine.STAGES[stage].listen
    return listen(call) if callable(listen) else listen


def _schedule(call, conn, client, side: bool = False) -> None:
    """말이 멈추면 판별. 지금 단계의 말과 지난 단계의 말은 따로 잰다(서로의 판별을 미루지 않게)."""
    timer = call.side_timer if side else call.listen_timer
    if timer and not timer.done():
        timer.cancel()
    timer = asyncio.create_task(_after_pause(call, conn, client, side))
    if side:
        call.side_timer = timer
    else:
        call.listen_timer = timer


async def _after_pause(call, conn, client, side: bool) -> None:
    await asyncio.sleep(call.cfg.listener.pause_ms / 1000)
    spawn_classify(call, conn, client, side)


def spawn_classify(call, conn, client, side: bool = False) -> None:
    task = asyncio.create_task(classify(call, conn, client, call.heard_rev, side))  # 이후 말로 취소되지 않게 따로
    call.listen_tasks.add(task)
    task.add_done_callback(call.listen_tasks.discard)


async def classify(call, conn, client, rev: int, side: bool = False) -> None:
    """판별 한 번. side면 지난 단계의 말을 전역 의도로만 본다. 그사이 새 말이 왔으면(리비전이 다르면) 결과를 버린다."""
    try:
        await _classify(call, conn, client, rev, side)
    finally:
        if side:
            call.side["flushing"] = False


async def _classify(call, conn, client, rev: int, side: bool) -> None:
    cfg = call.cfg.listener
    if side:
        stage_name, text, start_ms, started = call.side["stage"], call.side["text"].strip(), None, call.side["since"]
        choices = {NO_ANSWER: "단계 답으로 쓰지 않음"}
    else:
        stage_name, text = call.flow.stage, call.heard_text.strip()
        start_ms, started = call.heard_start, call.heard_started_at
        choices = stage_choices(call)
    if not text:
        return
    record = {"call_id": f"listen-{rev}{'-side' if side else ''}", "name": "listener", "arguments": text,
              "status": "running", "started": time.time()}
    call.tool_calls[record["call_id"]] = record
    t0 = time.monotonic()
    try:
        resp = await asyncio.wait_for(client.responses.create(
            model=cfg.model,
            instructions=call.texts.classifier,
            input=_prompt(call, stage_name, choices, text),
            text={"format": {"type": "json_schema", "name": "listener", "strict": True, "schema": _schema(choices)}},
            reasoning={"effort": cfg.reasoning_effort},
            store=False,
        ), cfg.timeout_sec)
        result = json.loads(resp.output_text)
        answer, intent, slot = result["answer"], result["intent"], result["slot"]
        if answer not in choices or intent not in INTENTS or slot not in SLOTS:  # 모델 출력은 미신뢰 입력
            raise ValueError(f"선택지 밖 판별: {result}")
    except Exception as e:
        log.warning("판별 실패 %s: %s %s %dms", call.session_id, type(e).__name__, e,
                    (time.monotonic() - t0) * 1000)  # TimeoutError는 메시지가 비어 이름을 같이 남긴다
        record.update(status="error", output={"error": type(e).__name__})
        call.add_error(f"판별 실패: {type(e).__name__}")
        if call.flow.pending and call.flow.pending["suspended"] and (side or rev == call.heard_rev):
            async with call.lock:
                # 번복인지 모르는 채로 "예"에 걸린 확정(취소)은 하지 않는다. 다 찬 상태에 걸린 확정(결제 단계 진입)은 다시 건다
                call.flow.pending = None
                await settle(call, None, blocking=False)
                await after_change(call, conn)
        return
    record.update(output={"answer": answer, "intent": intent, "slot": slot},
                  elapsed_ms=round((time.monotonic() - t0) * 1000))
    async with call.lock:
        if side:
            if call.side["stage"] != stage_name or call.side["text"].strip() != text:
                record["status"] = "stale"  # 그사이 지난 단계의 말이 더 쌓였거나 다른 단계의 말로 바뀜
                call.notify()
                return
            call.side["text"] = ""
            events = await apply_side(call, intent, slot, call.side["off"], started)
        else:
            if rev != call.heard_rev or call.flow.stage != stage_name:
                record["status"] = "stale"  # 그사이 새 말이 왔거나(리비전) 다른 경로로 단계가 바뀜
                if call.flow.stage != stage_name and rev == call.heard_rev and call.heard_stage == stage_name:
                    _move_to_side(call, conn, client, stage_name)  # 단계가 바뀌기 전에 한 말: 전역 의도로만 다시 본다
                call.notify()
                return
            try:
                events = await apply_answer(call, answer, intent, slot, start_ms=start_ms, started_at=started)
            except Exception as e:
                # 예: 접수·저장 중 백엔드 실패. 상태는 그대로 두고 음성 모델에 오류 안내를 준다
                log.exception("답 처리 실패 %s", call.session_id)
                record.update(status="error", output={**record["output"], "error": type(e).__name__})
                call.add_error(f"답 처리 실패: {type(e).__name__}")
                try:
                    await conn.session.thinking.append(content=call.texts.answer_error, delegation_id=None)
                except Exception:
                    log.exception("오류 안내 전송 실패 %s", call.session_id)
                return
            if events or answer != NO_ANSWER or intent != "none":
                call.heard_text = ""  # 판별에 쓴 말은 소비
            elif await record_heard(call, conn, text, call.heard_at):
                call.heard_text = ""  # 백엔드에 넘긴 말은 다시 넘기지 않게
        record["status"] = "done"
        record["output"]["events"] = events
        before = call.last_progress
        try:
            if call.reask:  # 질문을 다 듣기 전에 한 답: 받지 않고 같은 질문을 한 번 다시 하게 한다(§2.5(1))
                call.reask = False
                await conn.session.thinking.append(
                    content=call.texts.reask.format(next=engine.next_text(call)), delegation_id=None)
            await after_change(call, conn)
        except Exception:
            log.exception("진행 상태 전송 실패 %s", call.session_id)
        # 고객 말이 끝난 뒤(마지막 받아쓰기 조각) 진행 상태를 보낼 때까지. 멈춤 대기(pause_ms) + 판별 + 처리
        record["total_ms"] = round((time.monotonic() - call.heard_at) * 1000)
        log.info("판별 %s 단계=%s answer=%s intent=%s slot=%s side=%s 모델=%dms 진행상태변경=%s",
                 call.session_id, stage_name, answer, intent, slot, side, record["elapsed_ms"],
                 call.last_progress != before)
        call.notify()


def _move_to_side(call, conn, client, stage_name: str) -> None:
    call.side.update(stage=stage_name, text=call.heard_text, off=not _listens(call, stage_name),
                     since=call.heard_started_at, flushing=True)
    call.heard_text = ""
    spawn_classify(call, conn, client, side=True)


async def record_heard(call, conn, text: str, heard_at: float) -> bool:
    """이 단계의 답이 아닌 고객 말(주문 정보일 수 있음)을 음성 모델이 위임하지 않았으면 서버가 백엔드에 넘긴다.
    음성 모델이 위임을 자주 빠뜨려 주소 보정·기록이 안 되던 것(2026-10-28 13:26·17:44 통화).
    백엔드가 record_order를 부르면 기존 함수 호출 경로(sideband.run_tool)로 실행된다."""
    if (not call.cfg.listener.record_heard or call.delegation_mode != "responses"
            or "record_order" not in engine.current(call).tools
            or call.delegated_at >= heard_at):  # 말이 끝난 뒤 음성 모델이 이미 위임함
        return False
    try:
        await conn.response.item.create(item={"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": call.texts.record_heard.format(heard=text)}]})
        await conn.response.create()
    except Exception:
        log.exception("서버 기록 요청 실패 %s", call.session_id)
        call.add_error("서버 기록 요청 실패")
        return False
    log.info("서버 기록 요청 %s 단계=%s", call.session_id, call.flow.stage)
    return True


async def _intent_events(call, intent: str, slot: str, started_at: float | None) -> list[str] | None:
    """전역 의도(§2.1)의 사건. 용건이 없으면 None(현재 단계의 답으로 처리)."""
    if intent == "question":
        if started_at is not None and call.search_entry_at >= started_at:
            return []  # 이 말의 검색 결과가 먼저 와서 이미 QnA로 들어갔다(같은 질문을 두 번 처리하지 않게)
        return ["intent.question"]
    if intent == "restricted":
        return ["intent.restricted"]
    if intent == "end":  # TODO(flow): 다이어그램에 없음. 통화를 끝내겠다고 하면 마무리 인사 후 종료
        return ["call.ending"]
    if intent == "correction":
        return call.start_correction(slot) if slot != NO_SLOT else []
    if intent == "wait":
        return []
    return None


async def apply_answer(call, answer: str, intent: str, slot: str = NO_SLOT, *, start_ms: int | None = None,
                       started_at: float | None = None) -> list[str]:
    """판별 결과 → 사건 → 단계 전이. 전역 의도가 먼저, 그 밖에는 현재 단계의 답(선택지 안의 것만).
    질문의 핵심 구간을 듣기 전에 한 답은 받지 않고 한 번 다시 묻는다(거절처럼 되돌릴 수 있는 답은 받는다)."""
    if not engine.listening(call):
        return []
    stage = engine.current(call)
    pending = call.flow.pending
    if intent in BLOCKING:
        call.flow.pending = None
    events = await _intent_events(call, intent, slot, started_at)
    if events is None:
        events = []
        if answer != NO_ANSWER and stage.on_answer and answer in stage_choices(call):
            if answer not in stage.unheard_ok and not prompt_heard(call, start_ms) and not call.flow.reasked:
                call.flow.reasked = call.reask = True
                log.info("질문을 다 듣기 전 답 %s 단계=%s answer=%s", call.session_id, stage.name, answer)
            else:
                events = await stage.on_answer(call, answer)
    await engine.apply(call, events, "listener")
    await settle(call, pending, intent in BLOCKING)
    return events


async def settle(call, pending: dict | None, blocking: bool) -> None:
    """새 말 때문에 멈춘 확정 지연(§2.5(3)): 번복·끼어드는 용건이 아니었으면 다시 잰다. 번복으로 버렸으면 그대로 두되,
    다 찬 상태에 걸리는 확정(결제 단계 진입)은 다음 말이 번복이 아닐 때 다시 건다."""
    if pending is not None and call.flow.pending is pending:
        pending.update(suspended=False, at=time.monotonic())
    elif call.flow.pending is None and not blocking \
            and any(t.commit and t.event == engine.ENTERED for t in engine.current(call).transitions):
        await engine.apply(call, [engine.ENTERED], "listener")


async def apply_side(call, intent: str, slot: str, off: bool, started_at: float | None) -> list[str]:
    """지난 단계의 말은 단계 답으로 쓰지 않는다. 듣지 않던 단계에서 쌓인 말은 전역 의도(질문·제한된 요청·정정·종료·
    기다림)를 받고(§2.5(6)), 듣던 단계의 늦은 꼬리 조각은 정정만 받는다(§2.5(2))."""
    pending = call.flow.pending
    if intent == "none" or not (intent == "correction" or (off and intent in OFF_INTENTS)) \
            or engine.current(call).final:
        await settle(call, pending, blocking=False)
        return []
    if intent in BLOCKING:
        call.flow.pending = None
    events = await _intent_events(call, intent, slot, started_at) or []
    await engine.apply(call, events, "listener")
    await settle(call, pending, intent in BLOCKING)
    return events


def prompt_heard(call, start_ms: int | None) -> bool:
    """고객이 말을 시작했을 때 질문의 핵심 구간(선택지·확인 대상)이 이미 나갔는지(§2.5(1)). 출력 받아쓰기는 고객이
    실제로 들은 음성이 아니라 근사치다. 핵심 구간 비교가 어긋나도(숫자 읽기·바꿔 말하기) 상담원이 말을 마친 뒤
    고객이 답했으면 들은 것으로 본다. 시각을 모르면 따지지 않는다."""
    key = engine.question_key(call)
    core = call.texts.core.get(key) if key else None
    entered = call.flow.entered_ms
    if not core or start_ms is None or entered is None:
        return True
    grace = call.cfg.flow.heard_grace_ms
    spoken = [(t, s, e) for t, s, e in call.agent_deltas if s is not None and e is not None and s >= entered]
    before = "".join(t for t, s, e in spoken if e <= start_ms + grace)
    if covers(before, core.format(**call.text_vars())):
        return True
    barge_in = any(s < start_ms and e > start_ms + grace for t, s, e in spoken)
    return bool(before.strip()) and not barge_in


def covers(spoken: str, core: str) -> bool:
    """핵심 구간의 낱말이 상담원 말에 차례대로 나왔음(띄어쓰기 무시). 숫자는 한글로 읽혔을 수 있어 숫자를 뺀 부분도 본다."""
    said = "".join(re.findall(r"[0-9A-Za-z가-힣]+", spoken))
    pos = 0
    for word in re.findall(r"[0-9A-Za-z가-힣]+", core):
        part = word if word in said[pos:] else re.sub(r"\d", "", word)
        if len(part) < 2:
            continue
        i = said.find(part, pos)
        if i < 0:
            return False
        pos = i + len(part)
    return True
