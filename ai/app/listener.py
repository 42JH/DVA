"""고객 말 판별(spec/sideband.md, spec/flow.md "누가 무엇을 정하나"). 고객 말의 뜻은 음성 모델(Live-1)이 알아듣고
백엔드 도구로 보고한다. 서버가 직접 듣고 상태를 바꾸는 것은 두 가지뿐이다.

1. 확인 단계(Stage.confirm: 담기·결제·취소·상담원 연결 앞의 확인 질문)의 답. 다른 용건이 섞이지 않은 답만 받는다.
2. 위임 안전망: 답·용건·기록할 값이 든 고객 말을 음성 모델이 맡기지 않았으면 잠시 뒤 서버가 백엔드에 넘긴다.
판별은 정해진 선택지 중 하나만 고르게 하고(추측 금지, 애매하면 none) 분기는 단계 정의와 상태 엔진이 한다.

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
    "question": "서비스·요금·배송·포장·이용 시간·취소 조건 등 안내를 묻는 질문(상담원이 방금 한 질문에 되묻는 말, "
                "예: \"어디 주소요?\" \"뭘 말하라는 거죠?\"는 질문이 아니라 none)",
    "restricted": "상담원 연결 요청, 또는 민원·보상·분실·결제 오류·지난 주문 수정처럼 AI가 직접 처리할 수 없는 요청",
    "correction": "이미 말한 접수 정보(이름·연락처·주소·물품·가액·수거 일시)를 고치려 함",
    "lookup": "이미 보낸 택배를 조회·배송 확인·취소하려 함(지금 묻는 질문의 답이 아닐 때)",
    "wait": "'잠깐만요'처럼 기다려 달라고 하거나 방금 한 답을 번복함",
    "end": "통화를 끝내려 함(끊겠다·이만 됐다고 분명히 말할 때. \"그만하고요\"처럼 지금 안내를 멈추고 다른 것을 하자는 말은 아님)",
}
SLOTS = {
    NO_SLOT: "정정이 아님",
    "sender_name": "보내는 분 성함", "sender_phone": "보내는 분 연락처", "sender_address": "보내는 곳 주소",
    "receiver_name": "받는 분 성함", "receiver_phone": "받는 분 연락처", "receiver_address": "받는 곳 주소",
    "item": "물건 크기·개수", "item_price": "물건 가격", "pickup_at": "수거 일시",
}
# 미뤄 둔 확정을 버리는 용건(번복·끼어드는 용건, §2.5(3))
BLOCKING = ("question", "restricted", "correction", "lookup", "wait", "end")


def stage_choices(call) -> dict[str, str]:
    stage = engine.current(call)
    choices = stage.choices(call) if stage.choices and engine.listening(call) else {}
    return {**choices, NO_ANSWER: "이 단계의 질문에 대한 답이 없거나 애매함"}


def _schema(choices: dict[str, str]) -> dict:
    return {
        "type": "object",
        "properties": {"answer": {"type": "string", "enum": list(choices)},
                       "intent": {"type": "string", "enum": list(INTENTS)},
                       "slot": {"type": "string", "enum": list(SLOTS)},
                       "value": {"type": "boolean"}, "cut": {"type": "boolean"}},
        "required": ["answer", "intent", "slot", "value", "cut"],
        "additionalProperties": False,
    }


def _situation(call, stage_name: str, heard: str, asked: str) -> str:
    """판별할 상황. 상담원의 질문은 출력 받아쓰기(음성 모델이 실제로 한 말)가 아니라 고객이 말을 시작할 때 서버가 물은
    질문이다: 음성 모델은 판별보다 먼저 다음 질문을 말해, 그 말을 주면 "네"가 엉뚱한 질문의 답으로 읽혔다
    (2026-11-01 21:47 통화: 기존 출발지 확인의 "네"가 이미 나간 "어디로 보내실 건가요?" 때문에 none)."""
    asked = asked[-call.cfg.listener.max_agent_chars:] if call.cfg.listener.max_agent_chars else ""
    before = recent_heard(call)
    return "\n".join([f"지금 단계: {engine.STAGES[stage_name].description}",
                      f"상담원이 물은 질문: {asked}",
                      *([f"고객이 바로 앞에 한 말(이미 처리함, 이어지는 말일 수 있음): {before}"] if before else []),
                      f"고객이 한 말: {heard}"])


def recent_heard(call) -> str:
    """직전에 판별한 고객 말(listener.joined_sec 안). 고객이 번호 중간에 쉬면 말이 "…번호를 010" / "-1234-5678"로
    나뉘어 판별돼 정정을 놓쳤다(2026-11-01 22:41 통화): 앞 말을 함께 보여 이어진 말로 판별하게 한다."""
    text, at = call.heard_before
    return text if text and time.monotonic() - at <= call.cfg.listener.joined_sec else ""


def _prompt(call, stage_name: str, choices: dict[str, str], heard: str, asked: str) -> str:
    return "\n".join([_situation(call, stage_name, heard, asked),
                      "answer 선택지:", *(f"- {k}: {v}" for k, v in choices.items()),
                      "intent 선택지:", *(f"- {k}: {v}" for k, v in INTENTS.items()),
                      "slot 선택지:", *(f"- {k}: {v}" for k, v in SLOTS.items()),
                      "value: 고객 말에 접수 정보로 기록할 값(이름·연락처·주소·물품·가격·수거 일시)이 들어 있으면 true",
                      "cut: 고객 말이 문장 중간에서 끊겼으면(\"보내는 곳 상세 주소가\") true"])


async def judge(call, client, stage_name: str, choices: dict[str, str], heard: str, asked: str):
    """판별 한 번 → (answer, intent, slot, value, cut, 응답). value: 고객 말에 기록할 접수 정보 값이 있음(음성 모델이 위임하지
    않으면 서버가 대신 넘길지 정할 때). cut: 말이 문장 중간에서 끊김(이어 말하는지 잠시 기다릴 때). 설정 [listener] engine으로 Decision API(빠름) 또는 Responses API.
    Decision API는 고를 답이 없는 단계면 답 질문을 뺀다(선택지는 2개 이상이어야 함). 거절한 질문은 none·false."""
    cfg = call.cfg.listener
    if cfg.engine == "decisions":
        texts = call.texts.classifier_questions
        options = {"answer": choices, "intent": INTENTS, "slot": SLOTS}
        questions = [{"type": "choice", "name": name, "instructions": texts[name],
                      "choices": [{"value": k, "description": v} for k, v in opts.items()]}
                     for name, opts in options.items() if len(opts) > 1]
        questions += [{"type": "predicate", "name": n, "instructions": texts[n]} for n in ("value", "cut")]
        resp = await client.decisions.create(model=cfg.model, input=_situation(call, stage_name, heard, asked),
                                             questions=questions)
        got = {a.name: a for a in resp.answers}
        pick = {n: getattr(got.get(n), "choice", None) for n in options}
        value, cut = ((getattr(got.get(n), "probability", 0.0) or 0.0) >= 0.5 for n in ("value", "cut"))
        return (pick["answer"] or NO_ANSWER, pick["intent"] or "none", pick["slot"] or NO_SLOT, value, cut, resp)
    resp = await client.responses.create(
        model=cfg.model,
        instructions=call.texts.classifier,
        input=_prompt(call, stage_name, choices, heard, asked),
        text={"format": {"type": "json_schema", "name": "listener", "strict": True, "schema": _schema(choices)}},
        reasoning={"effort": cfg.reasoning_effort},
        store=False,
    )
    result = json.loads(resp.output_text)
    return (result["answer"], result["intent"], result["slot"], bool(result.get("value")), bool(result.get("cut")),
            resp)


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
        call.heard_asked = engine.next_text(call)  # 고객이 답하는 질문(판별 기준, _situation)
    call.heard_text = (call.heard_text + delta)[-call.cfg.listener.max_heard_chars:]
    call.heard_at = time.monotonic()
    _schedule(call, conn, client)


def _side(call, delta: str, start_ms: int | None, late: bool) -> None:
    """지난 단계의 말을 쌓는다. 그 말을 할 때의 단계가 듣지 않는 단계였으면 off(전역 의도 전부를 본다)."""
    stage = _stage_at(call, start_ms) if late else call.flow.stage
    side = call.side
    if side["stage"] != stage or not side["text"].strip():
        side.update(stage=stage, text="", off=not _listens(call, stage), since=time.monotonic(), flushing=False,
                    asked=call.heard_asked)
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


def spawn_classify(call, conn, client, side: bool = False, retry: bool = True) -> None:
    task = asyncio.create_task(classify(call, conn, client, call.heard_rev, side, retry))  # 이후 말로 취소되지 않게 따로
    call.listen_tasks.add(task)
    task.add_done_callback(call.listen_tasks.discard)


async def classify(call, conn, client, rev: int, side: bool = False, retry: bool = False) -> None:
    """판별 한 번. side면 지난 단계의 말을 전역 의도로만 본다. 그사이 새 말이 왔으면(리비전이 다르면) 결과를 버린다.
    retry: 시간 초과면 같은 말을 한 번 더 판별한다(2026-10-31 통화: 이름 정정 판별이 시간 초과로 버려짐)."""
    try:
        await _classify(call, conn, client, rev, side, retry)
    finally:
        if side:
            call.side["flushing"] = False


async def _classify(call, conn, client, rev: int, side: bool, retry: bool = False) -> None:
    cfg = call.cfg.listener
    if side:
        stage_name, text, start_ms, started = call.side["stage"], call.side["text"].strip(), None, call.side["since"]
        choices, asked = {NO_ANSWER: "단계 답으로 쓰지 않음"}, call.side.get("asked") or call.heard_asked
    else:
        stage_name, raw = call.flow.stage, call.heard_text
        text, start_ms, started = raw.strip(), call.heard_start, call.heard_started_at
        choices, asked = stage_choices(call), call.heard_asked
    if not text:
        return
    record = {"call_id": f"listen-{rev}{'-side' if side else ''}", "name": "listener", "arguments": text,
              "status": "running", "started": time.time()}
    call.tool_calls[record["call_id"]] = record
    t0 = time.monotonic()
    try:
        answer, intent, slot, value, cut, resp = await asyncio.wait_for(
            judge(call, client, stage_name, choices, text, asked), cfg.timeout_sec)
        if answer not in choices or intent not in INTENTS or slot not in SLOTS:  # 모델 출력은 미신뢰 입력
            raise ValueError(f"선택지 밖 판별: {(answer, intent, slot)}")
    except Exception as e:
        log.warning("판별 실패 %s: %s %s %dms", call.session_id, type(e).__name__, e,
                    (time.monotonic() - t0) * 1000)  # TimeoutError는 메시지가 비어 이름을 같이 남긴다
        record.update(status="error", output={"error": type(e).__name__})
        call.add_error(f"판별 실패: {type(e).__name__}")
        if isinstance(e, TimeoutError) and retry and not side and rev == call.heard_rev:
            spawn_classify(call, conn, client, retry=False)
            return
        if call.flow.pending and call.flow.pending["suspended"] and (side or rev == call.heard_rev):
            async with call.lock:
                # 번복인지 모르는 채로 "예"에 걸린 확정(취소)은 하지 않는다. 다 찬 상태에 걸린 확정(결제 단계 진입)은 다시 건다
                call.flow.pending = None
                await settle(call, None, blocking=False)
                await after_change(call, conn)
        return
    record.update(output={"answer": answer, "intent": intent, "slot": slot, "value": value, "cut": cut},
                  elapsed_ms=round((time.monotonic() - t0) * 1000), usage=_usage(resp))
    if cut and not side:
        # 문장 중간에서 끊긴 말("보내는 곳 상세 주소가")을 바로 적용하면 고객이 말하는 중에 "다시 말씀해 주세요"가 나간다
        # (2026-11-01 23:09 통화). 잠시 기다려 이어 말하면 이 판별은 낡은 것이 되고(리비전), 합친 말을 다시 판별한다
        await asyncio.sleep(cfg.cut_wait_ms / 1000)
    before = recent_heard(call)
    joined = f"{before} {text}" if before and not side else text  # 서버가 대신 넘길 때는 나뉜 앞말까지
    async with call.lock:
        if side:
            if call.side["stage"] != stage_name or call.side["text"].strip() != text:
                record["status"] = "stale"  # 그사이 지난 단계의 말이 더 쌓였거나 다른 단계의 말로 바뀜
                call.notify()
                return
            call.side["text"] = ""
            events = await apply_side(call, intent)
            if intent == "correction" or value:
                forward_later(call, conn, text, started)
        else:
            if rev != call.heard_rev or call.flow.stage != stage_name:
                record["status"] = "stale"  # 그사이 새 말이 왔거나(리비전) 다른 경로로 단계가 바뀜
                if call.flow.stage != stage_name and rev == call.heard_rev and call.heard_stage == stage_name:
                    _move_to_side(call, conn, client, stage_name)  # 단계가 바뀌기 전에 한 말: 전역 의도로만 다시 본다
                call.notify()
                return
            try:
                events = await apply_answer(call, answer, intent, start_ms=start_ms)
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
            if reportable(call, stage_name, answer, intent, value):
                forward_later(call, conn, joined, started, joined=joined != text)  # 음성 모델이 위임하지 않으면 서버가 대신(말이 끝나고 잠시 뒤)
            elif not events and answer == NO_ANSWER and intent == "none":
                await record_heard(call, conn, text, call.heard_at)  # 설정 record_heard(기본 꺼짐): 판별할 것 없는 말 전부
            # 판별에 쓴 말은 소비한다. 남기면 지난 말이 다음 판별에 붙어 오판된다(2026-10-31: "저 말투가 그렇죠"가 다음
            # 주소 답에 붙어 제한된 요청으로 판별돼 상담원 제안으로 빠짐)
            _consume(call, raw)
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
        log.info("판별 %s 단계=%s answer=%s intent=%s slot=%s side=%s 모델=%dms 토큰=%s 진행상태변경=%s",
                 call.session_id, stage_name, answer, intent, slot, side, record["elapsed_ms"], record["usage"],
                 call.last_progress != before)
        call.notify()


def _usage(resp) -> dict | None:
    """판별 응답의 토큰 수(입력·출력·추론). 응답이 느린 원인이 추론량인지 보려고 관제·로그에 남긴다."""
    u = getattr(resp, "usage", None)
    if u is None:
        return None
    details = getattr(u, "output_tokens_details", None)
    return {"input": getattr(u, "input_tokens", None), "output": getattr(u, "output_tokens", None),
            "reasoning": getattr(details, "reasoning_tokens", None)}


def _consume(call, raw: str) -> None:
    """판별한 말만 지운다. 결과를 적용하는(await) 사이에 붙은 새 말은 남겨 다음 판별이 보게 한다."""
    call.heard_text = call.heard_text[len(raw):] if call.heard_text.startswith(raw) else call.heard_text
    call.heard_before = (raw.strip(), time.monotonic())


def _move_to_side(call, conn, client, stage_name: str) -> None:
    call.side.update(stage=stage_name, text=call.heard_text, off=not _listens(call, stage_name),
                     since=call.heard_started_at, flushing=True)
    call.heard_text = ""
    spawn_classify(call, conn, client, side=True)


def reportable(call, stage_name: str, answer: str, intent: str, value: bool) -> bool:
    """백엔드에 보고할 것이 있는 말: 정정·기록할 값, 그리고 확인 단계가 아니면 질문의 답이나 끼어드는 용건(기다림 제외)."""
    if intent == "correction" or value:
        return True
    return not engine.STAGES[stage_name].confirm and (answer != NO_ANSWER or intent not in ("none", "wait"))


def forward_later(call, conn, text: str, started: float, joined: bool = False) -> None:
    """보고할 것이 있는 고객 말을 음성 모델이 위임하지 않으면 서버가 대신 백엔드에 넘긴다(말이 끝나고
    delegate_wait_sec 뒤). 음성 모델이 말로만 "네, ○○님"하고 넘기지 않아 정정이 빠지던 것(2026-11-01 22:41 통화).
    joined: 앞말까지 이은 글이면 앞말로 걸어 둔 요청은 취소한다(같은 값을 두 번 넘기지 않게)."""
    old = call.forward_task
    if joined and old and not old.done():
        old.cancel()
    task = asyncio.create_task(_forward(call, conn, text, started, call.heard_at))
    call.forward_task = task
    call.listen_tasks.add(task)
    task.add_done_callback(call.listen_tasks.discard)


async def _forward(call, conn, text: str, started: float, heard_at: float) -> None:
    cfg = call.cfg.listener
    await asyncio.sleep(max(0.0, heard_at + cfg.delegate_wait_sec - time.monotonic()))
    deadline = time.monotonic() + cfg.timeout_sec
    while call.backend_busy and call.delegated_at < started and time.monotonic() < deadline:
        await asyncio.sleep(0.05)  # 백엔드 응답 중에 response.create를 보내면 겹친다
    await record_heard(call, conn, text, started, force=True)


async def record_heard(call, conn, text: str, heard_at: float, force: bool = False) -> bool:
    """이 단계의 답이 아닌 고객 말(주문 정보일 수 있음)을 음성 모델이 위임하지 않았으면 서버가 백엔드에 넘긴다.
    음성 모델이 위임을 자주 빠뜨려 주소 보정·기록이 안 되던 것(2026-10-28 13:26·17:44 통화).
    백엔드가 record_order를 부르면 기존 함수 호출 경로(sideband.run_tool)로 실행된다.
    force: 정정은 설정(record_heard)과 상관없이 넘긴다. 음성 모델이 "네, 현승준님"이라고 말로만 받고 넘기지 않아
    틀린 이름("현승우")으로 접수됐다(2026-10-31 통화)."""
    if (not (call.cfg.listener.record_heard or force) or call.delegation_mode != "responses"
            or engine.current(call).final
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


async def apply_answer(call, answer: str, intent: str = "none", *, start_ms: int | None = None) -> list[str]:
    """확인 단계의 답(선택지 안의 것만) → 사건 → 단계 전이. 다른 용건이 섞인 말("네, 근데 받는 분이 틀렸어요")의 답은
    받지 않는다: 그 용건은 음성 모델이 응대하고 백엔드가 보고하며, 확인은 다시 받는다. 확인 단계가 아니면 아무것도
    하지 않는다(답은 백엔드가 answer 도구로 보고). 질문의 핵심 구간을 듣기 전에 한 답은 받지 않고 한 번 다시 묻는다
    (거절처럼 되돌릴 수 있는 답은 받는다)."""
    stage = engine.current(call)
    if not engine.listening(call) or not stage.confirm:
        return []
    pending = call.flow.pending
    if intent in BLOCKING:
        call.flow.pending = None
    events: list[str] = []
    if answer != NO_ANSWER and stage.on_answer is not None and answer in stage_choices(call) and intent == "none":
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


async def apply_side(call, intent: str) -> list[str]:
    """지난 단계의 말(전환 전 늦은 꼬리 조각, 듣지 않던 단계에서 쌓인 말)은 단계 답으로 쓰지 않는다. 끼어드는 용건이면
    미뤄 둔 확정만 버린다(용건 자체는 음성 모델이 응대하고, 맡기지 않았으면 위임 안전망이 넘긴다)."""
    pending = call.flow.pending
    if intent in BLOCKING:
        call.flow.pending = None
    await settle(call, pending, intent in BLOCKING)
    return []


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
