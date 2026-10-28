"""고객 답 판별(spec/sideband.md). 대화 상태는 백엔드 도구 호출이 아니라 서버가 고객 말을 직접 듣고 바꾼다.

고객 받아쓰기를 모아 두었다가 말이 멈추면 작은 모델로 "이 단계의 답"과 "끼어드는 용건"을 판별한다.
판별은 정해진 선택지 중 하나만 고르게 하고(추측 금지, 애매하면 none), 분기와 처리는 단계 정의(on_answer)와
상태 엔진이 한다. 판별 중에 단계가 바뀌었거나 더 새 판별이 시작됐으면 결과를 버린다.
"""

import asyncio
import json
import logging
import time

from app.flow import engine
from app.progress import send_progress

log = logging.getLogger(__name__)

NO_ANSWER = "none"
INTENTS = {
    "none": "끼어드는 용건 없음",
    "new_order": "택배를 하나 더(새로) 보내겠다고 함",
    "lookup": "이미 접수한 주문을 조회하려 함",
    "modify": "이미 접수한 주문을 고치려 함",
    "cancel": "이미 접수한 주문을 취소하려 함",
    "quit": "지금 진행 중인 택배 접수를 그만두겠다고(취소하겠다고) 함",
    "handoff": "상담원(사람)과 통화하려 함",
    "help": "보상 판단·결제 오류·계약/정산 등 상담원 처리가 필요한 요청이나 불만. 단순 FAQ·요금표·배송·포장·이용 시간·취소 가능 조건 질문은 제외",
    "stop": "지금 하던 상담원 연결 확인을 그만두겠다고 함",
    "end": "통화를 끝내려 함",
}


# 조회·수정·취소는 보류(app/flow/stages/subflows.py HELD): 처리할 수 없는 요청처럼 상담원 연결을 먼저 제안한다
OFFER_HANDOFF = ("help", "lookup", "modify", "cancel")


def stage_choices(call) -> dict[str, str]:
    stage = engine.current(call)
    return {**(stage.choices(call) if stage.choices else {}), NO_ANSWER: "이 단계의 질문에 대한 답이 없거나 애매함"}


def _schema(choices: dict[str, str]) -> dict:
    return {
        "type": "object",
        "properties": {"answer": {"type": "string", "enum": list(choices)},
                       "intent": {"type": "string", "enum": list(INTENTS)}},
        "required": ["answer", "intent"],
        "additionalProperties": False,
    }


def _prompt(call, choices: dict[str, str], heard: str) -> str:
    agent = next((b["text"] for b in reversed(call.transcript) if b["speaker"] == "agent"), "")
    agent = agent[-call.cfg.listener.max_agent_chars:] if call.cfg.listener.max_agent_chars else ""
    lines = [f"지금 단계: {engine.current(call).description}",
             f"상담원이 방금 한 말: {agent}",
             f"고객이 한 말: {heard}",
             "answer 선택지:", *(f"- {k}: {v}" for k, v in choices.items()),
             "intent 선택지:", *(f"- {k}: {v}" for k, v in INTENTS.items())]
    return "\n".join(lines)


def heard(call, delta: str, conn, client) -> None:
    """고객 받아쓰기 조각. 이번 단계에서 아직 판별하지 않은 말에 이어 붙이고, 말이 멈추면 판별한다."""
    stage = engine.current(call)
    if not stage.listen:
        return
    if call.heard_stage != stage.name:
        call.heard_stage, call.heard_text = stage.name, ""
    call.heard_text = (call.heard_text + delta)[-call.cfg.listener.max_heard_chars:]
    call.heard_at = time.monotonic()
    if call.listen_timer and not call.listen_timer.done():
        call.listen_timer.cancel()
    call.listen_timer = asyncio.create_task(_after_pause(call, conn, client))


async def _after_pause(call, conn, client) -> None:
    await asyncio.sleep(call.cfg.listener.pause_ms / 1000)
    call.listen_seq += 1
    task = asyncio.create_task(classify(call, conn, client, call.listen_seq))  # 이후 말로 취소되지 않게 따로
    call.listen_tasks.add(task)
    task.add_done_callback(call.listen_tasks.discard)


