"""첨부 FAQ 사례 계약: 실제 전달 근거·발화 검증, 배열 이벤트, 영속 재전송."""

import asyncio
import copy
import json

import pytest
from conftest import run

from app.calls.results import ResultService, _batches
from app.calls.unanswered import Inquiry, ReviewDecision, ReviewError, UsedEvidence, apply_review, validate_decision
from app.integrations.backend.gateway import BackendFailure, BackendGateway
from app.persistence.outbox import Outbox
from app.tests.test_domain import P, fare
from app.tests.test_results import service
from app.tests.test_unanswered import FakeClient, reviewed_session, reviewer
from backend_client.mock import MockBackend


QUESTION = "착불도 되나요? 배송은 며칠 걸리나요?"
ANSWER = "착불은 불가합니다. 배송은 2~3영업일 걸립니다."


def evidence():
    return {"transcript": [{"speaker": "customer", "text": QUESTION, "t": 1001},
                           {"speaker": "agent", "text": ANSWER, "t": 1005}],
            "searches": [{"at": 1002, "arguments": json.dumps({"question": QUESTION}), "output": {
                "status": "ok", "facts": {"answerable": True, "context": {"evidence": [
                    {"rank": 1, "chunk_id": "unrelated", "source_id": "backend-faq:99", "content": "직접 포장해 주세요."},
                    {"rank": 2, "chunk_id": "payment", "source_id": "backend-faq:12", "content": "착불은 불가합니다."},
                    {"rank": 3, "chunk_id": "delivery", "source_id": "backend-faq:18", "content": "배송은 2~3영업일 걸립니다."}
                ]}}}}]}


def refs():
    return [UsedEvidence(search_index=0, chunk_id="payment", evidence_quote="착불은 불가합니다.", answer_quote="착불은 불가합니다."),
            UsedEvidence(search_index=0, chunk_id="delivery", evidence_quote="배송은 2~3영업일 걸립니다.", answer_quote="배송은 2~3영업일 걸립니다.")]


def decision(selected=None):
    return ReviewDecision(inquiries=[Inquiry(customer_index=0, question_text=QUESTION, tool_indices=[0],
        outcome="ANSWERED", agent_index=1, agent_quote=ANSWER, used_evidence=refs() if selected is None else selected)])


def payload(e, rs, db):
    s = reviewed_session(db)
    s.transcript = [r | {"id": i} for i, r in enumerate(e["transcript"])]
    s.tool_calls = [r | {"name": "search_manual"} for r in e["searches"]]
    return s, rs.build_insights(s)


def faq_events(p):
    return [e for e in p["events"] if e["payload"].get("action") == "FAQ_ANSWERED"]


def test_multi_faq_one_response_one_event_and_original_utterances(tmp_path):
    rs, db = service(tmp_path)
    e = evidence()
    s, p = payload(e, rs, db)
    original = copy.deepcopy(p)
    result = validate_decision(e, decision())
    out = apply_review(s.call_id, 1000, e, p, result, faq_answered_enabled=True)
    [event] = faq_events(out)
    assert event["payload"] == {"action": "FAQ_ANSWERED", "orderSeq": None, "unansweredQuestionSeq": None,
        "summaryText": "FAQ 답변 근거 있음", "faqEntrySeqs": [12, 18],
        "questionUtteranceOrder": 1, "answerUtteranceOrder": 2}
    assert event["offsetSeconds"] == 5 and event["occurredAt"].endswith("16:45.000+00:00")
    assert out["analysis"]["faqAnswerCount"] == 1 and p == original
    assert out["events"][:len(p["events"])] == p["events"]  # 기존 ID/순번/본문 유지
    assert out["events"][-1]["eventOrder"] == len(out["events"])


