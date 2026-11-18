"""통화228 회귀: 긴 전사의 명시 참조, 불량 검토 격리, 기본 기록/분석 독립 전송."""

import asyncio
import copy
import json

import pytest

from conftest import run

from app.calls.unanswered import (ReferencedDecision, evidence_from_session, model_evidence,
                                  UnansweredReviewer, apply_review, validate_referenced_decision)
from app.tests.test_faq_answer_evidence import ANSWER, QUESTION, decision, evidence, payload
from app.tests.test_results import service
from app.tests.test_unanswered import FakeClient, reviewer
from backend_client.api import BackendError
from backend_client.mock import MockBackend


@pytest.mark.parametrize("status,reason,summary", [
    ("ok", "KB_NO_ANSWER", "FAQ 답변 근거 없음"),
    ("unavailable", "KB_UNAVAILABLE", "지식 검색 장애로 답변하지 못함"),
])
def test_irrelevant_weather_search_retry_delivers_final_unanswered(tmp_path, status, reason, summary):
    e = evidence()
    e["transcript"][0]["text"] = "오늘 날씨 어때요?"
    e["transcript"][1]["text"] = "실시간 날씨는 확인해 드릴 수 없습니다."
    e["searches"][0]["output"]["status"] = status
    e["searches"].append(copy.deepcopy(e["searches"][0]) | {"at": 1005.55})
    rs, db = service(tmp_path)
    s, _ = payload(e, rs, db)
    d = wire(evidence_from_session(s))
    item = d.inquiries[0]
    item.question_text = e["transcript"][0]["text"]
    item.outcome = "UNANSWERED"
    item.agent_quote = e["transcript"][1]["text"]
    item.used_evidence = []
    item.search_refs = [r["ref"] for r in model_evidence(e)["searches"]]
    rs.reviewer = reviewer(FakeClient(d))
    rs.reason_contract_enabled = rs.faq_answered_enabled = True

    async def scenario():
        await rs.finish(s)
        await asyncio.gather(*rs.background)
        await rs.recover_reviews()

    run(scenario())
    seq = s.state.customer.call_session_seq
    events = list(db.events[seq].values())
    assert rs.outbox.insight(s.call_id)["status"] == "DONE"
    assert rs.outbox.review(s.call_id)["result"]["complete"] is True
    assert len(db.unanswered) == 1
    assert next(iter(db.unanswered.values()))["body"]["reason"] == reason
    assert any(x["payload"].get("action") == "QUESTION_UNANSWERED" and
               x["payload"]["summaryText"] == summary for x in events)
    assert not any(x["payload"].get("action") == "FAQ_ANSWERED" for x in events)
    assert db.analyses[seq]["faqAnswerCount"] == 0
    if status == "ok":
        assert [x["payload"]["summaryText"] for x in events if x["payload"].get("action") == "FAQ_SEARCH"] == [
            "FAQ 검색 후보 3건 반환", "FAQ 검색 후보 3건 반환"]


def wire(e):
    numbered = model_evidence(e)
    return ReferencedDecision.model_validate({"inquiries": [{
        "customer_ref": numbered["transcript"][0]["ref"], "question_text": QUESTION,
        "search_refs": [numbered["searches"][0]["ref"]], "outcome": "ANSWERED",
        "agent_ref": numbered["transcript"][1]["ref"], "agent_quote": ANSWER,
        "used_evidence": [{"search_ref": numbered["searches"][0]["ref"], "chunk_id": "payment",
                           "evidence_quote": "착불은 불가합니다.", "answer_quote": "착불은 불가합니다."},
                          {"search_ref": numbered["searches"][0]["ref"], "chunk_id": "delivery",
                           "evidence_quote": "배송은 2~3영업일 걸립니다.", "answer_quote": "배송은 2~3영업일 걸립니다."}]}]})


