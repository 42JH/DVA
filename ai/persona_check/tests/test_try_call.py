"""시험 실행기가 운영 통화 코드와 여전히 맞물리는지(통화 없음, OpenAI 안 부름).
실행기는 app/ 내부(CallService · LiveFlow · ResultService · MockBackend)를 불러다 쓴다. 그쪽이 바뀌어 조립이 깨지면 여기서 드러난다."""

import asyncio
from types import SimpleNamespace

import pytest

from backend_client.mock import MockBackend
from persona_check import customer, judge, try_call

NOW = "2026-11-11T14:00:00Z"


def assemble(scenario_id: str, workdir, prompt: str | None = None):
    scenario = judge.load_scenario(scenario_id)
    fake_openai = SimpleNamespace(live=SimpleNamespace(sessions=SimpleNamespace(), sideband=SimpleNamespace()))  # 아무것도 부르면 안 된다
    client, captured = try_call.intercept(fake_openai)
    mock = MockBackend()
    if prompt:
        mock.use_prompt(prompt)
    try_call.seed(mock, scenario)
    calls, address = try_call.build(client, mock, workdir)

    async def go():
        config = await try_call.capture(calls, captured, scenario["caller"], NOW)
        await calls.results.drain()
        await address.close()
        return config

    return asyncio.run(go()), mock


def test_runner_gets_the_production_session_config_for_a_new_customer(tmp_path):
    config, mock = assemble("A1", tmp_path, prompt="# 페르소나\n시험용 말투로 말합니다.")
    assert config["model"] == "gpt-live-1" and "type" not in config
    assert config["instructions"].startswith("# 페르소나\n시험용 말투로 말합니다.")  # 후보 페르소나가 지시문 맨 앞에
    assert "업무 규칙" in config["instructions"] and "처음 이용하는 고객" in config["instructions"]
    assert config["delegation"]["type"] == "responses" and config["delegation"]["responses"]["tools"]
    assert not mock.customers and not mock.orders and not mock.drafts            # 설정을 가로채는 통화는 아무것도 남기지 않는다


def test_registered_customer_scenario_seeds_the_fake_backend_and_reaches_the_instructions(tmp_path):
    config, mock = assemble("A2", tmp_path)
    who = judge.load_scenario("A2")
    assert "등록 고객" in config["instructions"] and who["customer"]["name"] in config["instructions"]
    assert who["customer"]["address"] in config["instructions"]                  # 심어 둔 기본 발송 주소가 인사에 쓰인다
    assert [p.name for p in mock.pins[who["caller"]]] == ["이지은", "김영희", "김영수"]
    assert [(o["status"], o["parcels"][0]["destination"]["name"]) for o in mock.orders] == \
        [("COLLECTING", "이지은"), ("PAID", "박서준"), ("CANCELLED", "최유리")]


def test_every_scenario_is_runnable_and_judgeable():
    scenarios = judge.load_scenarios()
    assert len({s["id"] for s in scenarios}) == len(scenarios) >= 9 and any(s.get("core") for s in scenarios)
    for s in scenarios:
        assert s["caller"] and s["lines"] and s["name"] and s["group"], s["id"]
        assert any(not line.get("optional") for line in s["lines"]), s["id"]      # 필수 발화가 하나는 있어야 진행을 판정한다
        for line in s["lines"]:  # TTS에 숫자가 그대로 가면 영어로 읽힌다(11/11 통화)
            assert not any(ch.isdigit() for ch in line.get("say") or customer.spoken(line["text"])), (s["id"], line)
        assert judge.judge(s, {"received": {}})["checks"], s["id"]               # 정답이 판정기가 읽는 모양


def test_sideband_gets_session_started_first_and_only_once():
    # WebRTC 세션은 sideband가 붙기 전에 시작돼 session.started를 놓칠 수 있다 → 데이터 채널로 받은 것을 맨 앞에 넣는다
    real = b'{"event_id":"e2","type":"session.started","session":{"id":"live_x"}}'
    feed = [b'{"type":"session.delegation.created"}', real, b'{"type":"session.closed"}']

    class Conn:
        async def recv_bytes(self):
            return feed.pop(0)

    class Manager:
        async def __aenter__(self):
            return Conn()

        async def __aexit__(self, *exc):
            return False

    captured_started = b'{"event_id":"e1","type":"session.started","session":{"id":"live_x","expires_at":1}}'

    async def go():
        async with try_call.Sideband(Manager(), captured_started) as conn:
            return [await conn.recv_bytes() for _ in range(3)]

    got = asyncio.run(go())
    assert got == [captured_started, b'{"type":"session.delegation.created"}', b'{"type":"session.closed"}']


def test_recording_mixes_customer_and_ai_into_one_channel(tmp_path):
    pytest.importorskip("aiortc")   # 통화용 라이브러리가 없는 곳(CI)에서는 건너뛴다
    np = pytest.importorskip("numpy")
    import wave
    mic = try_call.CustomerTrack()
    mic.t0 = 100.0
    mic.sent.extend(np.full(24000, 1000, dtype=np.int16).tobytes())                 # 고객 1초
    ai = [(100.5, np.full(12000, 2000, dtype=np.int16)), (100.6, np.full(12000, 32000, dtype=np.int16))]  # 둘째는 앞 조각 뒤에 붙는다
    try_call.save_wav(tmp_path / "call.wav", mic, ai)
    with wave.open(str(tmp_path / "call.wav")) as f:
        assert (f.getnchannels(), f.getframerate()) == (1, 24000)
        got = np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16)
    assert len(got) == 36000 and got[0] == 1000 and got[12000] == 3000 and got[30000] == 32000   # 겹친 구간은 더한다


def test_fake_geo_names_the_district_and_the_key_is_required(monkeypatch):
    assert try_call.fake_geo("부산광역시 해운대구 센텀중앙로 칠십구").dong_name == "해운대구"
    assert try_call.fake_geo("어딘가 길").dong_name == "시험동" and try_call.fake_geo("") is None
    monkeypatch.delenv("PERSONA_CHECK_OPENAI_API_KEY", raising=False)
    with pytest.raises(RuntimeError):
        try_call.api_key()                                                       # 운영 키(OPENAI_API_KEY)를 대신 쓰지 않는다
