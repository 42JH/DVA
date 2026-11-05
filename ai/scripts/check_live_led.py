"""합성 음성으로 Live 제약 판단/Responses 전달을 확인한다. BE/PBX/RAG는 호출하지 않는다.

명시 실행: python -m scripts.check_live_led --run --output ../output/live-led-check.json
OpenAI Live/TTS 사용료가 발생한다. 키/음성/실제 고객 정보는 결과에 저장하지 않는다.
"""
import argparse
import asyncio
import base64
import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import AsyncOpenAI

from app.config import ROOT
from app.policy.model import load_policy
from app.policy.render import render_live, render_backend
from app.tools import function_specs, MODEL_TOOLS
from app.tools import run_tool
from app.tools.context import ToolContext
from app.domain.state import ConversationState, Customer, Geo, Items


async def probe(client, name: str, utterance: str, expected: int | None) -> dict:
    audio = await client.audio.speech.create(model="gpt-4o-mini-tts", voice="alloy", input=utterance, response_format="pcm")
    pcm = await audio.aread()
    specs = function_specs(tuple(MODEL_TOOLS))
    state = ConversationState(customer=Customer(caller_phone="01000000000"), intent="order")
    for field, value in {"sender_name": "가상발송인", "sender_phone": "01000000000",
                         "sender_address": "서울 강남구 테헤란로 212", "sender_address_detail": "101호",
                         "receiver_name": "가상수령인", "receiver_phone": "01000000001",
                         "receiver_address": "서울 강남구 테헤란로 212", "receiver_address_detail": "102호",
                         "items": Items(small_box_count=1)}.items():
        state.record(field, value)
    state.current.sender_geo = state.current.receiver_geo = Geo("가상 주소", "가상동", "00000")
    ctx = ToolContext("synthetic-live", state, load_policy(), None, live_led=True, last_utterance_id=1)
    instructions = render_live(None, load_policy(), {"고객": "등록 고객", "현재 단계": "물품 가액만 남음"},
                               tuple((t["name"], t["description"]) for t in specs), live_led=True)
    config = {"model": "gpt-live-1", "instructions": instructions,
              "audio": {"format": {"type": "audio/pcm", "rate": 24000}},
              "delegation": {"type": "responses", "responses": {
                  "model": os.environ.get("BACKEND_MODEL", "gpt-6-luna"),
                  "instructions": render_backend(load_policy(), live_led=True), "tools": specs,
                  "parallel_tool_calls": False, "service_tier": "priority", "reasoning": {"effort": "low"}}},
              "input": [{"role": "developer", "content": [{"type": "input_text", "text":
                  "가상 시험입니다. 배송 정보와 소형 박스 한 개는 이미 받았습니다. 물품 가액만 질문하고 있습니다. "
                  "인사나 처음부터 질문하지 말고 뒤에 들리는 고객의 가액에 응답하세요. "
                  '[통화 상태] {"utterance_id":1,"stage":"item","missing":["item_price"]}'}]},
                  {"role": "assistant", "content": [{"type": "output_text", "text": "물건 가격은 얼마인가요?"}]}]}
    result = {"case": name, "tools": [], "speech": "", "customer_transcript": "", "errors": []}
    async with client.live.connect(max_retries=0) as conn:
        await conn.session.start(session=config)
        while True:
            ev = json.loads(await asyncio.wait_for(conn.recv_bytes(), 15))
            if ev["type"] == "error":
                result["errors"].append(ev.get("error", {}).get("code", "unknown"))
                return result | {"passed": False}
            if ev["type"] == "session.started":
                break

        async def feed():
            # 실제 시간 속도로 PCM을 공급한다. 마지막 무음은 발화 끝 인식용이다.
            data = pcm + b"\x00" * 57600
            for start in range(0, len(data), 4800):
                await conn.session.input_audio.append(audio=base64.b64encode(data[start:start+4800]).decode())
                await asyncio.sleep(.1)

        feeder = asyncio.create_task(feed())
        deadline, last_speech, outputs, inflight = time.monotonic()+28, 0, 0, 0
        try:
            while time.monotonic() < deadline:
                try:
                    ev = json.loads(await asyncio.wait_for(conn.recv_bytes(), .5))
                except TimeoutError:
                    if feeder.done() and last_speech and time.monotonic()-last_speech > 2.0 and not inflight:
                        break
                    continue
                kind = ev["type"]
                if kind == "session.input_transcript.delta":
                    result["customer_transcript"] += ev.get("delta", "")
                elif kind == "session.output_transcript.delta":
                    result["speech"] += ev.get("delta", "")
                    last_speech = time.monotonic()
                elif kind == "error":
                    result["errors"].append(ev.get("error", {}).get("code", "unknown"))
                elif kind == "response.event":
                    inner = ev.get("event", {})
                    if inner.get("type") == "response.output_item.done" and inner.get("item", {}).get("type") == "function_call":
                        item = inner["item"]
                        args = json.loads(item.get("arguments") or "{}")
                        tool = item["name"]
                        result["tools"].append({"name": tool, "arguments": args})
                        if tool in ("get_state", "record_fields"):
                            output = await run_tool(ctx, tool, json.dumps(args, ensure_ascii=False), item["call_id"],
                                                    allowed=("get_state", "record_fields"))
                        else:
                            output = {"status": "rejected", "code": "SYNTHETIC_TEST_NO_ACTION"}
                        await conn.response.item.create(item={"type": "function_call_output", "call_id": item["call_id"],
                                                             "output": json.dumps(output, ensure_ascii=False)})
                        outputs += 1
                    elif inner.get("type") == "response.completed" and outputs:
                        outputs = 0
                        await conn.response.create()
            records = [x for x in result["tools"] if x["name"] == "record_fields"]
            result["passed"] = not result["errors"] and bool(result["speech"]) and (
                not result["tools"] if expected is None else state.current["item_price"].value == expected)
        finally:
            feeder.cancel()
            await asyncio.gather(feeder, return_exceptions=True)
            await conn.session.close()
    return result


