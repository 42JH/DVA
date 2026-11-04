"""대시보드 이탈 단계·대기시간 전송(docs/be-contract/backend/ai-dashboard-ai-integration.md). 가짜 BE."""

import json
from types import SimpleNamespace

import httpx2
import pytest
from conftest import CALLER, run

from app.calls.results import dropoff_stage, wait_metrics
from app.calls.session import CallSession
from app.observability.trace import current_call, observe_latency
from app.tests.test_domain import P, confirm_once, filled
from app.tests.test_results import INCOMING_AT, service, session
from backend_client.api import BackendAPI, BackendError

PROCESS_TYPES = {"CUSTOMER_LOOKUP", "INFORMATION_INPUT", "FAQ_LOOKUP", "ORDER_LOOKUP", "ORDER_CANCEL",
                 "ADDRESS_LOOKUP", "ORDER_SAVE"}
STAGES = {"SENDER_INFO", "RECIPIENT_INFO", "ITEM_INFO", "CONFIRMATION", "PAYMENT_GUIDANCE", "FAQ_ANSWER",
          "ORDER_LOOKUP", "ORDER_CANCEL", "NONE"}


def tool(name, at, elapsed_ms=100, output=None):
    return {"name": name, "at": at, "elapsed_ms": elapsed_ms, "output": output or {"status": "ok"}}


def order_at(stage: str) -> CallSession:
    st = filled()
    if stage == "sender":
        st.clear("sender_name")
    elif stage == "receiver":
        st.clear("receiver_name")
    elif stage == "item":
        st.clear("items")
    elif stage in ("more_parcels", "payment", "closing"):
        confirm_once(st)
        if stage == "payment":
            st.customer.payment_methods = ("billing", "card")
            st.no_more_parcels = True
        elif stage == "closing":
            st.no_more_parcels = True
    s = session(st)
    s.close_reason = "pbx_ended"
    return s


@pytest.mark.parametrize("stage, want", [("sender", "SENDER_INFO"), ("receiver", "RECIPIENT_INFO"), ("item", "ITEM_INFO"),
                                         ("readback", "CONFIRMATION"), ("payment", "PAYMENT_GUIDANCE"),
                                         ("more_parcels", "NONE"), ("closing", "NONE")])
def test_order_dropoff_is_stage_in_progress_when_call_ended(stage, want):
    assert dropoff_stage(order_at(stage), P) == want


def test_more_parcels_with_payment_left_is_payment_guidance():
    s = order_at("more_parcels")
    s.state.customer.payment_methods = ("billing", "card")
    assert dropoff_stage(s, P) == "PAYMENT_GUIDANCE"


def test_customer_end_mid_collection_is_still_dropoff_and_faq_last_wins():
    s = order_at("receiver")
    s.close_reason = "customer_end"  # 고객이 끝내도 받는 중이던 단계에서 이탈
    assert dropoff_stage(s, P) == "RECIPIENT_INFO"
    s.tool_calls = [tool("record_fields", 1010.0), tool("search_manual", 1020.0)]
    assert dropoff_stage(s, P) == "FAQ_ANSWER"  # 접수 중 질문하다 끊김
    done = order_at("closing")
    done.tool_calls = [tool("search_manual", 1020.0)]
    assert dropoff_stage(done, P) == "NONE"  # 접수가 끝난 뒤 질문은 이탈이 아니다


@pytest.mark.parametrize("intent, name, want_open", [("inquiry", "search_manual", "FAQ_ANSWER"),
                                                     ("lookup", "lookup_orders", "ORDER_LOOKUP")])
def test_inquiry_and_lookup_none_only_after_ai_spoke_on_result(intent, name, want_open):
    s = session(filled())
    s.state.intent, s.close_reason = intent, "pbx_ended"
    assert dropoff_stage(s, P) == want_open  # 결과 전
    s.tool_calls = [tool(name, 1010.0, elapsed_ms=500)]
    s.last_output_t = 1010.3
    assert dropoff_stage(s, P) == want_open  # 결과가 나오기 전 말(필러)
    s.last_output_t = 1011.0
    assert dropoff_stage(s, P) == "NONE"


