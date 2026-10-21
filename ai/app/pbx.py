"""PBX 통화 종료 웹훅(spec/pbx-sip.md). 고객이 끊은 것을 PBX가 알려 주면 해당 OpenAI 세션을 끝낸다.

통화는 SIP Call-ID로 찾는다(들어오는 전화 웹훅의 SIP 헤더에서 기억해 둔 값).
공인 인터넷에 열리는 주소이므로 서명 검증을 통과한 것만 처리한다: 공유 비밀값 PBX_WEBHOOK_SECRET으로
"타임스탬프.본문"을 HMAC-SHA256한 hex를 X-Pbx-Signature: sha256=<hex>, 시각은 X-Pbx-Timestamp(유닉스 초).
"""

import hashlib
import hmac
import logging
import os
import time

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field, ValidationError

log = logging.getLogger(__name__)
router = APIRouter()


class CallEnded(BaseModel):
    call_id: str = Field(min_length=1, max_length=256)
    ended_at: str | None = Field(None, max_length=64)
    reason: str | None = Field(None, max_length=64)


def signature_ok(secret: str, timestamp: str | None, signature: str | None, body: bytes, tolerance: int) -> bool:
    if not timestamp or not signature or not timestamp.isdigit():
        return False
    if abs(time.time() - int(timestamp)) > tolerance:  # 재전송 공격 방지
        return False
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


@router.post("/pbx/webhook/call-ended")
async def call_ended(request: Request) -> Response:
    svc = request.app.state.svc
    secret = os.environ.get("PBX_WEBHOOK_SECRET")
    if not secret:
        log.error("PBX_WEBHOOK_SECRET이 없어 PBX 웹훅을 받지 않음")
        return Response(status_code=503)
    body = await request.body()
    if not signature_ok(secret, request.headers.get("x-pbx-timestamp"), request.headers.get("x-pbx-signature"),
                        body, svc.cfg.pbx.webhook_tolerance_sec):
        log.warning("PBX 웹훅 서명 검증 실패")
        return Response(status_code=401)
    try:
        event = CallEnded.model_validate_json(body)
    except ValidationError:
        return Response(status_code=400)
    call = svc.registry.find_by_sip_call_id(event.call_id)
    if call is None:
        return Response(status_code=200)  # 이미 끝났거나 모르는 통화. 다시 와도 괜찮다
    if call.pbx_ended is None:
        call.pbx_ended = {"at": time.time(), "reason": event.reason, "ended_at": event.ended_at}
        call.notify()
        if call.status == "active":
            svc.spawn(hangup(svc, call))
        # accepting이면 accept가 끝나는 대로 webhook.handle_incoming이 끊는다
    return Response(status_code=200)


async def hangup(svc, call) -> None:
    """고객이 이미 끊었으므로 마무리 인사를 기다리지 않고 바로 끝낸다."""
    try:
        await svc.client.live.sessions.hangup(call.session_id)
    except Exception:
        log.exception("PBX 종료 후 hangup 실패 %s", call.session_id)
        call.add_error("PBX 종료 후 hangup 실패")