async def main(args):
    load_dotenv(ROOT / ".env", override=False)
    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY가 없어 실제 세션 검증을 실행하지 않았습니다.")
    client = AsyncOpenAI(timeout=20, max_retries=0)
    results = []
    try:
        if args.acceptance_only:
            try:
                result = await asyncio.wait_for(probe_acceptance(client), 55)
            except Exception as error:
                result = dict(getattr(probe_acceptance, "last_report", {})) | {
                    "case": "early_acceptance", "passed": False, "error_type": type(error).__name__}
                state = getattr(probe_acceptance, "last_state", None)
                result["confirmed_parcels"] = len(state.parcels) if state else 0
            results.append(result)
            print(json.dumps({k: result[k] for k in ("case", "passed")}, ensure_ascii=False), flush=True)
        for name, utterance, expected in ([] if args.acceptance_only else [("price_rejected", "물건 가격은 이억 원이에요.", None),
                                           ("price_recorded", "물건 가격은 삼만 원이에요.", 30000)]):
            try:
                result = await asyncio.wait_for(probe(client, name, utterance, expected), 55)
            except Exception as error:
                # 응답 원문에는 계정 정보가 포함될 수 있어 예외 종류만 출력한다.
                result = {"case": name, "passed": False, "error_type": type(error).__name__}
            results.append(result)
            print(json.dumps({k: result[k] for k in ("case", "passed")}, ensure_ascii=False), flush=True)
    finally:
        await client.close()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(str(output), flush=True)
    return all(x["passed"] for x in results)


