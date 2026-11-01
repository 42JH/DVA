"""통화 기록을 백엔드로(spec/insights.md): 받아쓰기·도구 실행·처리 결과(EVT-01 events)와 통화 결과 분석(ANL-01 analysis).

통화가 끝나고 결과(POST /api/orders)를 보낸 뒤 한 번 보낸다. 끝난 뒤라 받아쓰기는 다 완결된 말이다.
eventId는 통화·순번으로 정해지는 UUID라 다시 만들어도 같고, 같은 묶음 재전송은 백엔드가 204로 받는다.
불만·되묻기 판정은 아직 하지 않는다(null = 미판정).
"""

import json
import logging
import uuid
from datetime import datetime, timezone

from app.backend_api import BackendError

log = logging.getLogger(__name__)

NAMESPACE = uuid.UUID("6f1d3c52-6a59-4c4c-9a39-4b7c5f0f2d11")  # eventId = uuid5(이 값, 통화 ID:순번)
MAX_EVENTS = 50  # 요청당 이벤트 수(백엔드 1~50)
MAX_BYTES = 90 * 1024  # 요청 본문(백엔드 100KiB, 여유를 둔다)
MAX_TEXT = 1000  # summaryText

# 도구 → AI 동작 코드. get_state(상태 확인)·modify_order(보류)·판별기는 보내지 않는다
ACTIONS = {"match_pins": "PIN_SEARCH", "lookup_orders": "PREVIOUS_ORDER_SEARCH", "search_manual": "FAQ_SEARCH",
           "record_order": "FIELD_SAVED", "cancel_order": "ORDER_CANCELLED"}
# 백엔드가 주문을 저장한 결과(접수 시도). 결제·디버 접수 완료와는 별개
SAVED = ("ACCEPTED", "notPaid", "PAID", "SUBMITTING", "SUBMISSION_FAILED")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds")


def _offset(call, ts: float) -> int | None:
    return max(0, int(ts - call.started_at)) if ts else None


