"""PBX 통화 종료 웹훅(spec/pbx-sip.md). PBX가 팀 백엔드에 보내는 것과 같은 본문을 우리에게도 보낸다.
공인 인터넷에 열리는 주소이므로 Authorization: Bearer <PBX_WEBHOOK_SECRET>이 맞는 것만 처리한다.
본문의 발신번호(callFrom)는 미신뢰 값이다: 통화를 찾는 데만 쓴다. 모르는 통화·이미 끝난 통화도 200(다시 와도 괜찮다).
웹훅은 통화가 끝나고 몇 초 뒤에 온다: 같은 번호로 다시 건 통화를 끊지 않게 콜백은 ended_at 전에 시작한 통화만 끝내야 한다."""

import logging
import os
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, Request, Response
from pydantic import AwareDatetime, BaseModel, Field, ValidationError

from pbx_webhook.sip import normalize_caller, token_ok

log = logging.getLogger(__name__)


class CallEnded(BaseModel):
    """쓰는 필드만 검증한다. recordingUrl 등 나머지 필드는 무시."""
    call_from: str = Field(alias="callFrom", min_length=1, max_length=32)
    ended_at: AwareDatetime = Field(alias="endedAt")
    recording_id: str | None = Field(None, alias="recordingId", max_length=128)

    @property
    def caller(self) -> str | None:
        return normalize_caller(self.call_from)


def create_call_ended_router(on_call_ended: Callable[[CallEnded], Awaitable[None]],
                             path: str = "/pbx/webhook/call-ended") -> APIRouter:
    """on_call_ended는 요청 안에서 기다린다(통화 표시만 하고 끊기는 백그라운드로 넘기는 짧은 일만)."""
    router = APIRouter()

    @router.post(path)
    async def call_ended(request: Request) -> Response:
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
        await on_call_ended(event)
        return Response(status_code=200)

    return router