def test_model_input_has_stable_explicit_refs_and_preserves_source_ids():
    e = evidence()
    e["transcript"][0]["utterance_id"] = 87
    original = copy.deepcopy(e)
    numbered = model_evidence(e)
    assert numbered["transcript"][0]["ref"] == "u:87:0"
    assert numbered["searches"][0]["ref"] == "s:0" and e == original
    assert model_evidence(e) == numbered


def test_invalid_customer_ref_is_preserved_as_issue_not_unanswered():
    e = evidence()
    d = wire(e)
    d.inquiries[0].customer_ref = model_evidence(e)["transcript"][1]["ref"]  # 실제 AI 행
    result = validate_referenced_decision(e, model_evidence(e), d)
    assert result["complete"] is False and result["inquiries"] == []
    assert any(i["code"] == "INVALID_CUSTOMER_REFERENCE" for i in result["issues"])


def test_unknown_ref_does_not_get_guessed_from_text():
    e = evidence()
    d = wire(e)
    d.inquiries[0].customer_ref = "u:not-in-source"
    result = validate_referenced_decision(e, model_evidence(e), d)
    assert result["inquiries"] == [] and result["complete"] is False
    assert result["issues"][0]["code"] == "UNKNOWN_UTTERANCE_REF"


def test_one_bad_citation_does_not_drop_valid_answer_or_other_faq():
    e = evidence()
    d = wire(e)
    d.inquiries[0].used_evidence[0].evidence_quote = "잘못 만들어 낸 문장"
    result = validate_referenced_decision(e, model_evidence(e), d)
    assert result["complete"] is True
    assert result["inquiries"][0]["faq_entry_seqs"] == [18]
    assert result["issues"][0]["code"] == "INVALID_EVIDENCE_QUOTE"


def test_one_bad_inquiry_keeps_valid_inquiry_and_confirmed_count():
    e = evidence()
    d = wire(e)
    bad = d.inquiries[0].model_copy(deep=True)
    bad.customer_ref = "missing"
    d.inquiries.append(bad)
    result = validate_referenced_decision(e, model_evidence(e), d)
    assert result["complete"] is False and len(result["inquiries"]) == 1
    assert result["inquiries"][0]["faq_entry_seqs"] == [12, 18]
    assert apply_review("partial", 1000, e, {"analysis": {}}, result)["analysis"]["faqAnswerCount"] == 1


def test_three_confirmed_answers_survive_one_question_spacing_error(tmp_path):
    e = evidence()
    original_transcript, original_search = copy.deepcopy(e["transcript"]), copy.deepcopy(e["searches"][0])
    e["transcript"], e["searches"] = [], []
    for i in range(3):
        e["transcript"].extend(r | {"t": r["t"] + i * 10} for r in original_transcript)
        e["searches"].append(copy.deepcopy(original_search) | {"at": 1002 + i * 10})
    e["transcript"].append({"speaker": "customer", "text": "무인지점에서 보내도?", "t": 1030})
    rs, db = service(tmp_path)
    s, _ = payload(e, rs, db)
    numbered = model_evidence(evidence_from_session(s))
    first = wire(evidence_from_session(s)).inquiries[0]
    inquiries = []
    for i in range(3):
        item = first.model_copy(deep=True)
        item.customer_ref = numbered["transcript"][i * 2]["ref"]
        item.agent_ref = numbered["transcript"][i * 2 + 1]["ref"]
        item.search_refs = [numbered["searches"][i]["ref"]]
        for citation in item.used_evidence:
            citation.search_ref = item.search_refs[0]
        inquiries.append(item)
    bad = first.model_copy(deep=True)
    bad.customer_ref = numbered["transcript"][6]["ref"]
    bad.question_text = "무인 지점에서 보내도?"
    inquiries.append(bad)
    rs.reviewer = reviewer(FakeClient(ReferencedDecision(inquiries=inquiries)))
    rs.reason_contract_enabled = rs.faq_answered_enabled = True

    async def scenario():
        await rs.finish(s)
        await asyncio.gather(*rs.background)

    run(scenario())
    review = rs.outbox.review(s.call_id)["result"]
    assert review["complete"] is False
    assert any(issue["code"] == "INVALID_QUESTION_QUOTE" for issue in review["issues"])
    seq = s.state.customer.call_session_seq
    assert db.analyses[seq]["faqAnswerCount"] == 3
    assert sum(event["payload"].get("action") == "FAQ_ANSWERED" for event in db.events[seq].values()) == 3
    assert db.unanswered == {}


