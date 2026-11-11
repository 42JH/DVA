import asyncio
import base64
import json
import wave

import pytest

from call_analysis.sip_voice_probe import QUESTION, fixture_audio, observe


def test_probe_sends_matched_client_reply_and_separate_session_commentary(capsys):
    delegation = {"type": "session.delegation.created", "delegation": {"id": "d1", "target": "client"}}
    events = [
        delegation,
        {"type": "transport.dtmf.received", "event": "4"},
        delegation,
        {"type": "session.delegation.created", "delegation": {"id": "d2", "target": "client"}},
        {"type": "transport.dtmf.received", "event": "1"},
        {"type": "transport.dtmf.received", "event": "5"},
        {"type": "session.output_audio.delta", "start_ms": 40, "end_ms": 60, "delta": "private-audio"},
        {"type": "session.closed"},
    ]

    class Connection:
        sent = []

        async def recv_bytes(self):
            return json.dumps(events.pop(0)).encode()

        async def send(self, event):
            self.sent.append(event)

    conn = Connection()
    asyncio.run(observe(conn, "fixture-payload"))

    quiet, matched, general, fixture = conn.sent
    assert quiet["type"] == "session.thinking.append" and quiet["delegation_id"] == "d1" and quiet["content"] == ""
    assert matched["type"] == general["type"] == "session.commentary.append"
    assert matched["delegation_id"] == "d2" and general["delegation_id"] is None
    assert matched["content"] == general["content"] == QUESTION
    assert fixture["type"] == "session.output_audio.fixture.play" and fixture["audio"] == "fixture-payload"
    assert len({event["event_id"] for event in conn.sent}) == 4
    output = capsys.readouterr().out
    assert '"end_ms": 60' in output
    assert "private-audio" not in output and "fixture-payload" not in output


@pytest.mark.parametrize("rate", [24000, 8000])
def test_fixture_audio_accepts_only_supported_wav_format(tmp_path, rate):
    path = tmp_path / "fixture.wav"
    samples = bytes(range(16))
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        out.writeframes(samples)
    if rate == 24000:
        assert base64.b64decode(fixture_audio(path)) == samples
    else:
        with pytest.raises(ValueError, match="24 kHz"):
            fixture_audio(path)
