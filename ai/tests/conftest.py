"""테스트 공용: 실제 OpenAI·PBX·DB를 부르지 않는다(가짜 DB, 가짜 클라이언트, 서명한 가짜 웹훅)."""

import asyncio
import base64
import hashlib
import hmac
import itertools
import json
import sys
import time
from types import SimpleNamespace

from openai import AsyncOpenAI

from app.call import Call
from app.config import load_server_config, load_texts
from app.main import check_definitions
from app.order import ORDER_FIELDS, Order, Place

CFG = load_server_config()
TEXTS = load_texts()
check_definitions(CFG, TEXTS)

WEBHOOK_SECRET = "whsec_" + base64.b64encode(b"test-secret").decode()
CALLER = "01012345678"

FULL_ORDER = {
    "sender_name": "김철수", "sender_phone": "공일공 일이삼사 오육칠팔", "sender_address": "서울 강남구 테헤란로 212",
    "sender_address_detail": "1201호", "receiver_name": "이영희", "receiver_phone": "010-9876-5432",
    "receiver_address": "부산 해운대구 센텀로 10", "receiver_address_detail": "", "item": "옷",
}


def run(coro):
    """psycopg async는 Windows에서 SelectorEventLoop가 필요하다."""
    if sys.platform == "win32":
        return asyncio.run(coro, loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(coro)


class FakeDB:
    """app.db.Database와 같은 메서드를 메모리로."""

    def __init__(self):
        self.orders: list[dict] = []
        self.places: dict[str, list[Place]] = {}
        self._seq = itertools.count(1)
        self.delay = 0.0

    async def insert_order(self, caller, session_id, order: Order, fare, prefix):
        await asyncio.sleep(self.delay)
        no = f"{prefix}{next(self._seq):06d}"
        self.orders.append({"order_no": no, "caller_phone": caller, "session_id": session_id, "fare": fare,
                            "status": "received", **order.model_dump()})
        return no

    async def list_orders(self, caller, limit):
        mine = [o for o in reversed(self.orders) if o["caller_phone"] == caller]
        return [{k: o[k] for k in ("order_no", "receiver_name", "item", "status")} for o in mine[:limit]]

    async def latest_receiver(self, caller):
        for o in reversed(self.orders):
            if o["caller_phone"] == caller and o["status"] == "received":
                return Place(name=o["receiver_name"], phone=o["receiver_phone"], address=o["receiver_address"],
                             address_detail=o["receiver_address_detail"])
        return None

    def _find(self, caller, order_no):
        return next((o for o in self.orders if o["order_no"] == order_no and o["caller_phone"] == caller
                     and o["status"] == "received"), None)

    async def update_order(self, caller, order_no, values):
        o = self._find(caller, order_no)
        if not o:
            return False
        o.update({k: v for k, v in values.items() if k in ORDER_FIELDS})
        return True

    async def cancel_order(self, caller, order_no):
        o = self._find(caller, order_no)
        if not o:
            return False
        o["status"] = "cancelled"
        return True

    async def list_places(self, owner):
        return list(self.places.get(owner, []))

    async def save_places(self, owner, places):
        mine = self.places.setdefault(owner, [])
        new = [p for p in places if p not in mine]
        mine.extend(new)
        return len(new)

    async def recent_orders(self, limit):
        return list(reversed(self.orders))[:limit]


def make_call(db=None, caller=CALLER, session_id="live_test") -> Call:
    call = Call(session_id, caller, CFG, TEXTS, db or FakeDB())
    run(call.prepare())
    return call


# --- 가짜 OpenAI 클라이언트 ---


class FakeSessions:
    def __init__(self):
        self.calls: list[tuple] = []
        self.accept_error: Exception | None = None

    async def accept(self, session_id, *, session):
        self.calls.append(("accept", session_id, session))
        if self.accept_error:
            raise self.accept_error

    async def reject(self, session_id, *, status_code):
        self.calls.append(("reject", session_id, status_code))

    async def hangup(self, session_id):
        self.calls.append(("hangup", session_id))

    async def refer(self, session_id, *, target_uri):
        self.calls.append(("refer", session_id, target_uri))

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
        return [json.loads(kw["item"]["output"]) for path, kw in self.sent if path == "response.item.create"]

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


class FakeClient:
    def __init__(self):
        self.live = SimpleNamespace(sessions=FakeSessions(), sideband=FakeSideband())
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