def test_bad_quote_is_audited_privately_and_valid_faq_is_delivered(tmp_path, caplog):
    rs, db = service(tmp_path)
    s, _ = payload(evidence(), rs, db)
    d = wire(evidence_from_session(s))
    d.inquiries[0].used_evidence[0].evidence_quote = "PRIVATE_BAD_QUOTE"
    client = FakeClient(d)
    rs.reviewer, rs.reason_contract_enabled, rs.faq_answered_enabled = reviewer(client), True, True

    async def scenario():
        await rs.finish(s)
        await asyncio.gather(*rs.background)

    run(scenario())
    review = rs.outbox.review(s.call_id)
    attempts = rs.outbox.review_attempts(s.call_id)
    assert review["status"] == "DONE" and len(attempts) == 1
    assert attempts[0]["result"]["raw_decision"]["inquiries"][0]["used_evidence"][0]["evidence_quote"] == "PRIVATE_BAD_QUOTE"
    assert "PRIVATE_BAD_QUOTE" not in caplog.text
    events = db.events[s.state.customer.call_session_seq].values()
    [answered] = [e for e in events if e["payload"].get("action") == "FAQ_ANSWERED"]
    assert answered["payload"]["faqEntrySeqs"] == [18]
    assert db.analyses[s.state.customer.call_session_seq]["faqAnswerCount"] == 1


def long_evidence():
    e = evidence()
    speakers = ["agent", "agent", "customer", "agent", "customer", "agent", "customer", "customer",
                "agent", "agent", "customer", "agent", "customer", "agent", "agent", "customer",
                "agent", "customer", "agent", "customer", "agent", "agent", "agent", "customer",
                "customer", "agent", "agent", "customer", "agent", "agent", "customer", "agent"]
    e["transcript"] = [{"speaker": v, "text": f"가상 발화 {i}", "t": 1000 + i} for i, v in enumerate(speakers)]
    e["transcript"][2]["text"], e["transcript"][9]["text"] = QUESTION, ANSWER
    e["searches"] = [copy.deepcopy(e["searches"][0]) | {"at": 1003 + i} for i in range(4)]
    return e


def test_32_utterances_4_searches_base_sent_while_model_is_still_waiting(tmp_path):
    rs, db = service(tmp_path)
    s, _ = payload(long_evidence(), rs, db)

    class Waiting:
        async def review(self, e):
            await release.wait()
            return {"inquiries": [], "complete": False, "issues": [{"code": "TEST_UNCERTAIN"}]}

    rs.reviewer, rs.reason_contract_enabled = Waiting(), True

    async def scenario():
        nonlocal release
        release = asyncio.Event()
        await rs.finish(s)
        async def records_received():
            while not db.events.get(s.state.customer.call_session_seq):
                await asyncio.sleep(0.01)
        await asyncio.wait_for(records_received(), 1)
        events = db.events[s.state.customer.call_session_seq].values()
        assert sum(e["kind"] == "UTTERANCE" for e in events) == 32
        assert db.analyses == {}  # 분석은 아직 미확정. 전사는 보임.
        release.set()
        await asyncio.gather(*rs.background)
        assert db.analyses[s.state.customer.call_session_seq]["faqAnswerCount"] is None

    release = None
    run(scenario())


