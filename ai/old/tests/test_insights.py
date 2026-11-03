"""통화 기록·분석 전송(spec/insights.md): 이벤트 모양·순서·나누기·재전송, 결과 코드, 실패 처리."""

import json
import uuid

import httpx2
from conftest import CALLER, make_call, run
from test_flow import play, saved_db, steps

from app import insights
from app.backend_api import BackendAPI, BackendError


def finished_order():
    db = saved_db()
    call = play(db, steps("1"))  # 등록 고객 접수 완료(ACCEPTED)
    call.add_transcript("agent", "안녕하세요. 디바콜입니다.")
    call.add_transcript("customer", "택배 보내려고요")
    call.add_transcript("customer", "   ")  # 빈 말은 보내지 않는다(같은 말풍선에 붙는다)
    call.persona_version = 7
    call.end("hangup")
    return db, call


def test_order_call_events_and_analysis():
    db, call = finished_order()
    run(insights.send(call))
    events = [db.events[call.call_session_seq][i] for i in sorted(db.events[call.call_session_seq])]
    assert [e["eventOrder"] for e in events] == list(range(1, len(events) + 1))
    kinds = {(e["kind"], e["payload"].get("action")) for e in events}
    assert {("AI_ACTION", "CUSTOMER_LOOKUP"), ("AI_ACTION", "FIELD_SAVED"), ("AI_ACTION", "ORDER_SUBMITTED"),
            ("BUSINESS_RESULT", "ORDER_CREATED")} <= kinds
    said = [e["payload"] for e in events if e["kind"] == "UTTERANCE"]
    assert [(p["utteranceOrder"], p["speaker"], p["utteranceText"]) for p in said] == [
        (1, "AI", "안녕하세요. 디바콜입니다."), (2, "CUSTOMER", "택배 보내려고요   ")]
    for e in events:
        uuid.UUID(e["eventId"])
        assert e["occurredAt"].endswith("+00:00") and (e["offsetSeconds"] is None or e["offsetSeconds"] >= 0)
        assert "arguments" not in json.dumps(e)
    saved = next(e["payload"] for e in events if e["payload"].get("action") == "FIELD_SAVED")
    assert saved["summaryText"].startswith("기록: ") and saved["orderSeq"] is None
    created = next(e["payload"] for e in events if e["payload"].get("action") == "ORDER_CREATED")
    assert created["orderSeq"] == call.result["orderSeq"] and created["unansweredQuestionSeq"] is None
    analysis = db.analyses[call.call_session_seq]
    assert analysis["result"] == "REGISTERED" and analysis["aiPersonaVersionSeq"] == 7
    assert analysis["providerCallId"] == call.session_id and analysis["endedAt"] >= analysis["startedAt"]
    assert (analysis["repeatQuestionCount"], analysis["hasComplaint"], analysis["complaints"]) == (None, None, [])
    # 다시 보내도 같은 eventId·내용(백엔드는 204, 가짜는 충돌 없음)
    run(insights.send(call))
    assert not call.errors


def test_result_codes():
    call = make_call()
    call.end("hangup")
    assert insights.analysis_result(call) == "INQUIRY"
    call.order.receiver_name = "이영희"
    assert insights.analysis_result(call) == "REGISTRATION_FAILED"
    call.tool_calls["c"] = {"name": "cancel_order", "status": "done", "arguments": '{"order_seq": 3}',
                            "output": {"ok": True, "order_seq": 3}, "started": call.started_at}
    call.order.receiver_name = None
    assert insights.analysis_result(call) == "CANCELLED"
    business = [e["payload"] for e in insights.build_events(call) if e["kind"] == "BUSINESS_RESULT"]
    assert business == [{"action": "ORDER_CANCELLED", "unansweredQuestionSeq": None, "summaryText": "택배 취소",
                         "orderSeq": 3}]
    call.request_refer()
    assert insights.analysis_result(call) == "HANDOFF"


def test_batches_split_by_count_and_size():
    call = make_call()
    for i in range(60):
        call.add_transcript("customer" if i % 2 else "agent", "가" * 3000)
    events = insights.build_events(call)
    out = insights.batches(call, events)
    assert len(events) == 62  # 고객 확인 + 발화 60 + 문의 결과
    assert [e for b in out for e in b["events"]] == events and all(len(b["events"]) <= 50 for b in out)
    assert all(len(json.dumps(b, ensure_ascii=False).encode()) <= insights.MAX_BYTES for b in out)


def test_no_session_or_disabled_skips():
    call = make_call()
    call.backend.insights_enabled = False
    call.end("hangup")
    run(insights.send(call))
    assert not call.backend.events


def test_backend_client_token_retry_and_conflict():
    seen = []
    replies = iter([httpx2.Response(503), httpx2.Response(204), httpx2.Response(409, json={"error": {"code": "EVENT_PAYLOAD_CONFLICT"}})])

    def handler(request):
        seen.append((request.url.path, request.headers.get("authorization")))
        return next(replies)

    api = BackendAPI("http://backend", 1, transport=httpx2.MockTransport(handler), retry_interval_sec=0.01,
                     insights_token="insight-token", persona_token="persona-token")
    run(api.send_call_events(12, {"providerCallId": "x", "events": []}))
    assert seen == [("/api/ai/calls/12/events", "Bearer insight-token")] * 2  # 5xx는 다시
    try:
        run(api.send_call_analysis(12, {}))
        raise AssertionError("409는 실패")
    except BackendError as e:
        assert "EVENT_PAYLOAD_CONFLICT" in str(e)


def test_send_failure_is_logged_not_raised():
    db, call = finished_order()

    async def broken(seq, body):
        raise BackendError("/events 500")

    db.send_call_events = broken
    run(insights.send(call))
    assert any("통화 기록 전송 실패" in e["message"] for e in call.errors)
    assert CALLER not in json.dumps(insights.build_analysis(call))
