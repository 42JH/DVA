"""통화 종료 후 의미 판정. 검색 결과의 answerable을 실제 답변 여부로 사용하지 않는다."""

import asyncio
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

NAMESPACE = uuid.UUID("cbbbd75b-af26-46c3-a362-f1b253223dce")
REVIEW_VERSION = "unanswered-v1"


class Inquiry(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    customer_index: int = Field(ge=0)
    question_text: str = Field(min_length=1, max_length=1000)
    tool_indices: list[int]
    outcome: Literal["ANSWERED", "UNANSWERED", "CLARIFICATION", "UNKNOWN"]
    agent_index: int | None
    agent_quote: str | None


class ReviewDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    inquiries: list[Inquiry]


class ReviewError(Exception):
    """본문을 예외 메시지에 포함하지 않는 검토 오류."""


class UnansweredReviewer:
    def __init__(self, client, model: str, prompt: str, *, timeout_sec: float,
                 max_input_chars: int, max_output_tokens: int):
        self.client, self.model, self.prompt = client, model, prompt
        self.timeout_sec, self.max_input_chars = timeout_sec, max_input_chars
        self.max_output_tokens = max_output_tokens

    async def review(self, evidence: dict) -> dict:
        if not evidence["searches"]:
            return {"version": REVIEW_VERSION, "model": self.model, "inquiries": []}
        # Live의 현재 전사 보존 상한에 도달하면 앞부분 유실 가능성이 있다.
        if len(evidence["transcript"]) >= 300:
            raise ReviewError("TRANSCRIPT_POSSIBLY_TRUNCATED")
        content = json.dumps(evidence, ensure_ascii=False)
        if len(content) > self.max_input_chars:
            raise ReviewError("REVIEW_INPUT_TOO_LARGE")
        async with asyncio.timeout(self.timeout_sec):
            response = await self.client.with_options(max_retries=0, timeout=self.timeout_sec).responses.parse(
                model=self.model, store=False,
                input=[{"role": "system", "content": self.prompt}, {"role": "user", "content": content}],
                text_format=ReviewDecision, max_output_tokens=self.max_output_tokens,
            )
        if response.status != "completed" or response.output_parsed is None:
            raise ReviewError("REVIEW_NOT_COMPLETED")
        decision = ReviewDecision.model_validate(response.output_parsed)
        return validate_decision(evidence, decision) | {"version": REVIEW_VERSION, "model": self.model}


def evidence_from_session(s) -> dict:
    """인덱스는 저장된 스냅샷 안에서 고정된다. 검색 도구만 포함한다."""
    return {"transcript": [{"speaker": r["speaker"], "text": r["text"], "t": r["t"]}
                           for r in s.transcript],
            "searches": [{"arguments": t.get("arguments", "{}"), "at": t.get("at", s.started_t),
                          "output": t.get("output") or {}}
                         for t in s.tool_calls if t["name"] == "search_manual"]}


def validate_decision(evidence: dict, decision: ReviewDecision) -> dict:
    """모델이 만든 원문·사유를 신뢰하지 않고 참조·인용·순서를 검사한다."""
    transcript, searches = evidence["transcript"], evidence["searches"]
    seen, used_tools, items = set(), set(), []
    for inquiry in decision.inquiries:
        i = inquiry.customer_index
        if i >= len(transcript) or transcript[i]["speaker"] != "customer":
            raise ReviewError("INVALID_CUSTOMER_REFERENCE")
        question = inquiry.question_text
        if not question.strip() or "\x00" in question or question not in transcript[i]["text"]:
            raise ReviewError("INVALID_QUESTION_QUOTE")
        key = (i, question)
        indices = inquiry.tool_indices
        if key in seen or not indices or len(indices) != len(set(indices)):
            raise ReviewError("DUPLICATE_OR_MISSING_INQUIRY")
        if any(j < 0 or j >= len(searches) or j in used_tools for j in indices):
            raise ReviewError("INVALID_SEARCH_REFERENCE")
        seen.add(key)
        used_tools.update(indices)
        ordered = sorted(indices, key=lambda j: (searches[j]["at"], j))
        if any(searches[j]["at"] < transcript[i]["t"] for j in ordered):
            raise ReviewError("SEARCH_BEFORE_QUESTION")
        if inquiry.outcome in ("ANSWERED", "UNANSWERED"):
            a = inquiry.agent_index
            quote = inquiry.agent_quote
            if (a is None or a <= i or a >= len(transcript) or transcript[a]["speaker"] != "agent"
                    or not quote or not quote.strip() or quote not in transcript[a]["text"]
                    or transcript[a]["t"] < searches[ordered[-1]]["at"]):
                raise ReviewError("INVALID_AGENT_QUOTE")
        else:
            a, quote = inquiry.agent_index, inquiry.agent_quote
        reason = None
        if inquiry.outcome == "UNANSWERED":
            out = searches[ordered[-1]]["output"]
            if out.get("status") == "unavailable":
                reason = "KB_UNAVAILABLE"
            elif out.get("status") == "ok":
                reason = "KB_NO_ANSWER"
            else:
                raise ReviewError("UNKNOWN_SEARCH_STATUS")
        items.append(inquiry.model_dump() | {"reason": reason})
    # 모델이 일부 검색을 빠뜨린 결과를 '검토 완료'로 저장하지 않는다.
    if used_tools != set(range(len(searches))):
        raise ReviewError("INCOMPLETE_SEARCH_COVERAGE")
    return {"inquiries": sorted(items, key=lambda item: (item["customer_index"], item["question_text"]))}


def apply_review(session_id: str, started_t: float, evidence: dict, payload: dict, review: dict) -> dict:
    """확정 판정으로 전송 초안을 생성. eventId는 모델 출력 배열 순서에 의존하지 않는다."""
    unanswered = []
    for item in review["inquiries"]:
        if item["outcome"] != "UNANSWERED":
            continue
        question = item["question_text"]
        ts = evidence["transcript"][item["customer_index"]]["t"]
        digest = hashlib.sha256(question.encode()).hexdigest()
        event_id = str(uuid.uuid5(NAMESPACE, f"{session_id}:{item['customer_index']}:{digest}"))
        unanswered.append({"eventId": event_id, "questionText": question,
                           "occurredAt": datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds"),
                           "offsetSeconds": max(0, int(ts - started_t)), "reason": item["reason"]})
    return payload | {"unanswered": unanswered,
                      "analysis": payload["analysis"] | {
                          "faqAnswerCount": sum(i["outcome"] == "ANSWERED" for i in review["inquiries"])}}
