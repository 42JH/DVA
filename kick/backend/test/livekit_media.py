"""Verify remote STT and muted TTS delivery between two Kick accounts."""

import argparse
import asyncio
import json
import wave
from pathlib import Path
from urllib.request import Request, urlopen
from uuid import uuid4

from livekit import rtc
from vosk import KaldiRecognizer, Model, SetLogLevel

TOPIC = "kick-speech"
PCM_TOPIC = "kick-speech-pcm"
RATE = 16000
FRAME_SAMPLES = 320
FIRST = "kick-test-1"
SECOND = "kick-test-2"


def request(base, token, path, method="GET", body=None):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    data = None if body is None else json.dumps(body).encode()
    with urlopen(Request(base + "/api" + path, data, headers, method=method), timeout=5) as response:
        return json.load(response)


async def verify_track(room, peer, sample, model, expected, muted=None):
    loop = asyncio.get_running_loop()
    track_subscribed = loop.create_future()
    track_muted = loop.create_future()

    source = rtc.AudioSource(RATE, 1)
    track = rtc.LocalAudioTrack.create_audio_track("test-microphone", source)
    publication = None
    stream = None

    def is_peer_mic(publication, participant):
        return (
            participant.identity == room.local_participant.identity
            and publication.source == rtc.TrackSource.SOURCE_MICROPHONE
        )

    @peer.on("track_subscribed")
    def on_track(remote, publication, participant):
        if not track_subscribed.done() and is_peer_mic(publication, participant):
            track_subscribed.set_result(remote)

    @peer.on("track_muted")
    def on_mute(participant, publication):
        if not track_muted.done() and is_peer_mic(publication, participant):
            track_muted.set_result(True)

    async def publish():
        frame_bytes = FRAME_SAMPLES * 2
        for start in range(0, len(sample), frame_bytes):
            pcm = sample[start:start + frame_bytes].ljust(frame_bytes, b"\0")
            await source.capture_frame(rtc.AudioFrame(pcm, RATE, 1, FRAME_SAMPLES))

    async def transcribe():
        recognizer = KaldiRecognizer(model, RATE)
        words = []
        async for event in stream:
            if recognizer.AcceptWaveform(bytes(event.frame.data)):
                words.append(json.loads(recognizer.Result())["text"])
                if expected in " ".join(words):
                    return " ".join(words)

    try:
        options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        publication = await room.local_participant.publish_track(track, options)
        remote = await track_subscribed
        stream = rtc.AudioStream.from_track(track=remote, sample_rate=RATE, num_channels=1)
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(publish())
            transcript = tasks.create_task(transcribe())
        print(f"{room.local_participant.identity} → {peer.local_participant.identity} remote audio STT: {transcript.result()}")
        if muted:
            track.mute()
            await track_muted
            await muted()
    finally:
        peer.off("track_subscribed", on_track)
        peer.off("track_muted", on_mute)
        if stream is not None:
            await stream.aclose()
        if publication is not None:
            await room.local_participant.unpublish_track(publication.sid)
        await source.aclose()