def test_32_row_ref_selection_is_valid_without_counting_the_model_output():
    e = long_evidence()
    numbered = model_evidence(e)
    d = wire(evidence())
    d.inquiries[0].customer_ref = numbered["transcript"][2]["ref"]
    d.inquiries[0].agent_ref = numbered["transcript"][9]["ref"]
    d.inquiries[0].search_refs = [r["ref"] for r in numbered["searches"]]
    result = validate_referenced_decision(e, numbered, d)
    assert result["complete"] is True and result["inquiries"][0]["customer_index"] == 2
    assert result["inquiries"][0]["agent_index"] == 9


def test_exhausted_review_delivers_base_analysis_and_metrics_without_fabricated_faq(tmp_path):
    rs, db = service(tmp_path)
    s, _ = payload(long_evidence(), rs, db)
    client = FakeClient()  # 거절/구조화 결과 없음
    rs.reviewer, rs.reason_contract_enabled = reviewer(client), True

    async def scenario():
        await rs.finish(s)
        await asyncio.gather(*rs.background)
        await rs.recover_reviews()
        await rs.recover_reviews()

    run(scenario())
    assert len(client.calls) == 3 and rs.outbox.review(s.call_id)["status"] == "FAILED"
    assert rs.outbox.insight(s.call_id)["status"] == "DONE"
    events = db.events[s.state.customer.call_session_seq].values()
    assert sum(e["kind"] == "UTTERANCE" for e in events) == 32
    assert all(e["payload"].get("action") not in ("FAQ_ANSWERED", "QUESTION_UNANSWERED") for e in events)
    assert db.analyses[s.state.customer.call_session_seq]["faqAnswerCount"] is None and db.unanswered == {}
    assert len(rs.outbox.review_attempts(s.call_id)) == 3
    prepared = rs.outbox.review(s.call_id)["prepared"]
    run(rs.recover())
    assert len(client.calls) == 3 and rs.outbox.review(s.call_id)["prepared"] == prepared


def test_faq_event_rejection_does_not_block_analysis_or_dashboard(tmp_path):
    class RejectFaq(MockBackend):
        async def send_call_events(self, seq, body):
            if any(e["payload"].get("action") == "FAQ_ANSWERED" for e in body["events"]):
                raise BackendError("invalid FAQ", 400, "INVALID_REQUEST")
            await super().send_call_events(seq, body)

    rs, db = service(tmp_path, RejectFaq())
    s, _ = payload(evidence(), rs, db)
    rs.reviewer, rs.reason_contract_enabled, rs.faq_answered_enabled = reviewer(FakeClient(decision())), True, True

    async def scenario():
        await rs.finish(s)
        await asyncio.gather(*rs.background)

    run(scenario())
    row = rs.outbox.insight(s.call_id)
    assert row["status"] == "FAILED" and row["progress"]["review_events"] == "failed"
    assert row["progress"]["base"] == row["progress"]["analysis"] == "done"
    assert db.analyses[s.state.customer.call_session_seq]["faqAnswerCount"] == 1
    assert (s.state.customer.call_session_seq, "response-wait-metrics") in db.dashboard


def test_legacy_failed_job_is_not_requeued_without_operator_action(tmp_path):
    rs, db = service(tmp_path)
    s, p = payload(evidence(), rs, db)
    rs.outbox.create_review(s.call_id, s.state.customer.call_session_seq,
                            {"started_t": 1000, "evidence": evidence(), "payload": p})
    rs.outbox.update_review(s.call_id, "FAILED", "INVALID_CUSTOMER_REFERENCE")
    client = FakeClient(decision())
    rs.reviewer = reviewer(client)
    run(rs.recover())
    assert client.calls == [] and db.events == {} and rs.outbox.insight(s.call_id) is None


