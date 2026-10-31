"""테스트 공용: 실제 OpenAI·PBX·DB를 부르지 않는다(가짜 백엔드 app/mock_backend.py, 가짜 클라이언트, 서명한 가짜 웹훅)."""

import asyncio
import base64
import hashlib
import hmac
import json
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from openai import AsyncOpenAI

from app import address
from app.address import kakao
from app.call import Call
from app.config import FareConfig, load_server_config, load_texts
from app.main import check_definitions
from app.mock_backend import MockBackend
from app.order import Geo

# 테스트용 요금표(실제 값은 운영이 정해 config/server.toml [fare]에 넣는다. 비어 있으면 접수는 미완료로 넘어간다)
FARE = FareConfig(document=3000, small_box=4000, medium_box=5000, big_box=6000)
CFG = load_server_config().model_copy(update={"fare": FARE})
TEXTS = load_texts()
check_definitions(CFG, TEXTS)

WEBHOOK_SECRET = "whsec_" + base64.b64encode(b"test-secret").decode()
CALLER = "01012345678"
INCOMING_AT = "2026-10-28T01:00:00Z"
# 수거 희망 시각(미래). 기록하면 한국 시간으로 바뀐다
PICKUP_AT = (datetime.now(timezone(timedelta(hours=9))) + timedelta(days=1)).replace(
    hour=10, minute=0, second=0, microsecond=0).isoformat()

# 택배 하나 + 수거 시각을 한 번에 말한 record_order 인수. 결제 방식은 고객 답(credit)으로 따로 받는다
FULL_ORDER = {
    "sender_name": "김철수", "sender_phone": "공일공 일이삼사 오육칠팔", "sender_address": "서울 강남구 테헤란로 212",
    "sender_address_detail": "1201호", "receiver_name": "이영희", "receiver_phone": "010-9876-5432",
    "receiver_address": "부산 해운대구 센텀로 10", "receiver_address_detail": "", "small_box_count": 1,
    "item_price": 30000, "pickup_at": PICKUP_AT,
}
GEO = Geo(jibun_address="서울 강남구 역삼동 737", dong_name="역삼동", postal_code="06236", latitude=37.5,
          longitude=127.03)


@pytest.fixture(autouse=True)
def no_address_db(monkeypatch):
    """개발 PC에 data/address.db가 있어도 테스트는 주소 보정 없이 돈다(보정 테스트는 test_address.py가 작은 DB로)."""
    monkeypatch.setattr(address, "_db", None)
    monkeypatch.setattr(address, "load", lambda path: False)


@pytest.fixture(autouse=True)
def fake_kakao(monkeypatch):
    """카카오 주소 검색을 부르지 않는다. 확정한 주소마다 같은 지번·좌표를 돌려준다(못 찾음은 테스트가 바꾼다)."""
    async def geocode(address_, timeout_sec, transport=None):
        return GEO if address_ else None

    monkeypatch.setattr(kakao, "geocode", geocode)


def run(coro):
    return asyncio.run(coro)


FakeBackend = MockBackend


def make_call(backend=None, caller=CALLER, session_id="live_test") -> Call:
    call = Call(session_id, caller, CFG, TEXTS, backend or FakeBackend(), INCOMING_AT)
    run(call.prepare())
    return call


# --- 가짜 OpenAI 클라이언트 ---


class FakeSessions:
    def __init__(self):
        self.calls: list[tuple] = []
        self.accept_error: Exception | None = None
        self.accept_delay = 0.0
        self.hangup_error: Exception | None = None
        self.refer_error: Exception | None = None

    async def accept(self, session_id, *, session):
        await asyncio.sleep(self.accept_delay)
        self.calls.append(("accept", session_id, session))
        if self.accept_error:
            raise self.accept_error

    async def reject(self, session_id, *, status_code):
        self.calls.append(("reject", session_id, status_code))

    async def hangup(self, session_id):
        self.calls.append(("hangup", session_id))
        if self.hangup_error:
            raise self.hangup_error

    async def refer(self, session_id, *, target_uri):
        self.calls.append(("refer", session_id, target_uri))
        if self.refer_error:
            raise self.refer_error

    def of(self, kind):
        return [c for c in self.calls if c[0] == kind]


class _Recorder:
    def __init__(self, sent, path):
        self._sent, self._path = sent, path

    def __getattr__(self, name):
        return _Recorder(self._sent, f"{self._path}.{name}")

    async def __call__(self, **kwargs):
        self._sent.append((self._path, kwargs))


class FakeConn:
    """sideband 연결. 테스트가 push로 이벤트를 넣고, 서버가 보낸 것은 sent에 쌓인다."""

    def __init__(self):
        self.queue: asyncio.Queue = asyncio.Queue()
        self.sent: list[tuple[str, dict]] = []
        self.session = _Recorder(self.sent, "session")
        self.response = _Recorder(self.sent, "response")

    def push(self, type_, **fields):
        self.queue.put_nowait(SimpleNamespace(type=type_, **fields))

    def function_call(self, name, args, call_id):
        self.push("response.event", event={"type": "response.output_item.done", "item": {
            "type": "function_call", "name": name, "arguments": json.dumps(args, ensure_ascii=False),
            "call_id": call_id}})

    def outputs(self):
        return [json.loads(kw["item"]["output"]) for path, kw in self.sent
                if path == "response.item.create" and kw["item"]["type"] == "function_call_output"]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.queue.get()


class FakeSideband:
    def __init__(self):
        self.conns: dict[str, FakeConn] = {}

    def connect(self, *, session_id):
        return self.conns.setdefault(session_id, FakeConn())


class FakeResponses:
    """판별 모델(responses.create). decide(요청 인수) → {"answer", "intent", "slot"} 또는 예외. 기본은 아무 판별 없음."""

    def __init__(self):
        self.requests: list[dict] = []
        self.delay = 0.0
        self.decide = lambda kw: {"answer": "none", "intent": "none", "slot": "none"}

    async def create(self, **kw):
        self.requests.append(kw)
        await asyncio.sleep(self.delay)
        result = self.decide(kw)
        return SimpleNamespace(output_text=result if isinstance(result, str) else json.dumps(result))


class FakeClient:
    def __init__(self):
        self.live = SimpleNamespace(sessions=FakeSessions(), sideband=FakeSideband())
        self.responses = FakeResponses()
        self.webhooks = AsyncOpenAI(api_key="test", webhook_secret=WEBHOOK_SECRET).webhooks


def signed_webhook(event_type: str, session_id: str, from_header: str = f"<sip:+82{CALLER[1:]}@pbx>",
                   webhook_id: str | None = None, secret: str = WEBHOOK_SECRET) -> tuple[bytes, dict]:
    body = json.dumps({
        "id": webhook_id or f"evt_{session_id}", "object": "event", "created_at": int(time.time()), "type": event_type,
        "data": {"type": "sip", "session_id": session_id,
                 "sip_headers": [{"name": "From", "value": from_header}, {"name": "To", "value": "<sip:proj@x>"}]},
    }).encode()
    wid, ts = webhook_id or f"wh_{session_id}", str(int(time.time()))
    key = base64.b64decode(secret[6:])
    sig = base64.b64encode(hmac.new(key, f"{wid}.{ts}.{body.decode()}".encode(), hashlib.sha256).digest()).decode()
    return body, {"webhook-id": wid, "webhook-timestamp": ts, "webhook-signature": f"v1,{sig}",
                  "content-type": "application/json"}


async def until(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > end:
            raise AssertionError("시간 안에 조건이 맞지 않음")
        await asyncio.sleep(0.01)
