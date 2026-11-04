"""테스트 공용: 실제 OpenAI·PBX·백엔드·카카오·주소DB를 부르지 않는다(AddressService는 주소DB를 넘길 때만 보정)."""

import asyncio
import base64
import hashlib
import hmac
import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from app.domain.state import Geo as DomainGeo
from app.integrations import kakao
from backend_client.order import Geo

WEBHOOK_SECRET = "whsec_" + base64.b64encode(b"test-secret").decode()
CALLER = "01012345678"
INCOMING_AT = "2026-10-28T01:00:00Z"
# 수거 희망 시각(미래). 기록하면 한국 시간으로 바뀐다
PICKUP_AT = (datetime.now(timezone(timedelta(hours=9))) + timedelta(days=1)).replace(
    hour=10, minute=0, second=0, microsecond=0).isoformat()
FULL_ORDER = {
    "sender_name": "김철수", "sender_phone": "공일공 일이삼사 오육칠팔", "sender_address": "서울 강남구 테헤란로 212",
    "sender_address_detail": "1201호", "receiver_name": "이영희", "receiver_phone": "010-9876-5432",
    "receiver_address": "부산 해운대구 센텀로 10", "receiver_address_detail": "", "small_box_count": 1,
    "item_price": 30000, "pickup_at": PICKUP_AT,
}
GEO = Geo(jibun_address="서울 강남구 역삼동 737", dong_name="역삼동", postal_code="06236")


@pytest.fixture
def fake_kakao(monkeypatch):
    """카카오 주소 검색을 부르지 않는다. 확정한 주소마다 같은 지번·우편번호를 돌려준다."""
    async def geocode(address_, timeout_sec, transport=None, http=None):
        return DomainGeo(GEO.jibun_address, GEO.dong_name, GEO.postal_code) if address_ else None

    monkeypatch.setattr(kakao, "geocode", geocode)


def run(coro):
    return asyncio.run(coro)


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