def test_single_faq_is_array_and_multiple_chunks_of_same_faq_deduplicate(tmp_path):
    rs, db = service(tmp_path)
    e = evidence()
    docs = e["searches"][0]["output"]["facts"]["context"]["evidence"]
    docs[2] = docs[1] | {"chunk_id": "payment-2"}
    chosen = [refs()[0], refs()[0].model_copy(update={"chunk_id": "payment-2"})]
    result = validate_decision(e, decision(chosen))
    s, p = payload(e, rs, db)
    out = apply_review(s.call_id, 1000, e, p, result, faq_answered_enabled=True)
    assert faq_events(out)[0]["payload"]["faqEntrySeqs"] == [12]


@pytest.mark.parametrize("update,code", [
    ({"search_index": 1}, "EVIDENCE_OUTSIDE_INQUIRY"),
    ({"chunk_id": "not-present"}, "UNKNOWN_EVIDENCE_REFERENCE"),
    ({"evidence_quote": "착불 가능합니다."}, "INVALID_EVIDENCE_QUOTE"),
    ({"answer_quote": "모델이 만들었지만 말하지 않은 문장"}, "INVALID_EVIDENCE_QUOTE"),
])
def test_rejects_invented_reference_or_quote(update, code):
    ref = refs()[0].model_copy(update=update)
    with pytest.raises(ReviewError, match=code):
        validate_decision(evidence(), decision([ref]))


@pytest.mark.parametrize("source", ["delivery_faq", "backend-faq:0", "backend-faq:-1", "backend-faq:2147483648"])
def test_rejects_non_backend_or_invalid_faq_id(source):
    e = evidence()
    e["searches"][0]["output"]["facts"]["context"]["evidence"][1]["source_id"] = source
    with pytest.raises(ReviewError, match="INVALID_BACKEND_FAQ_SOURCE"):
        validate_decision(e, decision([refs()[0]]))


def test_rejects_duplicate_refs_and_evidence_for_unanswered():
    with pytest.raises(ReviewError, match="DUPLICATE_EVIDENCE_REFERENCE"):
        validate_decision(evidence(), decision([refs()[0], refs()[0]]))
    d = decision()
    d.inquiries[0].outcome = "UNANSWERED"
    with pytest.raises(ReviewError, match="EVIDENCE_WITHOUT_ANSWER"):
        validate_decision(evidence(), d)


def test_shared_search_split_question_combines_into_one_pair_event(tmp_path):
    e = evidence()
    d = ReviewDecision(inquiries=[
        Inquiry(customer_index=0, question_text="착불도 되나요?", tool_indices=[0], outcome="ANSWERED",
                agent_index=1, agent_quote="착불은 불가합니다.", used_evidence=[refs()[0]]),
        Inquiry(customer_index=0, question_text="배송은 며칠 걸리나요?", tool_indices=[0], outcome="ANSWERED",
                agent_index=1, agent_quote="배송은 2~3영업일 걸립니다.", used_evidence=[refs()[1]])])
    result = validate_decision(e, d)
    rs, db = service(tmp_path)
    s, p = payload(e, rs, db)
    out = apply_review(s.call_id, 1000, e, p, result, faq_answered_enabled=True)
    assert len(faq_events(out)) == 1 and faq_events(out)[0]["payload"]["faqEntrySeqs"] == [12, 18]
    assert out["analysis"]["faqAnswerCount"] == 2  # 두 질문의 답변 수. 근거 수/이벤트 수와 구분


def test_empty_refs_and_feature_disabled_do_not_emit_faq_answer(tmp_path):
    rs, db = service(tmp_path)
    e = evidence()
    s, p = payload(e, rs, db)
    assert faq_events(apply_review(s.call_id, 1000, e, p, validate_decision(e, decision([])), faq_answered_enabled=True)) == []
    assert faq_events(apply_review(s.call_id, 1000, e, p, validate_decision(e, decision()))) == []


def test_blank_transcript_rows_do_not_shift_api_utterance_references(tmp_path):
    rs, db = service(tmp_path)
    e = evidence()
    q, a = e["transcript"]
    e["transcript"] = [q | {"text": "", "t": 1000}, q, a | {"text": " "}, a]
    d = decision()
    d.inquiries[0].customer_index, d.inquiries[0].agent_index = 1, 3
    s, p = payload(e, rs, db)
    out = apply_review(s.call_id, 1000, e, p, validate_decision(e, d), faq_answered_enabled=True)
    assert faq_events(out)[0]["payload"]["questionUtteranceOrder"] == 1
    assert faq_events(out)[0]["payload"]["answerUtteranceOrder"] == 2


