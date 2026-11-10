"""055 계약의 통화 중 조회, 수정, 종료와 전송 복구."""

import json

import httpx2
import pytest
from conftest import CALLER, run

from app.calls.intake import IntakeService
from app.calls.live import LiveFlow, Spoken
from app.domain.confirm import issue_cancel_confirmation, issue_parcel_confirmation
from app.domain.parcel_items import ItemIssue
from app.domain.state import Items
from app.domain.store import hold_items, open_for_edit
from app.policy.render import decision_questions
from app.tests.test_calls import until
from app.tests.test_domain import P, confirm_once, filled
from app.tests.test_live_flow import flow
from app.tests.test_results import service, session
from app.tests.test_tools import call, ctx, registered
from app.tools import run_tool
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
        s.state.record("items", Items(document_count=10))
        s.tools.clock = lambda: 100
        combined = await run_tool(s.tools, "record_fields", '{"small_box_count": 1}', "mixed-items")
        assert combined["facts"]["readback"]["items"] == {"document_count": 10, "small_box_count": 1}
        pending = s.state.pending
        readback = Spoken(1, "접수 내용 확인 부탁드릴게요. 받는 분은", 3000, 4800, 101, 101)
        await lf.apply(s, Spoken(2, "네", 4000, 4200, 102, 102), readback,
                       {"confirm": ("yes", 0.98, {"yes": 0.98})}, pending.id)
        assert not s.state.parcels and s.state.pending is pending and not db.drafts
        assert any(event["text"] == "CONFIRM_BEFORE_READBACK_END" for event in s.events)
        retry = Spoken(3, readback.text, 5000, 7000, 103, 103)
        await lf.apply(s, Spoken(4, "네, 맞습니다. 그냥 그렇게 접수해 주세요", 6200, 6900, 104, 104), retry,
                       {"confirm": ("proceed", 0.98, {"proceed": 0.98})}, pending.id)
        await until(lambda: s.rt.ready_notice is not None)
        [first] = db.drafts.values()
        assert first["status"] == "READY"
        assert db.intakes[first["callSessionSeq"]].get("complete") is None
        assert s.rt.ready_notice is not None
        lf.on_output(s, {"delta": "네, 이대로 택배가 접수됐습니다. 더 보내실 택배가 있으세요?"})
        s.rt.ai_end.cancel()
        lf._ai_done(s)
        assert not any(event["kind"] == "결과 문구" for event in s.events)
        assert s.rt.ready_notice is None
        return first

    first = run(scenario())
    out = call(s.tools, "lookup_orders", {"receiver_name": "이영희"})
    assert out["status"] == "needs_choice"
    assert [row["source"] for row in out["facts"]["orders"]] == ["order", "draft"]
    assert out["facts"]["orders"][1]["status_text"] == "이번 통화에서 접수된 택배"
    assert "lookup_order" not in out["facts"]

    async def pick_draft():
        s.state.intent = "lookup"
        label = out["facts"]["orders"][1]["label"]
        await lf.apply(s, Spoken(6, "이번 통화에서 접수된 택배요", 8000, 8100, 106, 106), None,
                       {"pick": (label, 1.0), "switch": ("lookup", 1.0)}, None)
        [selected] = [e["data"]["content"]["lookup_order"] for e in s.events
                      if "lookup_order" in e.get("data", {}).get("content", {})]
        assert selected["status"] == "READY"
        assert selected["receiver_address"] == first["parcel"]["destination"]["roadAddress"]
        assert selected["sender_address"] == first["parcel"]["origin"]["roadAddress"]
        assert selected["items"] == {"document_count": 10, "small_box_count": 1}
        assert selected["item_price"] == 30000 and selected["shipping_fee"] > 0
        assert not any("phone" in key or "detail" in key for key in selected)

    run(pick_draft())
    s.state.intent = "order"

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


@pytest.mark.parametrize("b_status", ["local", "EDITING", "READY"])
def test_cancelling_only_second_parcel_keeps_first_ready(tmp_path, b_status):
    intake, results, db, s = setup_intake(tmp_path)
    svc, _ = flow()
    svc.intake, svc.results, svc.d.backend = intake, results, results.backend
    lf = LiveFlow(svc)

    async def scenario():
        await lf.commit(s, issue_parcel_confirmation(s.state, P, 100).id)
        [first] = db.drafts.values()
        s.state.current = filled(receiver="박민수").current
        if b_status == "READY":
            await lf.commit(s, issue_parcel_confirmation(s.state, P, 200).id)
            s.state.intent = "cancel"
            await run_tool(s.tools, "lookup_orders", '{"receiver_name":"박민수"}', "find-b")
            issue_cancel_confirmation(s.state, s.tools.clock())
        else:
            if b_status == "EDITING":
                intake.sync(s)
                await intake.flush(s.call_id)
            choices = decision_questions(P, "item", cancel_current=True)[0]["choices"]
            assert {"value": "cancel_current"} in choices
            await lf._on_intent(s, "cancel_current")
            pending = s.state.pending.id
            await run_tool(s.tools, "lookup_orders", '{"receiver_name":"이영희"}', "late-lookup")
            assert s.state.pending.id == pending and s.state.selected_order["receiver_name"] == "박민수"
        await lf.commit(s, s.state.pending.id)
        assert s.state.cancel_done and s.state.current is None
        assert first["status"] == "READY"
        if b_status != "local":
            assert [d["status"] for d in db.drafts.values()] == ["READY", "CANCELLED"]
        else:
            assert len(db.drafts) == 1
        db.ended.add(first["callSessionSeq"])
        await results.finish(s)
        [order] = db.orders
        assert [p["destination"]["name"] for p in order["parcels"]] == ["이영희"]

    run(scenario())


def test_excluded_draft_is_cancelled_before_same_call_lookup(tmp_path):
    intake, _, db, s = setup_intake(tmp_path)

    async def scenario():
        pid = confirm_once(s.state)
        intake.sync(s)
        await intake.flush(s.call_id)
        open_for_edit(s.state, pid)
        hold_items(s.state, {"flammables": ItemIssue("PROHIBITED_ITEM", "제한 물품")})
        out = await run_tool(s.tools, "record_fields", json.dumps({"omit_blocked_parcel": "이 택배는 빼 주세요"}), "omit")
        assert out["facts"]["blocked_parcel_omitted"]
        intake.sync(s)
        await intake.flush(s.call_id)
        [draft] = db.drafts.values()
        assert draft["status"] == "CANCELLED"
        lookup = await run_tool(s.tools, "lookup_orders", "{}", "after-omit")
        assert lookup["facts"]["found"] == 0

    run(scenario())


def test_confirmation_reports_missing_requirements_instead_of_ready(tmp_path):
    intake, results, db, s = setup_intake(tmp_path)
    svc, _ = flow()
    svc.intake, svc.results, svc.d.backend = intake, results, results.backend
    lf = LiveFlow(svc)

    async def scenario():
        s.state.current.receiver_geo = None
        await lf.commit(s, issue_parcel_confirmation(s.state, P, 100).id)
        [draft] = db.drafts.values()
        assert draft["status"] == "EDITING"
        assert any(e.get("data", {}).get("content", {}).get("draft_intake") == "not_ready" for e in s.events)
        assert s.rt.ready_notice is None

    run(scenario())


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
