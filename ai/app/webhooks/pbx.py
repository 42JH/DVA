"""PBX 통화 종료 웹훅(spec/pbx-sip.md). PBX가 팀 백엔드에 보내는 것과 같은 본문을 우리에게도 보낸다.
고객이 끊었는데 아직 진행 중인 세션이 있으면 바로 끝낸다(보통은 sideband session.closed로 먼저 끝나 있다).

공인 인터넷에 열리는 주소이므로 Authorization: Bearer <PBX_WEBHOOK_SECRET>이 맞는 것만 처리한다.
본문의 발신번호(callFrom)는 미신뢰 값이다: 통화를 찾는 데만 쓴다.
"""

import hmac
import logging
import os
import time

from fastapi import APIRouter, Request, Response
from pydantic import AwareDatetime, BaseModel, Field, ValidationError

from app.call import normalize_phone
from app.sideband import hangup_now

log = logging.getLogger(__name__)
router = APIRouter()


class CallEnded(BaseModel):
    """쓰는 필드만 검증한다. recordingUrl 등 나머지 필드는 무시."""
    call_from: str = Field(alias="callFrom", min_length=1, max_length=32)
    ended_at: AwareDatetime = Field(alias="endedAt")
    recording_id: str | None = Field(None, alias="recordingId", max_length=128)


def token_ok(secret: str, authorization: str | None) -> bool:
    scheme, _, token = (authorization or "").partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(token.strip().encode(), secret.encode())


@router.post("/pbx/webhook/call-ended")
async def call_ended(request: Request) -> Response:
    svc = request.app.state.svc
    secret = os.environ.get("PBX_WEBHOOK_SECRET")
    if not secret:
        log.error("PBX_WEBHOOK_SECRET이 없어 PBX 웹훅을 받지 않음")
        return Response(status_code=503)
    if not token_ok(secret, request.headers.get("authorization")):
        log.warning("PBX 웹훅 인증 실패")
        return Response(status_code=401)
    try:
        event = CallEnded.model_validate_json(await request.body())
    except ValidationError:
        return Response(status_code=400)
    caller = normalize_phone(event.call_from)
    # 웹훅은 통화가 끝나고 몇 초 뒤에 온다. 그사이 같은 번호로 다시 건 통화를 끊지 않게 종료 시각 전에 시작한 통화만
    for call in svc.registry.find_active_by_caller(caller, started_before=event.ended_at.timestamp()):
        if call.pbx_ended is None:
            call.pbx_ended = {"at": time.time(), "ended_at": event.ended_at.isoformat(),
                              "recording_id": event.recording_id}
            call.notify()
            if call.status == "active":
                svc.spawn(hangup_now(svc, call))
            # accepting이면 accept가 끝나는 대로 webhooks.openai.handle_incoming이 끊는다
    return Response(status_code=200)  # 모르는 통화·이미 끝난 통화도 200. 다시 와도 괜찮다