async def verify(args, tokens, model):
    with wave.open(str(args.wav)) as recording:
        assert (recording.getframerate(), recording.getnchannels(), recording.getsampwidth()) == (RATE, 1, 2)
        # Silence lets the recognizer emit the final sentence at the end of the sample.
        sample = recording.readframes(recording.getnframes()) + bytes(RATE * 2)
    mime = "audio/pcm" if args.pcm_text else "audio/mpeg"

    first, second = (rtc.Room(), rtc.Room())
    received = asyncio.get_running_loop().create_future()
    first_chunk = asyncio.Event()
    receivers = set()
    call_id = None
    accepted = False

    async def receive(reader, identity):
        try:
            assert identity == FIRST and reader.info.mime_type == mime
            chunks = []
            async for chunk in reader:
                chunks.append(chunk)
                first_chunk.set()
            if not received.done():
                received.set_result(b"".join(chunks))
        except Exception as error:
            first_chunk.set()
            if not received.done():
                received.set_exception(error)

    def handle_bytes(reader, identity):
        task = asyncio.create_task(receive(reader, identity))
        receivers.add(task)
        task.add_done_callback(receivers.discard)

    async def send_while_muted():
        if args.pcm_text:
            payload, count = await relay_pcm(
                args.base, tokens[0], args.pcm_text, first.local_participant, first_chunk,
            )
            assert await received == payload
            print(f"Microphone muted at peer; {count} PCM writes ({len(payload)} bytes) received intact")
            return
        mp3 = args.mp3.read_bytes()
        assert mp3.startswith(b"ID3") or (len(mp3) >= 2 and mp3[0] == 0xFF and mp3[1] & 0xE0 == 0xE0)
        await first.local_participant.send_bytes(
            mp3, topic=TOPIC, mime_type=mime, destination_identities=[SECOND],
        )
        assert await received == mp3
        print("Microphone muted at peer; targeted synthesized MP3 received intact")

    try:
        result = request(args.base, tokens[0], "/calls", "POST", {
            "calleeId": SECOND, "requestId": str(uuid4()),
        })
        call_id = result["id"]
        assert request(args.base, tokens[1], "/calls/active")["call"]["id"] == call_id
        request(args.base, tokens[1], f"/calls/{call_id}", "PATCH", {"action": "accept"})
        accepted = True
        second.register_byte_stream_handler(PCM_TOPIC if args.pcm_text else TOPIC, handle_bytes)
        for room, token, identity in zip((first, second), tokens, (FIRST, SECOND)):
            credentials = request(args.base, token, f"/calls/{call_id}/join", "POST")
            await room.connect(credentials["url"], credentials["token"])
            assert room.local_participant.identity == identity
        print("Two Kick accounts connected to the same local LiveKit room", flush=True)
        await verify_track(first, second, sample, model, args.expected, send_while_muted)
        await verify_track(second, first, sample, model, args.expected)
    finally:
        try:
            await asyncio.gather(first.disconnect(), second.disconnect())
        finally:
            for receiver in receivers.copy():
                receiver.cancel()
            if call_id:
                action = "end" if accepted else "cancel"
                request(args.base, tokens[0], f"/calls/{call_id}", "PATCH", {"action": action})


async def relay_pcm(base, token, text, participant, first_chunk):
    req = Request(
        base + "/api/voice/speech/stream",
        json.dumps({"text": text}).encode(),
        {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    response = await asyncio.to_thread(urlopen, req, timeout=10)
    with response:
        assert response.headers.get_content_type() == "audio/pcm"
        writer = await participant.stream_bytes(
            name="speech.pcm", topic=PCM_TOPIC, mime_type="audio/pcm",
            destination_identities=[SECOND],
        )
        payload = bytearray()
        writes = 0
        try:
            while chunk := await asyncio.to_thread(response.read1, FRAME_SAMPLES * 2):
                payload.extend(chunk)
                await writer.write(chunk)
                writes += 1
                if writes == 1:
                    await asyncio.wait_for(first_chunk.wait(), timeout=5)
            assert writes > 1 and len(payload) % 2 == 0
        except BaseException:
            await writer.aclose(reason="PCM relay failed")
            raise
        await writer.aclose()
    return payload, writes


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:3010")
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--wav", type=Path, required=True)
    tts = parser.add_mutually_exclusive_group(required=True)
    tts.add_argument("--mp3", type=Path)
    tts.add_argument("--pcm-text", help="Fetch live PCM using the first account's registered voice")
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--expected", required=True, help="Expected phrase in the remote STT output")
    args = parser.parse_args()
    values = dict(
        line.split("=", 1) for line in args.env_file.read_text(encoding="utf-8-sig").splitlines()
        if line.startswith("KICK_TEST_ACCOUNT_") and "=" in line
    )
    SetLogLevel(-1)
    model = Model(str(args.model))
    asyncio.run(asyncio.wait_for(verify(
        args, (values["KICK_TEST_ACCOUNT_1_TOKEN"], values["KICK_TEST_ACCOUNT_2_TOKEN"]), model,
    ), timeout=45))