def test_missing_transmitted_utterance_is_not_replaced_by_raw_index(tmp_path):
    rs, db = service(tmp_path)
    e = evidence()
    s, p = payload(e, rs, db)
    p["events"] = [row for row in p["events"] if row["kind"] != "UTTERANCE"]
    with pytest.raises(ReviewError, match="FAQ_UTTERANCE_NOT_IN_PAYLOAD"):
        apply_review(s.call_id, 1000, e, p, validate_decision(e, decision()), faq_answered_enabled=True)


def test_cannot_reference_answer_quote_truncated_from_api_payload(tmp_path):
    rs, db = service(tmp_path)
    e = evidence()
    e["transcript"][1]["text"] = "가" * 20000 + ANSWER
    s, p = payload(e, rs, db)
    with pytest.raises(ReviewError, match="FAQ_QUOTE_NOT_TRANSMITTED"):
        apply_review(s.call_id, 1000, e, p, validate_decision(e, decision()), faq_answered_enabled=True)


def test_one_utterance_has_answered_and_unanswered_parts(tmp_path):
    rs, db = service(tmp_path)
    e = evidence()
    e["transcript"][0]["text"] = "착불도 되나요? 기사님 성별을 지정할 수 있나요?"
    e["transcript"][1]["text"] = "착불은 불가합니다. 기사님 성별 지정은 확인할 수 없습니다."
    d = ReviewDecision(inquiries=[
        Inquiry(customer_index=0, question_text="착불도 되나요?", tool_indices=[0], outcome="ANSWERED",
                agent_index=1, agent_quote="착불은 불가합니다.", used_evidence=[refs()[0]]),
        Inquiry(customer_index=0, question_text="기사님 성별을 지정할 수 있나요?", tool_indices=[0], outcome="UNANSWERED",
                agent_index=1, agent_quote="기사님 성별 지정은 확인할 수 없습니다.")])
    s, p = payload(e, rs, db)
    out = apply_review(s.call_id, 1000, e, p, validate_decision(e, d), faq_answered_enabled=True)
    assert faq_events(out)[0]["payload"]["faqEntrySeqs"] == [12]
    assert out["analysis"]["faqAnswerCount"] == 1
    assert len(out["unanswered"]) == 1 and out["unanswered"][0]["reason"] == "KB_NO_ANSWER"


def test_distinct_responses_with_identical_text_are_separate_and_stable(tmp_path):
    rs, db = service(tmp_path)
    e = evidence()
    e["transcript"] += [e["transcript"][0] | {"t": 1010}, e["transcript"][1] | {"t": 1013}]
    e["searches"].append(copy.deepcopy(e["searches"][0]) | {"at": 1011})
    d = decision()
    second = d.inquiries[0].model_copy(deep=True, update={"customer_index": 2, "agent_index": 3, "tool_indices": [1]})
    second.used_evidence = [r.model_copy(update={"search_index": 1}) for r in refs()]
    d.inquiries.append(second)
    s, p = payload(e, rs, db)
    result = validate_decision(e, d)
    one = apply_review(s.call_id, 1000, e, p, result, faq_answered_enabled=True)
    two = apply_review(s.call_id, 1000, e, p, result, faq_answered_enabled=True)
    assert one == two and len(faq_events(one)) == 2
    assert len({r["eventId"] for r in faq_events(one)}) == 2


