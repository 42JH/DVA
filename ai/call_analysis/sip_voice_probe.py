"""Isolated GPT-Live SIP experiment. Run from ai/ with a dedicated test webhook."""

import argparse
import asyncio
import base64
import json
import os
import time
import wave
from pathlib import Path
from uuid import uuid4

import uvicorn
from fastapi import FastAPI
from openai import AsyncOpenAI

from pbx_webhook.incoming import IncomingCall, create_incoming_router, hangup_quietly
from pbx_webhook.sip import normalize_caller

WEBHOOK_PATH = "/lab/webhooks/openai/sip-voice"
INSTRUCTIONS = (
    "한국어로 말하는 음성 실험이다. 먼저 인사하지 말고 기다린다. 고객이 입력한 가상 배송 정보는 "
    "클라이언트에 위임한다. 이미 기록했다고 말하지 않는다. 서버의 commentary가 오기 전에는 "
    "질문하거나 접수를 진행하지 않는다. commentary가 오면 그 안내만 말하고 기다린다. "
    "고객이 끼어들면 말하던 안내를 멈추고 듣는다."
)
QUESTION = "받는 분 성함을 알려 주세요."
LONG_NOTICE = (
    "첫 번째 시험 단계입니다. 두 번째 단계에서는 잠시 기다립니다. "
    "세 번째 단계는 이어서 듣습니다. 네 번째 단계가 마지막입니다."
)


def session_config() -> dict:
    return {"model": "gpt-live-1", "instructions": INSTRUCTIONS, "delegation": {"type": "client"}}


def fixture_audio(path: Path) -> str:
    with wave.open(str(path), "rb") as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, 24000):
            raise ValueError("fixture must be a 24 kHz mono PCM16 WAV")
        if not 0 < source.getnframes() <= 30 * 24000:
            raise ValueError("fixture duration must be greater than zero and at most 30 seconds")
        audio = source.readframes(source.getnframes())
        if len(audio) != source.getnframes() * 2:
            raise ValueError("fixture WAV is truncated")
    return base64.b64encode(audio).decode("ascii")


async def observe(conn, fixture: str | None) -> None:
    started = time.monotonic()
    run_id = uuid4().hex[:8]
    command = 0
    seen_delegations: set[str] = set()
    reply_to_next_delegation = False
    last_audio_report: dict[str, int] = {}

    def report(event: str, **details) -> None:
        print(json.dumps({"run": run_id, "elapsed_ms": round((time.monotonic() - started) * 1000),
                          "event": event, **details}, ensure_ascii=False), flush=True)

    async def send(event: str, **fields) -> None:
        nonlocal command
        command += 1
        event_id = f"{run_id}-{command}"
        report("send", type=event, event_id=event_id, delegation_id=fields.get("delegation_id"))
        await conn.send({"type": event, "event_id": event_id, **fields})

    async def append(kind: str, content: str, delegation_id: str | None = None) -> None:
        await send(f"session.{kind}.append", content=content, delegation_id=delegation_id)

    while True:
        event = json.loads(await conn.recv_bytes())
        kind = event.get("type", "")
        if kind in ("session.input_audio.append", "session.output_audio.delta"):
            end = event.get("end_ms")
            if isinstance(end, int) and end - last_audio_report.get(kind, -500) >= 500:
                report(kind, start_ms=event.get("start_ms"), end_ms=end)
                last_audio_report[kind] = end
        elif kind in ("session.input_transcript.delta", "session.output_transcript.delta"):
            report(kind, start_ms=event.get("start_ms"), end_ms=event.get("end_ms"), text=event.get("delta"))
        elif kind == "session.delegation.created":
            delegation = event["delegation"]
            did = delegation["id"]
            if delegation["target"] != "client" or did in seen_delegations:
                continue
            seen_delegations.add(did)
            report(kind, delegation_id=did, offset_ms=event.get("offset_ms"))
            if reply_to_next_delegation:
                reply_to_next_delegation = False
                await append("commentary", QUESTION, did)
            else:
                await append("thinking", "", did)
        elif kind == "transport.dtmf.received":
            key = event.get("event")
            report(kind, key=key)
            if key == "1":
                await append("commentary", QUESTION)
            elif key == "2":
                await append("commentary", LONG_NOTICE)
            elif key == "3":
                await append("instructions", "지금 말하던 안내를 즉시 멈추고 다음 서버 안내를 기다린다.")
            elif key == "4":
                reply_to_next_delegation = True
            elif key == "5" and fixture:
                await send("session.output_audio.fixture.play", audio=fixture)
        elif kind == "error":
            error = event.get("error") or {}
            report(kind, code=error.get("code"), client_event_id=error.get("client_event_id"))
        elif kind.startswith("session.output_audio.fixture.") or kind.endswith(".appended") or kind in (
                "session.started", "session.closed", "transport.answered", "transport.failed"):
            report(kind, client_event_id=event.get("client_event_id"),
                   start_ms=event.get("start_ms"), end_ms=event.get("end_ms"))
            if kind in ("session.closed", "transport.failed"):
                return


def create_probe(client: AsyncOpenAI, caller: str, fixture: str | None) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    active: str | None = None

    async def incoming(call: IncomingCall) -> None:
        nonlocal active
        if call.caller != caller or active is not None:
            return
        active = call.session_id
        accepted = False
        try:
            async with asyncio.timeout(90):
                await client.live.sessions.accept(call.session_id, session=session_config())
                accepted = True
                async with client.live.sideband.connect(session_id=call.session_id) as conn:
                    await observe(conn, fixture)
        finally:
            try:
                if accepted:
                    async with asyncio.timeout(5):
                        await hangup_quietly(client, call.session_id)
            finally:
                active = None

    app.include_router(create_incoming_router(client, incoming, path=WEBHOOK_PATH))
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--fixture", type=Path, help="Optional WAV for key 5")
    args = parser.parse_args()
    caller = normalize_caller(os.getenv("SIP_PROBE_CALLER", ""))
    if not caller or not os.getenv("OPENAI_API_KEY") or not os.getenv("OPENAI_WEBHOOK_SECRET"):
        parser.error("Set SIP_PROBE_CALLER, OPENAI_API_KEY and OPENAI_WEBHOOK_SECRET for the test route.")
    client = AsyncOpenAI(timeout=10, max_retries=0)
    uvicorn.run(create_probe(client, caller, fixture_audio(args.fixture) if args.fixture else None),
                host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
