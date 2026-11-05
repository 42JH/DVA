"""통화 종료 후 의미 판정. 검색 결과의 answerable을 실제 답변 여부로 사용하지 않는다."""

import asyncio
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

NAMESPACE = uuid.UUID("cbbbd75b-af26-46c3-a362-f1b253223dce")
REVIEW_VERSION = "unanswered-v3-explicit-refs"


class UsedEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    search_index: int = Field(ge=0)
    chunk_id: str = Field(min_length=1)
    evidence_quote: str = Field(min_length=1)
    answer_quote: str = Field(min_length=1)


class Inquiry(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    customer_index: int = Field(ge=0)
    question_text: str = Field(min_length=1, max_length=1000)
    tool_indices: list[int]
    outcome: Literal["ANSWERED", "UNANSWERED", "CLARIFICATION", "UNKNOWN"]
    agent_index: int | None
    agent_quote: str | None
    used_evidence: list[UsedEvidence] = Field(default_factory=list, max_length=100)


class ReviewDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    inquiries: list[Inquiry]


class ReferencedEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    search_ref: str
    chunk_id: str
    evidence_quote: str
    answer_quote: str


class ReferencedInquiry(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    customer_ref: str
    question_text: str
    search_refs: list[str]
    outcome: Literal["ANSWERED", "UNANSWERED", "CLARIFICATION", "UNKNOWN"]
    agent_ref: str | None
    agent_quote: str | None
    used_evidence: list[ReferencedEvidence] = Field(max_length=100)


class ReferencedDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    inquiries: list[ReferencedInquiry]


class ReviewError(Exception):
    """본문을 예외 메시지에 포함하지 않는 검토 오류."""

    def __init__(self, code: str, diagnostic: dict | None = None):
        super().__init__(code)
        self.diagnostic = diagnostic


class UnansweredReviewer:
    def __init__(self, client, model: str, prompt: str, *, timeout_sec: float,
                 max_input_chars: int, max_output_tokens: int):
        self.client, self.model, self.prompt = client, model, prompt
        self.timeout_sec, self.max_input_chars = timeout_sec, max_input_chars
        self.max_output_tokens = max_output_tokens

    async def review(self, evidence: dict) -> dict:
        if not evidence["searches"]:
            return {"version": REVIEW_VERSION, "model": self.model, "inquiries": [], "complete": True, "issues": []}
        # Live의 현재 전사 보존 상한에 도달하면 앞부분 유실 가능성이 있다.
        if len(evidence["transcript"]) >= 300:
            raise ReviewError("TRANSCRIPT_POSSIBLY_TRUNCATED")
        numbered = model_evidence(evidence)
        content = json.dumps(numbered, ensure_ascii=False)
        if len(content) > self.max_input_chars:
            raise ReviewError("REVIEW_INPUT_TOO_LARGE")
        async with asyncio.timeout(self.timeout_sec):
            response = await self.client.with_options(max_retries=0, timeout=self.timeout_sec).responses.parse(
                model=self.model, store=False,
                input=[{"role": "system", "content": self.prompt}, {"role": "user", "content": content}],
                text_format=ReferencedDecision, max_output_tokens=self.max_output_tokens,
            )
        if response.status != "completed" or response.output_parsed is None:
            raise ReviewError("REVIEW_NOT_COMPLETED", {"status": response.status,
                                                       "output_text": getattr(response, "output_text", None)})
        decision = ReferencedDecision.model_validate(response.output_parsed)
        return validate_referenced_decision(evidence, numbered, decision) | {
            "version": REVIEW_VERSION, "model": self.model, "raw_decision": decision.model_dump()}


def evidence_from_session(s) -> dict:
    """인덱스는 저장된 스냅샷 안에서 고정된다. 검색 도구만 포함한다."""
    return {"transcript": [{"utterance_id": r.get("id"), "speaker": r["speaker"], "text": r["text"], "t": r["t"]}
                           for r in s.transcript],
            "searches": [{"arguments": t.get("arguments", "{}"), "at": t.get("at", s.started_t),
                          "output": t.get("output") or {}}
                         for t in s.tool_calls if t["name"] == "search_manual"]}


def model_evidence(evidence: dict) -> dict:
    """모델이 번호를 세지 않고 저장된 스냅샷의 명시적 참조를 선택하게 한다."""
    return {"transcript": [r | {"ref": f"u:{r.get('utterance_id', 'legacy')}:{i}"}
                           for i, r in enumerate(evidence["transcript"])],
            "searches": [r | {"ref": f"s:{i}"} for i, r in enumerate(evidence["searches"])]}


def validate_referenced_decision(evidence: dict, numbered: dict, decision: ReferencedDecision) -> dict:
    """불량 항목/근거를 격리한다. 실패를 미답변이나 0건으로 변환하지 않는다."""
    utter = {r["ref"]: i for i, r in enumerate(numbered["transcript"])}
    searches = {r["ref"]: i for i, r in enumerate(numbered["searches"])}
    items, issues, seen, covered = [], [], set(), set()
    complete = True
    for index, raw in enumerate(decision.inquiries):
        try:
            if raw.customer_ref not in utter or (raw.agent_ref is not None and raw.agent_ref not in utter):
                raise ReviewError("UNKNOWN_UTTERANCE_REF")
            if any(ref not in searches for ref in raw.search_refs):
                raise ReviewError("UNKNOWN_SEARCH_REF")
            inquiry = Inquiry(customer_index=utter[raw.customer_ref], question_text=raw.question_text,
                              tool_indices=[searches[ref] for ref in raw.search_refs], outcome=raw.outcome,
                              agent_index=utter[raw.agent_ref] if raw.agent_ref is not None else None,
                              agent_quote=raw.agent_quote)
            key = (inquiry.customer_index, inquiry.question_text)
            if key in seen:
                raise ReviewError("DUPLICATE_OR_MISSING_INQUIRY")
            validated = validate_decision(evidence, ReviewDecision(inquiries=[inquiry]), require_coverage=False)["inquiries"][0]
            if inquiry.question_text not in evidence["transcript"][inquiry.customer_index]["text"][:20000]:
                raise ReviewError("FAQ_QUOTE_NOT_TRANSMITTED")
            seen.add(key)
            covered.update(inquiry.tool_indices)
        except (ReviewError, ValueError) as e:
            complete = False
            issues.append({"inquiry": index, "code": str(e) if isinstance(e, ReviewError) else "INVALID_INQUIRY_SCHEMA"})
            continue
        selected, used = [], set()
        if inquiry.outcome == "UNKNOWN":
            complete = False
            issues.append({"inquiry": index, "code": "UNDETERMINED_INQUIRY"})
        for citation, ref in enumerate(raw.used_evidence):
            try:
                if ref.search_ref not in searches:
                    raise ReviewError("UNKNOWN_SEARCH_REF")
                item = UsedEvidence(search_index=searches[ref.search_ref], chunk_id=ref.chunk_id,
                                    evidence_quote=ref.evidence_quote, answer_quote=ref.answer_quote)
                key = (item.search_index, item.chunk_id)
                if key in used:
                    raise ReviewError("DUPLICATE_EVIDENCE_REFERENCE")
                _validate_evidence(inquiry.model_copy(update={"used_evidence": [item]}), evidence["searches"])
                if item.answer_quote not in evidence["transcript"][inquiry.agent_index]["text"][:20000]:
                    raise ReviewError("FAQ_QUOTE_NOT_TRANSMITTED")
                selected.append(item)
                used.add(key)
            except (ReviewError, ValueError) as e:
                issues.append({"inquiry": index, "citation": citation,
                               "code": str(e) if isinstance(e, ReviewError) else "INVALID_EVIDENCE_SCHEMA"})
        inquiry.used_evidence = selected
        validated.update(used_evidence=[r.model_dump() for r in selected],
                         faq_entry_seqs=_validate_evidence(inquiry, evidence["searches"]))
        items.append(validated)
    if covered != set(range(len(evidence["searches"]))):
        complete = False
        issues.append({"code": "INCOMPLETE_SEARCH_COVERAGE"})
    return {"inquiries": sorted(items, key=lambda r: (r["customer_index"], r["question_text"])),
            "complete": complete, "issues": issues}


def validate_decision(evidence: dict, decision: ReviewDecision, *, require_coverage: bool = True) -> dict:
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
        # 복합 질문은 같은 검색의 서로 다른 근거를 함께 쓸 수 있다.
        if any(j < 0 or j >= len(searches) for j in indices):
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
        faq_ids = _validate_evidence(inquiry, searches)
        items.append(inquiry.model_dump() | {"reason": reason, "faq_entry_seqs": faq_ids})
    # 모델이 일부 검색을 빠뜨린 결과를 '검토 완료'로 저장하지 않는다.
    if require_coverage and used_tools != set(range(len(searches))):
        raise ReviewError("INCOMPLETE_SEARCH_COVERAGE")
    return {"inquiries": sorted(items, key=lambda item: (item["customer_index"], item["question_text"]))}


def _validate_evidence(inquiry: Inquiry, searches: list[dict]) -> list[int]:
    if inquiry.used_evidence and inquiry.outcome != "ANSWERED":
        raise ReviewError("EVIDENCE_WITHOUT_ANSWER")
    selected, seen = set(), set()
    for ref in inquiry.used_evidence:
        if ref.search_index not in inquiry.tool_indices:
            raise ReviewError("EVIDENCE_OUTSIDE_INQUIRY")
        key = (ref.search_index, ref.chunk_id)
        if key in seen:
            raise ReviewError("DUPLICATE_EVIDENCE_REFERENCE")
        seen.add(key)
        out = searches[ref.search_index]["output"]
        context = (out.get("facts") or {}).get("context") or {}
        candidates = [d for d in context.get("evidence", []) if d.get("chunk_id") == ref.chunk_id]
        if out.get("status") != "ok" or len(candidates) != 1:
            raise ReviewError("UNKNOWN_EVIDENCE_REFERENCE")
        doc = candidates[0]
        if (not ref.evidence_quote.strip() or ref.evidence_quote not in doc.get("content", "")
                or not ref.answer_quote.strip() or ref.answer_quote not in (inquiry.agent_quote or "")):
            raise ReviewError("INVALID_EVIDENCE_QUOTE")
        match = re.fullmatch(r"backend-faq:([1-9][0-9]{0,9})", doc.get("source_id", ""))
        if match is None or int(match[1]) > 2_147_483_647:
            raise ReviewError("INVALID_BACKEND_FAQ_SOURCE")
        selected.add(int(match[1]))
    return sorted(selected)


def apply_review(session_id: str, started_t: float, evidence: dict, payload: dict, review: dict,
                 *, faq_answered_enabled: bool = False) -> dict:
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
    events = list(payload.get("events", []))
    if faq_answered_enabled:
        events = _answered_events(session_id, started_t, evidence, events, review)
    return payload | {"unanswered": unanswered, **({"events": events} if "events" in payload else {}),
                      "analysis": payload["analysis"] | {
                          "faqAnswerCount": (sum(i["outcome"] == "ANSWERED" for i in review["inquiries"])
                                             if review.get("complete", True) else None)}}


def _answered_events(session_id: str, started_t: float, evidence: dict, events: list[dict], review: dict) -> list[dict]:
    # 전사 인덱스와 API 발화 순번은 다르다(빈 발화는 기존 전송부가 제외한다).
    utterances = {e["payload"]["utteranceOrder"]: e["payload"] for e in events if e["kind"] == "UTTERANCE"}
    orders, order = {}, 0
    for i, row in enumerate(evidence["transcript"]):
        if row["text"].strip():
            order += 1
            orders[i] = order
    groups: dict[tuple[int, int], set[int]] = {}
    for item in review["inquiries"]:
        ids = item.get("faq_entry_seqs", [])  # v1 확정 판정은 새 사례로 소급 변환하지 않는다.
        if item["outcome"] != "ANSWERED" or not ids:
            continue
        q, a = item["customer_index"], item["agent_index"]
        for index, speaker in ((q, "CUSTOMER"), (a, "AI")):
            utter = utterances.get(orders.get(index))
            if (utter is None or utter["speaker"] != speaker
                    or utter["utteranceText"] != evidence["transcript"][index]["text"][:20000]):
                raise ReviewError("FAQ_UTTERANCE_NOT_IN_PAYLOAD")
        if (item["question_text"] not in utterances[orders[q]]["utteranceText"]
                or any(ref["answer_quote"] not in utterances[orders[a]]["utteranceText"]
                       for ref in item.get("used_evidence", []))):
            raise ReviewError("FAQ_QUOTE_NOT_TRANSMITTED")
        # 계약은 부분 질문이 아니라 고객 UTTERANCE 전체를 사례로 저장한다.
        groups.setdefault((q, a), set()).update(ids)
    next_order = max((e["eventOrder"] for e in events), default=0)
    for (q, a), ids in sorted(groups.items()):
        if len(ids) > 100:
            raise ReviewError("TOO_MANY_FAQ_REFERENCES")
        ts = evidence["transcript"][a]["t"]
        next_order += 1
        events.append({"eventId": str(uuid.uuid5(NAMESPACE, f"{session_id}:faq-answered:{q}:{a}")),
                       "eventOrder": next_order, "kind": "BUSINESS_RESULT",
                       "occurredAt": datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds"),
                       "offsetSeconds": max(0, int(ts - started_t)),
                       "payload": {"action": "FAQ_ANSWERED", "orderSeq": None, "unansweredQuestionSeq": None,
                                   "summaryText": "FAQ 근거로 문의 안내 완료", "faqEntrySeqs": sorted(ids),
                                   "questionUtteranceOrder": orders[q], "answerUtteranceOrder": orders[a]}})
    return events
