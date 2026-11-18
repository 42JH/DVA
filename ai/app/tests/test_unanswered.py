"""S15P31D109-159. 실제 API 호출 없이 판정 검증·종료 경로·재시작을 검증한다."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from conftest import run

from app.calls.results import ResultService
from app.calls.unanswered import (Inquiry, ReviewDecision, ReferencedDecision, ReviewError, UnansweredReviewer,
                                  apply_review, evidence_from_session, validate_decision)
from app.tests.test_domain import P, fare, filled
from app.tests.test_results import service, session
from app.integrations.backend.gateway import BackendGateway
from app.persistence.outbox import Outbox


def evidence(status="ok"):
    return {"transcript": [
        {"speaker": "customer", "text": "기사님 성별을 지정할 수 있나요?", "t": 1001.0},
        {"speaker": "agent", "text": "해당 사항은 확인 후 안내드리겠습니다.", "t": 1003.0}],
        "searches": [{"at": 1002.0, "arguments": '{"question":"기사님 성별"}',
                      "output": {"status": status, "code": "KB_UNAVAILABLE" if status == "unavailable" else None,
                                 "facts": {"answerable": status == "ok"}}}]}


def decision(outcome="UNANSWERED", **changes):
    return ReviewDecision(inquiries=[Inquiry(**({"customer_index": 0,
        "question_text": "기사님 성별을 지정할 수 있나요?", "tool_indices": [0], "outcome": outcome,
        "agent_index": 1, "agent_quote": "확인 후 안내드리겠습니다."} | changes))])


@pytest.mark.parametrize("status,reason", [("ok", "KB_NO_ANSWER"), ("unavailable", "KB_UNAVAILABLE")])
def test_reason_follows_search_status_not_answerable(status, reason):
    result = validate_decision(evidence(status), decision())
    assert result["inquiries"][0]["reason"] == reason


@pytest.mark.parametrize("changes,code", [
    ({"customer_index": 1}, "INVALID_CUSTOMER_REFERENCE"),
    ({"question_text": "만들어낸 질문"}, "INVALID_QUESTION_QUOTE"),
    ({"agent_quote": "없는 답변"}, "INVALID_AGENT_QUOTE"),
    ({"tool_indices": [9]}, "INVALID_SEARCH_REFERENCE"),
    ({"tool_indices": [0, 0]}, "DUPLICATE_OR_MISSING_INQUIRY"),
])
def test_rejects_hallucinated_or_invalid_references(changes, code):
    with pytest.raises(ReviewError, match=code):
        validate_decision(evidence(), decision(**changes))


def test_later_answer_resolves_failure_and_counts_one_inquiry():
    e = evidence("unavailable")
    e["transcript"].append({"speaker": "agent", "text": "지정은 불가합니다.", "t": 1005.0})
    e["searches"].append({"at": 1004.0, "output": {"status": "ok"}})
    d = decision("ANSWERED", tool_indices=[0, 1], agent_index=2, agent_quote="지정은 불가합니다.")
    result = validate_decision(e, d)
    p = apply_review("sid", 1000, e, {"analysis": {"faqAnswerCount": 2}}, result)
    assert p["unanswered"] == [] and p["analysis"]["faqAnswerCount"] == 1


@pytest.mark.parametrize("outcome", ["UNKNOWN", "CLARIFICATION"])
def test_uncertain_or_clarification_is_not_reported(outcome):
    result = validate_decision(evidence(), decision(outcome, agent_index=None, agent_quote=None))
    assert apply_review("s", 1000, evidence(), {"analysis": {}}, result)["unanswered"] == []


def test_requires_full_search_coverage_and_no_duplicate_inquiry():
    with pytest.raises(ReviewError, match="INCOMPLETE_SEARCH_COVERAGE"):
        validate_decision(evidence(), ReviewDecision(inquiries=[]))
    d = decision()
    d.inquiries *= 2
    with pytest.raises(ReviewError, match="DUPLICATE_OR_MISSING_INQUIRY"):
        validate_decision(evidence(), d)


def test_ids_and_customer_timestamp_stay_stable_and_input_is_immutable():
    e = evidence()
    p = {"analysis": {"faqAnswerCount": 9}, "unanswered": []}
    first = apply_review("s", 1000, e, p, validate_decision(e, decision()))
    second = apply_review("s", 1000, e, p, validate_decision(e, decision()))
    assert first == second and p["analysis"]["faqAnswerCount"] == 9
    [u] = first["unanswered"]
    assert u["offsetSeconds"] == 1 and u["occurredAt"].endswith("16:41.000+00:00")
    assert u["reason"] == "KB_NO_ANSWER"


class FakeClient:
    def __init__(self, result=None, status="completed"):
        self.responses = self
        self.result, self.status, self.calls = result, status, []

    def with_options(self, **kwargs):
        assert kwargs["max_retries"] == 0
        return self

    async def parse(self, **kwargs):
        self.calls.append(kwargs)
        result = self.result
        if isinstance(result, ReviewDecision):  # 기존 숫자 fixture를 명시적 ref를 선택하는 가짜 모델 출력으로 변환
            data = json.loads(kwargs["input"][1]["content"])
            def ref(rows, index):
                return rows[index]["ref"] if 0 <= index < len(rows) else "unknown-ref"
            result = ReferencedDecision.model_validate({"inquiries": [{
                "customer_ref": ref(data["transcript"], r.customer_index), "question_text": r.question_text,
                "search_refs": [ref(data["searches"], j) for j in r.tool_indices], "outcome": r.outcome,
                "agent_ref": ref(data["transcript"], r.agent_index) if r.agent_index is not None else None,
                "agent_quote": r.agent_quote, "used_evidence": [{"search_ref": ref(data["searches"], e.search_index),
                    "chunk_id": e.chunk_id, "evidence_quote": e.evidence_quote, "answer_quote": e.answer_quote}
                    for e in r.used_evidence]} for r in result.inquiries]})
        return SimpleNamespace(output_parsed=result, status=self.status)


def reviewer(client, **kw):
    return UnansweredReviewer(client, "test-model", "검토 지시", timeout_sec=1,
                              max_input_chars=kw.get("max_input_chars", 10000), max_output_tokens=1000)


def test_structured_adapter_sends_only_evidence_and_rejects_refusal():
    client = FakeClient(decision())
    result = run(reviewer(client).review(evidence()))
    assert result["inquiries"][0]["reason"] == "KB_NO_ANSWER"
    assert client.calls[0]["store"] is False and client.calls[0]["text_format"] is ReferencedDecision
    with pytest.raises(ReviewError, match="REVIEW_NOT_COMPLETED"):
        run(reviewer(FakeClient()).review(evidence()))
    with pytest.raises(ReviewError, match="REVIEW_INPUT_TOO_LARGE"):
        run(reviewer(client, max_input_chars=10).review(evidence()))


def reviewed_session(db):
    from app.tests.test_results import CALLER, INCOMING_AT
    st = filled()
    st.intent = "inquiry"
    ctx = run(db.caller_context(CALLER, {"providerCallId": "live_1", "incomingAt": INCOMING_AT}))
    st.customer.call_session_seq = ctx.call_session_seq
    s = session(st)
    e = evidence()
    s.transcript = [r | {"id": i} for i, r in enumerate(e["transcript"])]
    s.tool_calls = [r | {"name": "search_manual"} for r in e["searches"]]
    return s


def test_finish_does_not_wait_for_judge_and_persists_before_running(tmp_path):
    rs, db = service(tmp_path)
    s = reviewed_session(db)

    class Slow:
        async def review(self, e):
            await asyncio.Event().wait()

    rs.reviewer = Slow()

    async def scenario():
        await asyncio.wait_for(rs.finish(s), 1)
        assert rs.outbox.review(s.call_id)["input"]["evidence"] == evidence_from_session(s)
        assert db.unanswered == {} and db.analyses == {}
        await rs.drain()

    run(scenario())
    assert rs.outbox.review(s.call_id)["status"] == "PENDING"


def test_contract_gate_and_restart_reuse_fixed_verdict_and_body(tmp_path):
    rs, db = service(tmp_path)
    s = reviewed_session(db)
    client = FakeClient(decision())
    rs.reviewer = reviewer(client)

    async def prepare():
        await rs.finish(s)
        await asyncio.gather(*rs.background)

    run(prepare())
    saved = rs.outbox.review(s.call_id)
    assert saved["status"] == "DONE" and saved["result"]["model"] == "test-model"
    assert db.unanswered == {} and db.events and db.analyses
    rs.outbox.close()
    rs2 = ResultService(BackendGateway(db), Outbox(tmp_path / "outbox.sqlite3"), P, fare,
                        reviewer=reviewer(client), reason_contract_enabled=True)
    run(rs2.recover())
    run(rs2.recover())
    assert len(client.calls) == 1 and len(db.unanswered) == 1
    [u] = db.unanswered.values()
    assert u["body"] == saved["prepared"]["unanswered"][0] | {
        "callSessionSeq": saved["call_session_seq"], "providerCallId": s.call_id}
    assert db.analyses[saved["call_session_seq"]]["faqAnswerCount"] == 0
    assert rs2.outbox.review(s.call_id)["status"] == "DONE"


def test_failed_review_does_not_send_unverified_results_and_stops_retrying(tmp_path):
    rs, db = service(tmp_path)
    s = reviewed_session(db)
    client = FakeClient()  # 거절/결과 없음
    rs.reviewer, rs.review_max_attempts = reviewer(client), 2

    async def scenario():
        await rs.finish(s)
        await asyncio.gather(*rs.background)
        await rs.recover_reviews()
        await rs.recover_reviews()

    run(scenario())
    assert len(client.calls) == 2
    assert rs.outbox.review(s.call_id)["status"] == "FAILED"
    assert db.unanswered == {} and db.events
    assert db.analyses[s.state.customer.call_session_seq]["faqAnswerCount"] is None


def test_no_search_does_not_call_model_and_truncated_input_is_not_judged():
    client = FakeClient()
    assert run(reviewer(client).review({"transcript": [], "searches": []}))["inquiries"] == []
    e = evidence()
    e["transcript"] *= 150
    with pytest.raises(ReviewError, match="TRANSCRIPT_POSSIBLY_TRUNCATED"):
        run(reviewer(client).review(e))
    assert client.calls == []


def test_recovery_gate_does_not_send_reason_to_old_backend(tmp_path):
    rs, db = service(tmp_path)
    e = evidence()
    p = apply_review("s", 1000, e, {"analysis": {}, "events": [], "provider_call_id": "s"},
                     validate_decision(e, decision()))
    rs.outbox.create_insight("s", 1, p)
    run(rs.recover())
    assert db.unanswered == {} and rs.outbox.insight("s")["status"] == "PENDING"


def test_lost_ack_retries_same_unanswered_without_rejudging(tmp_path):
    from app.integrations.backend.gateway import BackendFailure
    from backend_client.mock import MockBackend

    class LostAck(MockBackend):
        unanswered_attempts = 0
        drop_ack = True

        async def send_unanswered(self, body):
            seq = await super().send_unanswered(body)
            self.unanswered_attempts += 1
            if self.drop_ack:
                raise BackendFailure("unavailable", "BE_TIMEOUT", "unanswered")
            return seq

    rs, db = service(tmp_path, LostAck())
    s = reviewed_session(db)
    client = FakeClient(decision())
    rs.reviewer, rs.reason_contract_enabled = reviewer(client), True

    async def scenario():
        await rs.finish(s)
        await asyncio.gather(*rs.background)
        assert rs.outbox.insight(s.call_id)["status"] == "PENDING"
        db.drop_ack = False
        await rs.recover_reviews()
        assert rs.outbox.insight(s.call_id)["status"] == "DONE"

    run(scenario())
    assert len(client.calls) == 1 and db.unanswered_attempts >= 2 and len(db.unanswered) == 1


def test_last_related_search_controls_reason_after_retry():
    e = evidence("unavailable")
    e["searches"].append({"at": 1002.5, "output": {"status": "ok", "facts": {"answerable": True}}})
    result = validate_decision(e, decision(tool_indices=[0, 1]))
    assert result["inquiries"][0]["reason"] == "KB_NO_ANSWER"


def test_unanswered_quote_before_final_retry_is_still_valid():
    e = evidence()
    e["searches"].append({"at": 1003.55, "output": {"status": "ok"}})
    result = validate_decision(e, decision(tool_indices=[0, 1]))
    assert result["inquiries"][0]["outcome"] == "UNANSWERED"
    assert result["inquiries"][0]["reason"] == "KB_NO_ANSWER"


@pytest.mark.parametrize("outcome,at", [("ANSWERED", 1003.55), ("UNANSWERED", 1000)])
def test_timing_guard_still_rejects_premature_answers(outcome, at):
    e = evidence()
    e["transcript"][1]["t"] = at
    if outcome == "ANSWERED":
        e["searches"].append({"at": 1004, "output": {"status": "ok"}})
    with pytest.raises(ReviewError, match="INVALID_AGENT_QUOTE"):
        validate_decision(e, decision(outcome, tool_indices=list(range(len(e["searches"])))))


def test_unanswered_retry_does_not_accept_invented_quote():
    e = evidence()
    e["searches"].append({"at": 1003.55, "output": {"status": "ok"}})
    with pytest.raises(ReviewError, match="INVALID_AGENT_QUOTE"):
        validate_decision(e, decision(tool_indices=[0, 1], agent_quote="확인되지 않은 새 문장"))
