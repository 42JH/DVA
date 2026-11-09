"""055 계약의 통화 중 조회, 수정, 종료와 전송 복구."""

import asyncio

import httpx2
from conftest import CALLER, run

from app.calls.intake import IntakeService
from app.calls.live import LiveFlow
from app.domain.confirm import issue_cancel_confirmation, issue_parcel_confirmation
from app.tests.test_domain import P, confirm_once, filled
from app.tests.test_live_flow import flow
from app.tests.test_results import service, session
from app.tests.test_tools import call, ctx, registered
from backend_client.api import BackendAPI, BackendError
from backend_client.mock import MockBackend


def setup_intake(tmp_path, db=None):
    results, db = service(tmp_path, db)
    customer = registered(db)
    st = filled()
    st.customer.call_session_seq = customer.call_session_seq
    s = session(st, "live_test")
    s.tools.draft_intake = True
    s.tools.backend = results.backend
    intake = IntakeService(results.backend, results.outbox, results.policy, results.fare_of)
    results.intake = intake
    return intake, results, db, s


def test_live_confirmation_saves_and_lookup_combines_both_sources(tmp_path):
    intake, results, db, s = setup_intake(tmp_path)
    svc, _ = flow()
    svc.intake = intake
    svc.results = results
    svc.d.backend = results.backend
    lf = LiveFlow(svc)
    db.add_order(CALLER, "ACCEPTED", [("이영희", "이전 주소")])

    async def scenario():
        pending = issue_parcel_confirmation(s.state, P, 100)
        await lf.commit(s, pending.id)
        [first] = db.drafts.values()
        assert first["status"] == "READY"
        assert db.intakes[first["callSessionSeq"]].get("complete") is None
        return first

    first = run(scenario())
    out = call(s.tools, "lookup_orders", {"receiver_name": "이영희"})
    assert out["status"] == "needs_choice"
    assert [row["source"] for row in out["facts"]["orders"]] == ["order", "draft"]

    async def add_and_end():
        s.state.current = filled(receiver="박민수").current
        pending = issue_parcel_confirmation(s.state, P, 200)
        await lf.commit(s, pending.id)
        await results.finish(s)
        assert s.tools.ops["intake"]["status"] == "WAITING_PBX" and s.result is None
        db.ended.add(first["callSessionSeq"])
        await intake.recover()
        final = await db.intake_detail(first["callSessionSeq"])
        assert final["order"]["status"] == "notPaid"
        assert len(final["parcelMappings"]) == 2
        assert len(db.orders) == 2 and not db.results  # 기존 주문 + 이번 통화 주문, 레거시 POST 없음

    run(add_and_end())


def test_edit_on_pbx_first_does_not_submit_last_confirmed_address(tmp_path):
    intake, results, db, s = setup_intake(tmp_path)
    svc, _ = flow()
    svc.intake, svc.results = intake, results
    svc.d.backend = results.backend
    lf = LiveFlow(svc)

    async def scenario():
        pending = issue_parcel_confirmation(s.state, P, 100)
        await lf.commit(s, pending.id)
        [draft] = db.drafts.values()
        s.state.selected_order = {"draft_seq": draft["draftSeq"]}
        async with s.lock:
            assert lf._edit(s)["edit_parcel"] == s.state.parcels[0].parcel_id
        await intake.flush(s.call_id)
        assert draft["status"] == "EDITING" and "notifiedPrice" not in draft["parcel"]
        db.ended.add(draft["callSessionSeq"])
        await results.finish(s)
        assert s.tools.ops["intake"]["status"] == "NO_ORDER"
        assert draft["status"] == "INCOMPLETE" and not db.orders

    run(scenario())


def test_lost_create_and_patch_responses_recover_before_complete(tmp_path):
    class LostResponse(MockBackend):
        create_lost = False
        patch_lost = False

        async def create_draft(self, call_seq, body):
            row = await super().create_draft(call_seq, body)
            if not self.create_lost:
                self.create_lost = True
                raise BackendError("lost", 503)
            return row

        async def patch_draft(self, call_seq, draft_seq, body):
            row = await super().patch_draft(call_seq, draft_seq, body)
            if not self.patch_lost:
                self.patch_lost = True
                raise BackendError("lost", 503)
            return row

    intake, results, db, s = setup_intake(tmp_path, LostResponse())

    async def scenario():
        intake.sync(s)  # EDITING 생성
        assert (await intake.flush(s.call_id))["status"] == "SAVE_PENDING"
        confirm_once(s.state)
        seq = s.state.customer.call_session_seq
        db.ended.add(seq)
        await results.finish(s)  # 같은 UUID 재전송 성공 → READY PATCH 응답 유실
        assert (await db.intake_detail(seq))["status"] == "WAITING_AI"
        restarted = IntakeService(intake.backend, intake.outbox, intake.policy, intake.fare_of)
        await restarted.recover()
        assert (await db.intake_detail(seq))["status"] == "FINALIZED"
        assert len(db.drafts) == len(db.orders) == 1

    run(scenario())