def test_cancel_none_only_when_done():
    s = session(filled())
    s.state.intent, s.close_reason = "cancel", "silence"
    assert dropoff_stage(s, P) == "ORDER_CANCEL"
    s.state.cancel_done = True
    assert dropoff_stage(s, P) == "NONE"


@pytest.mark.parametrize("reason", ["shutdown", "expiring", "connection_ConnectionClosed", "accept_failed"])
def test_system_end_handoff_and_no_intent_are_not_judged(reason):
    s = order_at("receiver")
    s.close_reason = reason
    assert dropoff_stage(s, P) is None
    s.close_reason, s.state.agent_transferred = "pbx_ended", True
    assert dropoff_stage(s, P) is None
    s.state.agent_transferred, s.state.intent = False, None
    assert dropoff_stage(s, P) is None


def test_wait_sum_open_interval_and_latency_without_zero_counts():
    s = session(filled())
    s.wait_ms = 1234.4
    s.measure("FAQ_LOOKUP", 300.6)
    s.measure("FAQ_LOOKUP", 200)
    s.latency["ORDER_LOOKUP"] = [0, 0]  # 측정 없음 → 보내지 않음
    s.record_backend("caller_context", 80, "ok", 200, None)
    s.record_backend("order_detail", 50, "ok", 200, None)  # 대시보드 유형 아님
    body = wait_metrics(s)
    assert body == {"providerCallId": "live_1", "totalWaitMs": 1234,
                    "latencyStats": [{"processType": "FAQ_LOOKUP", "totalLatencyMs": 501, "measurementCount": 2},
                                     {"processType": "CUSTOMER_LOOKUP", "totalLatencyMs": 80, "measurementCount": 1}]}
    s.rt, s.ended_t = SimpleNamespace(cust_end_t=1050.0, cust=None), 1052.5  # 고객 말 뒤 AI 말 없이 끝남
    assert wait_metrics(s)["totalWaitMs"] == 1234 + 2500
    s.rt.cust = object()  # 끝날 때 고객이 말하는 중이었으면 기다린 게 아니다
    assert wait_metrics(s)["totalWaitMs"] == 1234
    empty = session(filled(), sid="live_2")
    assert wait_metrics(empty) == {"providerCallId": "live_2", "totalWaitMs": 0, "latencyStats": []}


def test_observe_latency_goes_to_current_call_only():
    s = session(filled())
    observe_latency("ADDRESS_LOOKUP", 10)  # 통화 밖: 버린다
    token = current_call.set(s)
    try:
        observe_latency("ADDRESS_LOOKUP", 12.4)
    finally:
        current_call.reset(token)
    assert s.latency == {"ADDRESS_LOOKUP": [12, 1]}


def registered(tmp_path):
    rs, db = service(tmp_path)
    st = filled()
    st.customer.initial_status = "REGISTERED"
    ctx = run(db.caller_context(CALLER, {"providerCallId": "live_1", "incomingAt": INCOMING_AT}))
    st.customer.call_session_seq = ctx.call_session_seq
    s = session(st)
    s.close_reason = "pbx_ended"
    return rs, db, s, ctx.call_session_seq