def test_analysis_outage_does_not_resend_base_or_rerun_judge(tmp_path):
    class DownAnalysis(MockBackend):
        offline = True

        def __init__(self):
            super().__init__()
            self.event_requests, self.analysis_requests = [], []

        async def send_call_events(self, seq, body):
            self.event_requests.append(copy.deepcopy(body))
            await super().send_call_events(seq, body)

        async def send_call_analysis(self, seq, body):
            self.analysis_requests.append(copy.deepcopy(body))
            if self.offline:
                raise BackendError("temporary outage", 503, "DEPENDENCY_UNAVAILABLE")
            await super().send_call_analysis(seq, body)

    rs, db = service(tmp_path, DownAnalysis())
    s, _ = payload(evidence(), rs, db)
    client = FakeClient(decision())
    rs.reviewer, rs.reason_contract_enabled, rs.faq_answered_enabled = reviewer(client), True, True

    async def scenario():
        await rs.finish(s)
        await asyncio.gather(*rs.background)
        assert rs.outbox.insight(s.call_id)["status"] == "PENDING"
        event_count = len(db.event_requests)
        db.offline = False
        await rs.recover()
        assert rs.outbox.insight(s.call_id)["status"] == "DONE"
        assert len(db.event_requests) == event_count

    run(scenario())
    assert len(client.calls) == 1 and all(p == db.analysis_requests[0] for p in db.analysis_requests)
    assert db.analyses[s.state.customer.call_session_seq] == db.analysis_requests[0]


def test_model_timeout_exhaustion_also_delivers_analysis(tmp_path):
    class NeverAnswers(FakeClient):
        async def parse(self, **kwargs):
            self.calls.append(kwargs)
            await asyncio.Event().wait()

    rs, db = service(tmp_path)
    s, _ = payload(evidence(), rs, db)
    client = NeverAnswers()
    rs.reviewer = UnansweredReviewer(client, "test-model", "검토", timeout_sec=0.01,
                                     max_input_chars=10000, max_output_tokens=1000)

    async def scenario():
        await rs.finish(s)
        await asyncio.gather(*rs.background)
        await rs.recover_reviews()
        await rs.recover_reviews()

    run(scenario())
    assert len(client.calls) == 3 and db.events
    assert rs.outbox.review(s.call_id)["status"] == "FAILED"
    assert db.analyses[s.state.customer.call_session_seq]["faqAnswerCount"] is None
    assert all(r["error"] == "TimeoutError" for r in rs.outbox.review_attempts(s.call_id))


def test_partial_review_bad_customer_still_delivers_records_with_unknown_count(tmp_path):
    rs, db = service(tmp_path)
    s, _ = payload(evidence(), rs, db)
    d = wire(evidence_from_session(s))
    d.inquiries[0].customer_ref = "missing"
    client = FakeClient(d)
    rs.reviewer, rs.reason_contract_enabled, rs.faq_answered_enabled = reviewer(client), True, True

    async def scenario():
        await rs.finish(s)
        await asyncio.gather(*rs.background)

    run(scenario())
    assert len(client.calls) == 1 and rs.outbox.insight(s.call_id)["status"] == "DONE"
    assert db.events and db.analyses[s.state.customer.call_session_seq]["faqAnswerCount"] is None
    assert db.unanswered == {} and not any(e["payload"].get("action") == "FAQ_ANSWERED"
                                         for e in db.events[s.state.customer.call_session_seq].values())
    assert rs.outbox.review_attempts(s.call_id)[0]["result"]["issues"]


def test_unknown_outcome_is_not_reported_as_confirmed_zero():
    e = evidence()
    d = wire(e)
    d.inquiries[0].outcome = "UNKNOWN"
    d.inquiries[0].agent_ref = d.inquiries[0].agent_quote = None
    d.inquiries[0].used_evidence = []
    result = validate_referenced_decision(e, model_evidence(e), d)
    assert result["complete"] is False and result["inquiries"][0]["outcome"] == "UNKNOWN"
    assert apply_review("unknown", 1000, e, {"analysis": {}}, result)["analysis"]["faqAnswerCount"] is None