async def probe_acceptance(client) -> dict:
    """실제 LiveFlow에 합성 고객 발화를 전달해 중간 수락→확인본 담기를 검증."""
    from app.calls.service import CallService, CallDeps
    from app.calls.live import LiveFlow
    from app.calls.session import CallSession, Phase
    from app.config import CallConfig
    from app.domain.preparation import prepare_confirmation
    from app.integrations.backend.gateway import BackendGateway
    from backend_client.mock import MockBackend
    policy = load_policy()
    gw = BackendGateway(MockBackend())
    svc = CallService(CallDeps(client, gw, policy, CallConfig(live_led=True),
                              os.environ.get("BACKEND_MODEL", "gpt-6-luna")))
    flow = LiveFlow(svc)
    state = ConversationState(customer=Customer(caller_phone="01000000000"), intent="order")
    for field, value in {"sender_name": "가상발송인", "sender_phone": "01000000000",
                         "sender_address": "서울 강남구 테헤란로 212", "sender_address_detail": "101호",
                         "receiver_name": "가상수령인", "receiver_phone": "01000000001",
                         "receiver_address": "서울 강남구 테헤란로 212", "receiver_address_detail": "102호",
                         "items": Items(small_box_count=1), "item_price": 30000}.items():
        state.record(field, value)
    state.current.sender_geo = state.current.receiver_geo = Geo("가상 주소", "가상동", "00000")
    ctx = ToolContext("synthetic-accept", state, policy, gw, live_led=True)
    session = CallSession("synthetic-accept", "synthetic", "01000000000", "2026-11-05T00:00:00Z", ctx,
                          phase=Phase.ACTIVE)
    ctx.control = lambda data: flow.control(session, data)
    flow.rt(session).intent_started = True
    config = svc.session_config(session, None)
    config.pop("type", None)
    config["audio"] = {"format": {"type": "audio/pcm", "rate": 24000}}
    config["input"] = [{"role": "developer", "content": [{"type": "input_text", "text":
        "가상 통화입니다. 고객의 접수 정보를 모두 기록했고 서버가 확인할 내용을 곧 제공합니다. 인사하지 말고 그 내용을 바로 읽어주세요."}]}]
    audio = await client.audio.speech.create(model="gpt-4o-mini-tts", voice="alloy", response_format="pcm",
                                           input="예, 충분히 알겠으니까 그대로 진행해 주시면 돼요.")
    pcm = await audio.aread()
    report = {"case": "early_acceptance", "speech": "", "customer_transcript": "", "actions": [], "codes": []}
    probe_acceptance.last_report = report
    probe_acceptance.last_state = state
    feeder = None
    async with client.live.connect(max_retries=0) as conn:
        session.sideband = conn
        await conn.session.start(session=config)
        while True:
            ev = json.loads(await asyncio.wait_for(conn.recv_bytes(), 15))
            if ev["type"] == "error":
                return report | {"passed": False, "error_code": ev.get("error", {}).get("code")}
            if ev["type"] == "session.started":
                break
        start_customer = asyncio.Event()
        async def feed():
            # 기본 WS에서도 음성 시계를 진행시켜 context injection이 실제 추론에 도달하게 한다.
            while not start_customer.is_set():
                await conn.session.input_audio.append(audio=base64.b64encode(b"\x00"*4800).decode())
                await asyncio.sleep(.1)
            await asyncio.sleep(.3)
            data = pcm + b"\x00"*57600
            for start in range(0, len(data), 4800):
                await conn.session.input_audio.append(audio=base64.b64encode(data[start:start+4800]).decode())
                await asyncio.sleep(.1)
            while True:
                await conn.session.input_audio.append(audio=base64.b64encode(b"\x00"*4800).decode())
                await asyncio.sleep(.1)

        feeder = asyncio.create_task(feed())
        facts = prepare_confirmation(ctx)
        await flow.notify(session, "N2", facts)

        deadline = time.monotonic()+35
        try:
            while time.monotonic() < deadline and not state.parcels:
                try:
                    ev = json.loads(await asyncio.wait_for(conn.recv_bytes(), .5))
                except TimeoutError:
                    continue
                kind = ev["type"]
                if kind == "session.output_transcript.delta":
                    report["speech"] += ev.get("delta", "")
                    svc.handlers[kind](session, ev)
                    start_customer.set()
                elif kind == "session.input_transcript.delta":
                    report["customer_transcript"] += ev.get("delta", "")
                    svc.handlers[kind](session, ev)
                elif kind == "response.event":
                    inner = ev.get("event", {})
                    item = inner.get("item", {})
                    if inner.get("type") == "response.output_item.done" and item.get("type") == "function_call":
                        report["actions"].append({"name": item.get("name"), "arguments": json.loads(item.get("arguments") or "{}")})
                    svc.handlers[kind](session, ev)
                elif kind == "session.delegation.created":
                    svc.handlers[kind](session, ev)
                elif kind == "error":
                    report["codes"].append(ev.get("error", {}).get("code"))
                elif kind == "session.closed":
                    report["closed_reason"] = ev.get("reason")
                    break
            report["tool_outcomes"] = [{"name": t["name"], "status": t["status"]} for t in session.tool_calls]
            report["passed"] = len(state.parcels) == 1 and not report["codes"]
        finally:
            if feeder:
                feeder.cancel()
                await asyncio.gather(feeder, return_exceptions=True)
            flow.rt(session).cancel()
            for task in list(session.tasks):
                task.cancel()
            await asyncio.gather(*list(session.tasks), return_exceptions=True)
            try:
                await conn.session.close()
            except Exception as error:
                # 끝난 연결의 정상 close 예외가 이미 관측한 실행 결과를 덮지 않게 한다.
                report["close_error_type"] = type(error).__name__
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--acceptance-only", action="store_true")
    parser.add_argument("--output", default="../output/live-led-check.json")
    options = parser.parse_args()
    if not options.run:
        parser.error("실제 API를 사용하므로 --run을 명시해야 합니다")
    raise SystemExit(0 if asyncio.run(main(options)) else 1)
