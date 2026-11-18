"""BE → AI 페르소나 API(원본 develop-ai ai/app/webhooks/persona.py 그대로, 계약 backend/docs/ai-persona-next-call.md).
Authorization: Bearer <AI_PERSONA_TOKEN>이 맞는 것만 처리한다. 토큰·프롬프트는 로그에 남기지 않는다."""

import logging
import os

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from app.calls.persona import OPTIONS
from pbx_webhook.sip import token_ok

log = logging.getLogger(__name__)
router = APIRouter(prefix="/internal/persona")


class Refresh(BaseModel):
    """변경 힌트일 뿐이라 검증만 하고 값은 쓰지 않는다(실제 대기 설정을 다시 조회한다)."""
    ai_persona_version_seq: int = Field(alias="aiPersonaVersionSeq", ge=1)
    application_id: str = Field(alias="applicationId", min_length=1, max_length=64)


def _denied(request: Request) -> Response | None:
    token = os.environ.get("AI_PERSONA_TOKEN")
    if not token:
        return Response(status_code=503)
    if not token_ok(token, request.headers.get("authorization")):
        log.warning("페르소나 API 인증 실패")
        return Response(status_code=401)
    return None


@router.get("/options")
async def options(request: Request) -> Response:
    return _denied(request) or JSONResponse(OPTIONS)


@router.post("/refresh")
async def refresh(request: Request) -> Response:
    if denied := _denied(request):
        return denied
    try:
        Refresh.model_validate_json(await request.body())
    except ValidationError:
        return Response(status_code=400)
    calls = request.app.state.svc.calls
    if calls is None:  # 통화 수신이 꺼져 있으면(OPENAI_API_KEY 없음) 적용할 곳이 없다
        return Response(status_code=503)
    calls.persona.refresh()
    return Response(status_code=202)