def test_sent_after_analysis_with_contract_shapes(tmp_path):
    rs, db, s, seq = registered(tmp_path)
    s.measure("INFORMATION_INPUT", 400)
    token = current_call.set(s)  # 실제 통화처럼 이 통화 태스크에서 결과 전송(BE 호출 → ORDER_SAVE)
    try:
        run(rs.finish(s))
    finally:
        current_call.reset(token)
    assert seq in db.analyses and "dropoffStage" not in db.analyses[seq] and "totalWaitMs" not in db.analyses[seq]
    stage, wait = db.dashboard[(seq, "stage-metrics")], db.dashboard[(seq, "response-wait-metrics")]
    assert stage == {"providerCallId": "live_1", "dropoffStage": "CONFIRMATION"} and stage["dropoffStage"] in STAGES
    assert isinstance(wait["totalWaitMs"], int) and len(wait["latencyStats"]) <= 7
    types = [x["processType"] for x in wait["latencyStats"]]
    assert len(set(types)) == len(types) and set(types) <= PROCESS_TYPES and "ORDER_SAVE" in types  # 결과 전송도 측정
    assert all(isinstance(x["totalLatencyMs"], int) and x["measurementCount"] >= 1 for x in wait["latencyStats"])
    ob = rs.outbox.insight("live_1")
    assert ob["status"] == "DONE" and ob["progress"]["stage_metrics"] == ob["progress"]["wait_metrics"] == "done"


def test_unjudged_stage_not_sent_and_old_payload_skipped(tmp_path):
    rs, db, s, seq = registered(tmp_path)
    s.close_reason = "shutdown"
    run(rs.finish(s))
    assert (seq, "stage-metrics") not in db.dashboard and (seq, "response-wait-metrics") in db.dashboard
    rs2, db2, s2, seq2 = registered(tmp_path / "old")
    payload = rs2.build_insights(s2)
    del payload["stage_metrics"], payload["wait_metrics"]  # 이 기능 배포 전에 저장된 본문
    run(rs2._send_insight(rs2.outbox.create_insight("live_1", seq2, payload)))
    assert seq2 in db2.analyses and not db2.dashboard and rs2.outbox.insight("live_1")["status"] == "DONE"


def test_items_independent_conflict_stops_and_unavailable_retries_only_that_item(tmp_path):
    rs, db, s, seq = registered(tmp_path)
    calls = []
    real_stage, real_wait = db.send_stage_metrics, db.send_wait_metrics

    async def conflict(seq_, body):
        calls.append("stage")
        raise BackendError("/stage-metrics 409 EVENT_PAYLOAD_CONFLICT", 409, "EVENT_PAYLOAD_CONFLICT")

    down = {"n": 1}

    async def flaky(seq_, body):
        calls.append("wait")
        if down["n"]:
            down["n"] -= 1
            raise BackendError("/response-wait-metrics 503", 503, "DEPENDENCY_UNAVAILABLE")
        await real_wait(seq_, body)

    db.send_stage_metrics, db.send_wait_metrics = conflict, flaky
    run(rs.finish(s))
    row = rs.outbox.insight("live_1")
    assert row["status"] == "PENDING" and row["progress"]["stage_metrics"] == "failed"  # 충돌은 멈춤, 대기는 다시
    assert calls == ["stage", "wait"]  # 한쪽 실패가 다른 쪽을 막지 않는다
    db.send_stage_metrics = real_stage
    run(rs._send_insight(row))
    assert calls == ["stage", "wait", "wait"]  # 실패한 항목만 같은 본문으로
    assert rs.outbox.insight("live_1")["status"] == "DONE" and (seq, "response-wait-metrics") in db.dashboard


def test_api_paths_and_auth():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx2.Response(204)

    client = BackendAPI("http://backend", 3.0, transport=httpx2.MockTransport(handler), insights_token="tok",
                        retry_interval_sec=0.01)

    async def scenario():
        try:
            await client.send_stage_metrics(123, {"providerCallId": "p", "dropoffStage": "NONE"})
            await client.send_wait_metrics(123, {"providerCallId": "p", "totalWaitMs": 0, "latencyStats": []})
        finally:
            await client.close()

    run(scenario())
    assert [r.url.path for r in seen] == ["/api/ai/calls/123/stage-metrics", "/api/ai/calls/123/response-wait-metrics"]
    assert all(r.method == "POST" and r.headers["authorization"] == "Bearer tok" and "cookie" not in r.headers
               for r in seen)
    assert json.loads(seen[1].content) == {"providerCallId": "p", "totalWaitMs": 0, "latencyStats": []}
