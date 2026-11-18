"""통화 불만 판정 서비스 (후처리 전용, 11/05 결정 — README.md).

백엔드가 끝난 통화의 저장된 기록(EVT-01 이벤트) · 녹음 말소리 구간 · FAQ 원문을 보내면 불만 6유형 · 되묻기를 판정해 돌려준다.
저장은 백엔드가 한다. 입력 · 출력 명세는 CONTRACT.md.
AI 통화 처리 서버(app/)와 따로 뜨는 작은 HTTP 서비스다. app을 import하지 않고, DB도 상태도 없다.

    uvicorn call_analysis.server:app --host 0.0.0.0 --port 8090   (ai/ 폴더에서)

환경 변수:
- CALL_ANALYSIS_TOKEN (필수): 백엔드만 부르게 하는 서비스 토큰. 요청은 'Authorization: Bearer <토큰>'
- CALL_ANALYSIS_OPENAI_API_KEY (필수): 실시간 상담과 다른 전용 키
- CALL_ANALYSIS_CONCURRENCY (선택, 기본 2): 동시에 판정할 통화 수. 통화 하나가 3판을 동시에 보낸다

대본은 개인정보라 요청 본문 · 판정 사유를 로그에 찍지 않는다(analyze.run은 통화 번호 · 유형 · 시간만 남긴다).
"""

import asyncio
import getpass
import hmac
import os
import sys
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from call_analysis import analyze, extract

MAX_EVENTS = 5000  # 통화 한 건의 이벤트 상한 (긴 통화도 수백 개)
# 판정 유형 → 백엔드 불만 유형(CALL_COMPLAINT_TYPES, 화면 6유형). 고객 되물음(CUSTOMER_CONFUSION)은 집계에서 뺌 (11/04 사용자)
BACKEND_TYPE = {
    "RECOGNITION_FAILURE": "INFORMATION_RECOGNITION_ERROR",  # 고객이 준 정보를 잘못 받음
    "INTENT_FAILURE": "INTENT_RECOGNITION_ERROR",  # 고객의 질문 · 요청을 다르게 받음
    "UNGROUNDED_ANSWER": "UNSUPPORTED_ANSWER",  # FAQ · 업무 규칙과 반대로 안내함 — 11/10부터 참고 표시(정확도 미검증, AI 품질 비율에 넣지 않음)
    "SLOW_RESPONSE": "SLOW_RESPONSE",  # 응답이 늦어 고객이 불편함(녹음 침묵 + 고객 반응)
    "INTERRUPTION": "INTERRUPTION",  # 말 끊김
    "FRUSTRATION": "DISSATISFACTION_EXPRESSION",  # 고객이 불만을 드러냄
}


class Event(BaseModel):
    """EVT-01 이벤트 한 개 — 백엔드 call_insight_events + call_utterances 그대로 (docs/api/call-events.md)."""
    model_config = ConfigDict(extra="ignore")
    kind: Literal["UTTERANCE", "AI_ACTION", "BUSINESS_RESULT"]
    occurredAt: str
    offsetSeconds: int | None = None
    payload: dict = Field(default_factory=dict)


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    callSessionSeq: int = Field(gt=0)  # 로그용 (본문 대신)
    events: list[Event] = Field(max_length=MAX_EVENTS)
    # 녹음 말소리 구간 [[시작초, 끝초], ...] — 백엔드가 녹음 파일로 timing.speech_segments와 같이 구해 보낸다. 없으면 시간 근거 없이 판정
    speech: list[tuple[float, float]] | None = Field(default=None, max_length=20000)
    # FAQ 원문 [{question, answer}] — 근거 없는 답변을 대조할 자료. 백엔드 FAQ 테이블 그대로. 없으면 AI 서버 검토 기록만으로 판단
    faqs: list[dict] | None = Field(default=None, max_length=500)


class Complaint(BaseModel):
    type: str
    evidenceText: str  # 고객 불만이면 불만이 드러난 고객 말 그대로
    offsetSeconds: int | None
    utteranceOrders: list[int]
    target: str | None = None  # 고객 불만만: ai_service · price_policy · delivery_other
    level: str | None = None  # 고객 불만만: explicit · mild