def test_v1_confirmed_review_is_not_backfilled(tmp_path):
    rs, db = service(tmp_path)
    e = evidence()
    s, p = payload(e, rs, db)
    verdict = {"version": "unanswered-v1", "inquiries": [{"customer_index": 0, "question_text": QUESTION,
        "outcome": "ANSWERED", "agent_index": 1}]}
    row = rs.outbox.create_review(s.call_id, s.state.customer.call_session_seq,
                                 {"started_t": 1000, "evidence": e, "payload": p})
    prepared = apply_review(s.call_id, 1000, e, p, verdict)
    rs.outbox.complete_review(s.call_id, verdict, prepared)
    client = FakeClient()
    rs.reviewer, rs.reason_contract_enabled, rs.faq_answered_enabled = reviewer(client), True, True
    run(rs.recover())
    assert client.calls == [] and rs.outbox.insight(s.call_id)["payload"] == prepared
    assert faq_events(prepared) == [] and row["status"] == "PENDING"


def test_lost_event_ack_retries_frozen_array_without_new_model_call(tmp_path):
    class LostAck(MockBackend):
        attempts = 0
        drop_ack = True

        async def send_call_events(self, seq, body):
            await super().send_call_events(seq, body)
            if any(e["payload"].get("action") == "FAQ_ANSWERED" for e in body["events"]):
                self.attempts += 1
                if self.drop_ack:
                    raise BackendFailure("unavailable", "BE_TIMEOUT", "events")

    rs, db = service(tmp_path, LostAck())
    s, _ = payload(evidence(), rs, db)
    client = FakeClient(decision())
    rs.reviewer, rs.reason_contract_enabled, rs.faq_answered_enabled = reviewer(client), True, True

    async def initial():
        await rs.finish(s)
        await asyncio.gather(*rs.background)

    run(initial())
    stored = rs.outbox.insight(s.call_id)
    prepared = rs.outbox.review(s.call_id)["prepared"]
    assert stored["status"] == "PENDING" and len(faq_events(prepared)) == 1
    assert db.analyses[s.state.customer.call_session_seq]["faqAnswerCount"] == 1
    db.drop_ack = False
    rs.outbox.close()
    restored = ResultService(BackendGateway(db), Outbox(tmp_path / "outbox.sqlite3"), P, fare,
        reviewer=reviewer(client), reason_contract_enabled=True, faq_answered_enabled=True)
    run(restored.recover())
    assert restored.outbox.insight(s.call_id)["status"] == "DONE" and len(client.calls) == 1
    assert restored.outbox.insight(s.call_id)["payload"] == stored["payload"]
    assert len([e for e in db.events[s.state.customer.call_session_seq].values()
                if e["payload"].get("action") == "FAQ_ANSWERED"]) == 1


def test_recovery_holds_existing_arrays_if_contract_disabled(tmp_path):
    rs, db = service(tmp_path)
    e = evidence()
    s, p = payload(e, rs, db)
    prepared = apply_review(s.call_id, 1000, e, p, validate_decision(e, decision()), faq_answered_enabled=True)
    rs.outbox.create_insight(s.call_id, s.state.customer.call_session_seq, prepared)
    rs.reason_contract_enabled = True
    run(rs.recover())
    assert db.events == {} and rs.outbox.insight(s.call_id)["payload"] == prepared
    assert rs.outbox.insight(s.call_id)["status"] == "PENDING"


def test_event_batches_transmit_utterances_before_faq_references(tmp_path):
    rs, db = service(tmp_path)
    e = evidence()
    s, p = payload(e, rs, db)
    # 실제 송신 분할을 강제하기 위해 앞에 일반 검색 이벤트 50개를 둔다.
    p["events"] = [{"eventId": f"event-{i}", "eventOrder": i, "kind": "AI_ACTION",
                    "payload": {"action": "FAQ_SEARCH"}} for i in range(1, 51)] + p["events"]
    for i, event in enumerate(p["events"], 1):
        event["eventOrder"] = i
    out = apply_review(s.call_id, 1000, e, p, validate_decision(e, decision()), faq_answered_enabled=True)
    batches = _batches(s.call_id, out["events"])
    assert len(batches) == 2
    last = batches[-1]["events"]
    assert last[-1]["payload"]["action"] == "FAQ_ANSWERED"
    assert len([r for r in last[:-1] if r["kind"] == "UTTERANCE"]) == 2