def _seq(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 < value <= 2147483647 else None


def _cancelled(call) -> list[dict]:
    return [r for r in call.tool_calls.values() if r.get("name") == "cancel_order" and r.get("status") == "done"]


def _summary(call, rec: dict) -> str:
    """도구 결과 한 줄. 인수 원문·개인정보(이름·번호·주소)는 넣지 않는다."""
    out = rec.get("output") or {}
    name = rec.get("name")
    if not out.get("ok"):
        return f"실패: {out.get('error') or '결과 없음'}"[:MAX_TEXT]
    if name == "record_order":
        labels = call.texts.labels
        names = dict.fromkeys(labels.get(f, labels.get("item", f)) if f.endswith("_count") or f == "other_item"
                              else labels.get(f, f) for f in out.get("recorded") or [])
        return ("기록: " + ", ".join(names))[:MAX_TEXT] if names else "기록할 값 없음"
    if name == "match_pins":
        return f"주소록 후보 {out.get('found', 0)}건"
    if name == "lookup_orders":
        return "주문 조회 실패" if out.get("failed") else f"택배 {out.get('found', 0)}건 찾음"
    if name == "search_manual":
        return "FAQ 근거 있음" if "rag.found" in (rec.get("events") or []) else "FAQ 근거 없음"
    if name == "cancel_order":
        return "이미 취소된 택배" if out.get("already_done") else "택배 취소"
    return "완료"


def analysis_result(call) -> str:
    """통화 종료 결과(ANL-01 result). AI가 확정한 것만: 상담원 전환 > 접수 > 취소 > 접수 실패 > 문의."""
    status = (call.result or {}).get("status")
    if call.refer_requested.is_set():
        return "HANDOFF"
    if call.result_body and call.result_body.get("outcome") == "COMPLETE":
        return "REGISTERED" if status in SAVED else "REGISTRATION_FAILED"
    if _cancelled(call):
        return "CANCELLED"
    if call.parcels or not call.order.empty():
        return "REGISTRATION_FAILED"  # 접수를 받다가 끝남(미완료)
    return "INQUIRY"


def build_events(call) -> list[dict]:
    """발화(UTTERANCE)·AI 동작(AI_ACTION)·처리 결과(BUSINESS_RESULT)를 시각 순으로. eventOrder는 통화 전체 순번."""
    rows: list[tuple[float, str, dict]] = []
    if call.call_session_seq:  # 고객 확인(통화 시작, accept 전)
        rows.append((call.started_at, "AI_ACTION", {
            "action": "CUSTOMER_LOOKUP", "summaryText": {"registered": "등록 고객", "withdrawn": "탈퇴 고객"}.get(
                call.customer_type, "미등록 고객"), "orderSeq": None}))
    utterance = 0
    for bubble in call.transcript:
        if not bubble["text"].strip():
            continue
        utterance += 1
        rows.append((bubble["at"], "UTTERANCE", {
            "utteranceOrder": utterance, "speaker": "CUSTOMER" if bubble["speaker"] == "customer" else "AI",
            "utteranceText": bubble["text"][:20000], "lastSentenceSeq": 1}))  # 말풍선 하나를 한 문장 구간으로 본다
    for rec in call.tool_calls.values():
        action = ACTIONS.get(rec.get("name"))
        if not action or rec.get("status") not in ("done", "error"):
            continue
        order_seq = _seq(json.loads(rec.get("arguments") or "{}").get("order_seq")) if action == "ORDER_CANCELLED" else None
        rows.append((rec.get("started") or call.started_at, "AI_ACTION", {
            "action": action, "summaryText": _summary(call, rec), "orderSeq": order_seq}))
    order_seq = _seq((call.result or {}).get("orderSeq"))
    end = call.ended_at or call.started_at
    if call.result_body:
        rows.append((end, "AI_ACTION", {"action": "ORDER_SUBMITTED", "orderSeq": order_seq, "summaryText":
                    f"통화 결과 {call.result_body['outcome']} 전송: {(call.result or {}).get('status') or '응답 없음'}"}))
    result = analysis_result(call)
    business = {"REGISTERED": ("ORDER_CREATED", "택배 접수 주문 저장"),
                "HANDOFF": ("HANDOFF_REQUESTED", "상담원 연결 요청"),
                "INQUIRY": ("INQUIRY", "문의 응대")}.get(result)
    if business:
        rows.append((end, "BUSINESS_RESULT", {"action": business[0], "orderSeq": order_seq if result == "REGISTERED" else None,
                                              "unansweredQuestionSeq": None, "summaryText": business[1]}))
    for rec in _cancelled(call):
        rows.append((end, "BUSINESS_RESULT", {
            "action": "ORDER_CANCELLED", "unansweredQuestionSeq": None, "summaryText": _summary(call, rec),
            "orderSeq": _seq(json.loads(rec.get("arguments") or "{}").get("order_seq"))}))
    rows.sort(key=lambda r: r[0])  # 같은 시각은 넣은 순서 유지
    return [{"eventId": str(uuid.uuid5(NAMESPACE, f"{call.session_id}:{i}")), "eventOrder": i, "kind": kind,
             "occurredAt": _iso(ts), "offsetSeconds": _offset(call, ts), "payload": payload}
            for i, (ts, kind, payload) in enumerate(rows, 1)]


def build_analysis(call) -> dict:
    ended = call.ended_at or call.started_at
    return {"providerCallId": call.session_id, "startedAt": _iso(call.started_at), "endedAt": _iso(ended),
            "aiPersonaVersionSeq": call.persona_version, "result": analysis_result(call),
            "repeatQuestionCount": None, "hasComplaint": None, "complaints": []}


def batches(call, events: list[dict]) -> list[dict]:
    """요청당 50개·본문 크기 제한 안으로 나눈다."""
    out: list[dict] = []
    current: list[dict] = []
    for event in events:
        body = {"providerCallId": call.session_id, "events": [*current, event]}
        if current and (len(body["events"]) > MAX_EVENTS or len(json.dumps(body, ensure_ascii=False).encode()) > MAX_BYTES):
            out.append({"providerCallId": call.session_id, "events": current})
            current = []
        current.append(event)
    if current:
        out.append({"providerCallId": call.session_id, "events": current})
    return out


async def send(call) -> None:
    """통화 기록·분석을 백엔드로. 통화 번호를 모르거나(고객 확인 실패) 연동이 꺼져 있으면 보내지 않는다. 실패는 로그만."""
    backend = call.backend
    if not call.call_session_seq or not getattr(backend, "insights_enabled", False):
        return
    try:
        for body in batches(call, build_events(call)):
            await backend.send_call_events(call.call_session_seq, body)
        await backend.send_call_analysis(call.call_session_seq, build_analysis(call))
        log.info("통화 기록 전송 %s", call.session_id)
    except BackendError as e:
        log.error("통화 기록 전송 실패 %s: %s", call.session_id, e)
        call.add_error(f"통화 기록 전송 실패: {e}")