class AnalyzeResponse(BaseModel):
    """백엔드 분석(ANL-01)의 불만 칸과 같은 모양. 말이 없는 통화는 불만 없음 · 되묻기 0."""
    hasComplaint: bool
    complaints: list[Complaint]
    repeatQuestionCount: int
    votes: int  # 다수결에 쓴 판 수 (말이 없으면 0)
    model: str
    # 통화 전체 (운영팀 참고자료의 긍·부정 · 문의 유형). 말이 없으면 빈 목록 · null
    purposes: list[str] = []  # 고객 용건: register · lookup · cancel · inquiry · handoff · other
    goal: str | None = None  # 용건을 이뤘는지: achieved · partial · failed · none
    mood: str | None = None  # 고객 감정: positive · neutral · negative
    # 판정 점검용: 다수결에 못 미쳐 빠진 표시(한 판만 잡음). complaints에 없는 것만. 백엔드는 쓰지 않음 (evaluate.py가 기준 비교에 씀)
    candidates: list[Complaint] = []
    dropped: dict = {}  # 판정 점검용: 모델이 표시했는데 검사 · 장면 재확인에서 버린 수(이유별, 모든 판 합). 백엔드는 쓰지 않음
    tokens: dict | None  # 모든 판 합계 {input, cached, output, reasoning} — 비용 확인용 (말이 없으면 null)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 테스트는 app.state.client · token을 미리 넣는다
    if not getattr(app.state, "client", None):
        from openai import AsyncOpenAI

        # 키가 환경 변수에 없고 창에서 직접 띄웠으면 그 자리에서 묻는다(입력은 화면에 안 보임) — 키를 명령 줄 · 기록에 남기지 않게
        key = os.environ.get("CALL_ANALYSIS_OPENAI_API_KEY") or (
            getpass.getpass("OpenAI 전용 키를 붙여 넣고 Enter (화면에 안 보임): ").strip() if sys.stdin.isatty() else "")
        if not key:
            raise RuntimeError("CALL_ANALYSIS_OPENAI_API_KEY가 없습니다")
        app.state.client = AsyncOpenAI(api_key=key)
    if not getattr(app.state, "token", None):
        app.state.token = os.environ.get("CALL_ANALYSIS_TOKEN") or "local-judge"  # 내 PC 시험용 기본값 (try_live와 같은 값)
    app.state.gate = asyncio.Semaphore(int(os.environ.get("CALL_ANALYSIS_CONCURRENCY", "2")))
    yield


app = FastAPI(title="call-analysis", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def _auth(header: str | None) -> None:
    given = (header or "").removeprefix("Bearer ").strip()
    if not given or not hmac.compare_digest(given, app.state.token):
        raise HTTPException(401, "UNAUTHORIZED")


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_call(body: AnalyzeRequest, authorization: str | None = Header(default=None)) -> AnalyzeResponse:
    """끝난 통화 하나 판정. 422 = 입력이 너무 길어 판정 안 함(다시 보내도 같음) · 503 = 모델 장애로 판정 실패(나중에 다시)."""
    _auth(authorization)
    rec = analyze.from_events([e.model_dump() for e in body.events], f"call-{body.callSessionSeq}", body.speech)
    if len(analyze.describe(rec)) > analyze.MAX_INPUT_CHARS:
        raise HTTPException(422, "INPUT_TOO_LONG")
    async with app.state.gate:
        result = await analyze.run(rec, app.state.client, faqs=body.faqs)
    if result is None:
        raise HTTPException(503, "ANALYSIS_UNAVAILABLE")
    v = extract.values(result, rec)
    found = [c | {"type": BACKEND_TYPE[c["type"]]} for c in v["complaints"] if c["type"] in BACKEND_TYPE]
    # 한 판만 잡은 표시까지 넣어 다시 뽑고, 이미 잡힌 불만과 겹치지 않는 것만 후보로 (점검용)
    extra = [c | {"type": BACKEND_TYPE[c["type"]]} for c in extract.complaints(analyze.loose(result), rec) if c["type"] in BACKEND_TYPE]
    candidates = [c for c in extra if not any(f["type"] == c["type"] and set(f["utteranceOrders"]) & set(c["utteranceOrders"]) for f in found)]
    return AnalyzeResponse(hasComplaint=bool(found), complaints=found,
                           repeatQuestionCount=v["repeatQuestionCount"], votes=result["votes"], model=analyze.MODEL,
                           candidates=candidates, dropped=result.get("dropped") or {}, purposes=result["call"]["purposes"], goal=result["call"]["goal"], mood=result["call"]["mood"],
                           tokens=result["usage"])