def test_previous_incomplete_draft_is_copied_to_new_call_and_can_be_cancelled(tmp_path):
    intake, results, db, s = setup_intake(tmp_path)
    svc, _ = flow()
    svc.intake, svc.results = intake, results
    svc.d.backend = results.backend
    lf = LiveFlow(svc)

    async def scenario():
        seq = s.state.customer.call_session_seq
        s.state.current = None
        previous = await db.caller_context(CALLER, {"providerCallId": "previous", "incomingAt": s.incoming_at})
        old_seq = previous.call_session_seq
        source = await db.create_draft(old_seq, {"clientParcelId": "previous-draft", "status": "EDITING",
                                                "parcel": {"destination": {"name": "이영희"}}})
        db.ended.add(old_seq)
        await db.complete_intake(old_seq, {"expectedIntakeVersion": source["intakeVersion"]})
        stage2 = asyncio.get_running_loop().create_future()
        stage2.set_result(seq)
        await lf._resume_lookup(s, stage2)
        assert s.state.resume_offered
        await lf._resume_answer(s, True)
        assert s.state.current["receiver_name"].value == "이영희"
        assert s.state.resume_version is None  # 레거시 주문에 연결하지 않는다
        assert db.drafts[source["draftSeq"]]["status"] == "RESUMED"
        [target] = await db.list_drafts(seq, "EDITING", same_call=True)
        s.state.selected_order = {"draft_seq": target["draftSeq"], "version": target["version"], "status": "EDITING"}
        await lf.commit(s, issue_cancel_confirmation(s.state, s.tools.clock()).id)
        assert s.state.cancel_done and db.drafts[target["draftSeq"]]["status"] == "CANCELLED"
        assert s.state.current is None
        db.ended.add(seq)
        await results.finish(s)
        assert s.tools.ops["intake"]["status"] == "NO_ORDER" and not db.orders

        other = await db.caller_context(CALLER, {"providerCallId": "other", "incomingAt": s.incoming_at})
        new_session = session(filled(), "other")
        new_session.state.customer.call_session_seq = other.call_session_seq
        _, step = intake.resume(new_session, source["draftSeq"])
        assert await intake.flush(new_session.call_id) == {}
        assert intake.step_result(new_session, step) == {"resume_rejected": True}
        confirm_once(new_session.state)
        db.ended.add(other.call_session_seq)
        await intake.finish(new_session)
        assert new_session.tools.ops["intake"]["status"] == "FINALIZED"

    run(scenario())


def test_lookup_keeps_drafts_when_order_query_fails():
    class OrderDown(MockBackend):
        async def find_parcels(self, *args):
            raise BackendError("unavailable", 503)

    db = OrderDown()
    c = ctx(db, customer=registered(db), draft_intake=True)
    run(db.create_draft(c.state.customer.call_session_seq, {"clientParcelId": "example", "status": "EDITING",
                                                            "parcel": {"destination": {"name": "이영희"}}}))
    out = call(c, "lookup_orders", {"receiver_name": "이영희"})
    assert out["status"] == "ok" and out["facts"]["unavailable_sources"] == ["order"]
    assert out["facts"]["orders"][0]["status"] == "EDITING"
    missing = call(c, "lookup_orders", {"receiver_name": "박민수"})
    assert missing["code"] == "ORDER_LOOKUP_PARTIAL" and c.state.selected_order is None


def test_draft_http_paths_and_service_auth():
    seen = []

    def handler(request):
        assert request.headers["Authorization"] == "Bearer test-token"
        assert request.headers.get("call_session_seq") == ("7" if "parcel-drafts" in request.url.path else None)
        seen.append((request.method, request.url.path))
        if request.method == "GET" and request.url.path == "/api/parcel-drafts":
            assert request.url.params["status"] == "READY" and request.url.params["callSessionSeq"] == "7"
            return httpx2.Response(200, json={"data": [], "hasNext": False})
        return httpx2.Response(200, json={"data": {}})

    async def scenario():
        api = BackendAPI("http://backend", 1, transport=httpx2.MockTransport(handler), business_token="test-token")
        await api.create_draft(7, {"status": "EDITING"})
        await api.patch_draft(7, 5, {"action": "CANCEL", "expectedVersion": 1})
        await api.draft_detail(7, 5)
        await api.list_drafts(7, "READY", same_call=True)
        await api.complete_intake(7, {"expectedIntakeVersion": 2})
        await api.intake_detail(7)
        await api.close()

    run(scenario())
    assert seen == [("POST", "/api/parcel-drafts"), ("PATCH", "/api/parcel-drafts/5"),
                    ("GET", "/api/parcel-drafts/5"), ("GET", "/api/parcel-drafts"),
                    ("POST", "/api/calls/7/order-intake/complete"), ("GET", "/api/calls/7/order-intake")]