async def classify(call, conn, client, seq: int) -> None:
    cfg = call.cfg.listener
    stage_name, text, heard_at = call.flow.stage, call.heard_text.strip(), call.heard_at
    if not text:
        return
    choices = stage_choices(call)
    record = {"call_id": f"listen-{seq}", "name": "listener", "arguments": text, "status": "running",
              "started": time.time()}
    call.tool_calls[record["call_id"]] = record
    t0 = time.monotonic()
    try:
        resp = await asyncio.wait_for(client.responses.create(
            model=cfg.model,
            instructions=call.texts.classifier,
            input=_prompt(call, choices, text),
            text={"format": {"type": "json_schema", "name": "listener", "strict": True, "schema": _schema(choices)}},
            reasoning={"effort": cfg.reasoning_effort},
            store=False,
        ), cfg.timeout_sec)
        result = json.loads(resp.output_text)
        answer, intent = result["answer"], result["intent"]
        if answer not in choices or intent not in INTENTS:  # 모델 출력은 미신뢰 입력
            raise ValueError(f"선택지 밖 판별: {result}")
    except Exception as e:
        log.warning("판별 실패 %s: %s %s %dms", call.session_id, type(e).__name__, e,
                    (time.monotonic() - t0) * 1000)  # TimeoutError는 메시지가 비어 이름을 같이 남긴다
        record.update(status="error", output={"error": type(e).__name__})
        call.add_error(f"판별 실패: {type(e).__name__}")
        return
    record.update(output={"answer": answer, "intent": intent}, elapsed_ms=round((time.monotonic() - t0) * 1000))
    async with call.lock:
        if seq != call.listen_seq or call.flow.stage != stage_name:
            record["status"] = "stale"  # 그사이 단계가 바뀌었거나 더 새 판별이 있음
            call.notify()
            return
        try:
            events = await apply_answer(call, answer, intent)
        except Exception as e:
            # 예: 접수·저장 중 백엔드 실패. 상태는 그대로 두고 음성 모델에 오류 안내를 준다
            log.exception("답 처리 실패 %s", call.session_id)
            record.update(status="error", output={**record["output"], "error": type(e).__name__})
            call.add_error(f"답 처리 실패: {type(e).__name__}")
            call.answer_failures += 1
            try:
                if call.answer_failures >= 2:  # 다시 확인받아도 또 실패: 상담원 연결을 먼저 제안
                    call.handoff_variant = "offer"
                    await engine.apply(call, ["intent.handoff"], "listener")
                    await send_progress(call, conn)
                else:
                    await conn.session.thinking.append(content=call.texts.answer_error, delegation_id=None)
            except Exception:
                log.exception("오류 안내 전송 실패 %s", call.session_id)
            return
        call.answer_failures = 0
        record["status"] = "done"
        record["output"]["events"] = events
        if events or answer != NO_ANSWER:
            call.heard_text = ""  # 판별에 쓴 말은 소비
        before = call.last_progress
        try:
            await send_progress(call, conn)
        except Exception:
            log.exception("진행 상태 전송 실패 %s", call.session_id)
        # 고객 말이 끝난 뒤(마지막 받아쓰기 조각) 진행 상태를 보낼 때까지. 멈춤 대기(pause_ms) + 판별 + 처리
        record["total_ms"] = round((time.monotonic() - heard_at) * 1000)
        log.info("판별 %s 단계=%s answer=%s intent=%s 모델=%dms 말끝→진행상태=%dms 진행상태변경=%s",
                 call.session_id, stage_name, answer, intent, record["elapsed_ms"], record["total_ms"],
                 call.last_progress != before)
        call.notify()


async def apply_answer(call, answer: str, intent: str) -> list[str]:
    """판별 결과 → 사건 → 단계 전이. 이 단계의 답을 먼저, 끼어드는 용건을 다음에 반영한다
    (예: "네 맞아요, 하나 더 보낼게요" → 접수 후 새 주문)."""
    stage = engine.current(call)
    if not stage.listen:
        return []
    events: list[str] = []
    if answer != NO_ANSWER and stage.on_answer and answer in stage_choices(call):  # 이 단계의 선택지만
        events = await stage.on_answer(call, answer)
        await engine.apply(call, events, "listener")
    if intent != "none" and engine.current(call).listen:  # 답으로 ending에 들어갔으면 용건은 무시
        if intent == "quit":  # 접수하지 않고 끝낸다(통화 결과 CANCELLED)
            call.cancelled = True
        if intent in ("end", "quit"):
            call.request_hangup()
        if intent == "handoff" or intent in OFFER_HANDOFF:  # 처리할 수 없는 요청은 상담원 연결을 먼저 제안
            call.handoff_variant = "offer" if intent in OFFER_HANDOFF else None
        more = ["call.ending" if intent in ("end", "quit")
                else "intent.handoff" if intent in OFFER_HANDOFF else f"intent.{intent}"]
        await engine.apply(call, more, "listener")
        events += more
    return events
