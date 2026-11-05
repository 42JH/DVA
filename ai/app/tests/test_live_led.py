"""Live 주도 경로: 실제 API 없이 제약 경계·행동 참조·종료 시 한 주문을 검증한다."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from conftest import run

from app.calls.live import LiveFlow, Spoken
from app.calls.session import Phase
from app.domain.candidates import offer
from app.domain.confirm import issue_cancel_confirmation, issue_parcel_confirmation
from app.domain.preparation import prepare_confirmation
from app.domain.state import ConversationState, Place, Source
from app.policy.render import decision_questions, render_live, render_backend
from app.tests.test_calls import FakeClient, service
from app.tests.test_domain import GEO, P, filled, confirm_once
from app.tests.test_results import session, service as result_service
from app.tests.test_tools import ctx
from app.tools import run_tool, function_specs, MODEL_TOOLS


def setup(state=None):
    svc = service(FakeClient(), live_led=True, commit_delay_ms=10)
    flow = LiveFlow(svc)
    s = session(state or filled())
    s.phase = Phase.ACTIVE
    s.tools.live_led = True
    s.tools.backend = svc.d.backend
    s.tools.last_utterance_id = 2
    rt = flow.rt(s)
    rt.intent_started = True
    rt.last_customer = Spoken(2, "진행 원합니다", 500, 600, 201, 202)
    rt.ai = [Spoken(1, "접수 내용 확인 부탁드릴게요. 받는 분은…", 0, 1000, 200, 202)]
    events = []

    async def notify(s, level, facts):
        events.append((level, facts))

    async def send(s, event):
        events.append(("wire", event))

    flow.notify, flow.send = notify, send
    s.tools.control = lambda args: flow.control(s, args)
    return flow, s, events


def action(name, **kw):
    return dict(action=name, utterance_id=2, pending_id=None, candidate_label=None,
                candidate_version=None, field=None) | kw


@pytest.mark.parametrize("price,accepted", [(0, False), (-1, False), (1, True),
                                          (99_999_999, True), (100_000_000, False)])
def test_price_boundaries(price, accepted):
    c = ctx(live_led=True)
    c.last_utterance_id = 1
    out = run(run_tool(c, "record_fields", json.dumps({"item_price": price, "utterance_id": 1}), "p"))
    assert (out["status"] == "ok") is accepted
    if accepted:
        assert c.state.current["item_price"].value == price


def test_combined_box_limit_and_documents_per_destination():
    for _ in range(2):  # 통화 전체 합계가 아니라 받는 곳별로 각각 허용
        c = ctx(live_led=True)
        c.last_utterance_id = 1
        good = run(run_tool(c, "record_fields", json.dumps({"small_box_count": 6, "medium_box_count": 4,
                                                           "document_count": 100, "utterance_id": 1}), "good"))
        assert good["status"] == "ok"
        old = c.state.current["items"].value
        bad = run(run_tool(c, "record_fields", json.dumps({"small_box_count": 6, "medium_box_count": 5, "utterance_id": 1}), "bad"))
        assert bad["code"] == "BOX_TOTAL_EXCEEDED" and c.state.current["items"].value == old
        assert "items" in c.state.unresolved_fields
        assert run(run_tool(c, "record_fields", '{"document_count":101}', "docs"))["code"] == "TOOL_ARGS_INVALID"


def test_actual_live_prompt_and_backend_have_distinct_jobs():
    prompt = render_live(None, P, live_led=True)
    assert all(x in prompt for x in ("1원 이상 1억 원 미만", "100개", "10개", "3일", "60분", "뉘앙스", "주소 조회"))
    assert "채우는 말에는 결과·판단·되읽기·다음 질문을 넣지" not in prompt
    assert "서버가 직접 듣고 판단합니다" not in prompt
    assert "status·code·needs" in render_backend(P, live_led=True)
    assert "manage_conversation" not in {x["name"] for x in function_specs()}
    assert "manage_conversation" in {x["name"] for x in function_specs(tuple(MODEL_TOOLS))}


def test_unapproved_operating_persona_is_not_in_live_led_instructions():
    f, s, _ = setup()
    persona = SimpleNamespace(prompt="OLD transferCall 서버 Decision 지시", version_seq=10, voice=None)
    config = f.svc.session_config(s, persona)
    assert "OLD transferCall" not in config["instructions"]
    assert "manage_conversation" in {t["name"] for t in config["delegation"]["responses"]["tools"]}
    assert not f.svc.persona.enabled  # 사용하지 않는 운영 프롬프트를 APPLIED로 회신하지 않는다


@pytest.mark.parametrize("stage", ["inquiry", "lookup", "cancel"])
def test_legacy_global_exit_questions_also_present(stage):
    assert "switch" in [q["name"] for q in decision_questions(P, stage)]


def test_live_path_does_not_call_decision_and_publishes_current_context():
    async def scenario():
        f, s, events = setup()
        rt = f.rt(s)
        rt.cust = Spoken(3, "말씀드릴게요", 100, 500, 250, 251)
        f._customer_done(s)
        await asyncio.sleep(0)
        assert s.tools.last_utterance_id == 3
        assert events[-1][1]["type"] == "session.thinking.append"
        assert "[통화 상태]" in events[-1][1]["content"]
        await f.svc.warmup()  # FakeClient에 decisions가 없어도 호출되지 않음
    run(scenario())


def test_early_parcel_acceptance_and_stale_confirmation():
    async def scenario():
        f, s, _ = setup()
        p = issue_parcel_confirmation(s.state, P, 100)
        assert (await f.control(s, action("confirm", pending_id="old")))["code"] == "CONFIRM_STALE"
        out = await f.control(s, action("confirm", pending_id=p.id))
        assert out["action"] == "confirm"
        await asyncio.sleep(.03)
        assert len(s.state.parcels) == 1
        again = await f.control(s, action("confirm", pending_id=p.id))
        assert again["duplicate"]
    run(scenario())


def test_confirmation_invalidated_by_pickup_change_and_bad_correction():
    async def scenario():
        f, s, _ = setup()
        p = issue_parcel_confirmation(s.state, P, 100)
        s.state.record("pickup_at", "2030-01-01T10:00:00+09:00")
        assert (await f.control(s, action("confirm", pending_id=p.id)))["code"] == "CONFIRM_SNAPSHOT_CHANGED"
        p = issue_parcel_confirmation(s.state, P, 100)
        s.state.unresolved_fields.add("receiver_phone")
        assert (await f.control(s, action("confirm", pending_id=p.id)))["code"] == "CONFIRM_SNAPSHOT_CHANGED"
    run(scenario())


def test_cancel_reconfirmation_without_current_draft():
    async def scenario():
        f, s, events = setup(ConversationState(intent="cancel"))
        s.state.selected_order = {"order_seq": 1, "order_parcel_seq": 2, "receiver_name": "테스트"}
        p = issue_cancel_confirmation(s.state, 100)
        await f._follow(s, "ask_confirm", p.id)
        facts = events[-1][1]
        assert facts["confirmation"] == "cancel_ask_again" and "cancel_target" in facts
        assert "readback" not in facts
        assert (await f.control(s, action("confirm", pending_id=p.id)))["code"] == "CANCEL_CONFIRM_NOT_FINISHED"
    run(scenario())


def test_pin_selection_opens_confirmation_and_rejects_old_candidates():
    async def scenario():
        f, s, events = setup()
        s.state.clear("receiver_address")
        place = Place("받는분", "01012345678", "서울 강남구 테헤란로 212", "", GEO, Source.PIN)
        offer(s.state, "destination", ("1번",), (place,))
        version = s.state.candidates.version
        assert (await f.control(s, action("select", candidate_label="1번", candidate_version=version-1)))["code"] == "CANDIDATE_STALE"
        await f.control(s, action("select", candidate_label="1번", candidate_version=version))
        assert s.state.pending and "readback" in events[-1][1]
        assert "confirmation_id" in events[-1][1]
    run(scenario())


def test_lookup_back_to_order_preserves_draft():
    async def scenario():
        f, s, _ = setup()
        s.state.intent = "lookup"
        old = s.state.current
        await f.control(s, action("order"))
        assert s.state.intent == "order" and s.state.current is old
    run(scenario())


def test_address_error_blocks_ready_even_when_old_address_remains():
    c = ctx(live_led=True)
    c.last_utterance_id = 1
    c.state = filled()
    out = run(run_tool(c, "record_fields", '{"receiver_address":"새로 들은 주소 1","utterance_id":1}', "bad-address"))
    assert out["code"] == "ADDRESS_UNAVAILABLE"
    assert "receiver_address" in c.state.unresolved_fields and "readback" not in out.get("facts", {})
    assert prepare_confirmation(c) == {}


def test_no_more_does_not_submit_and_end_sends_one_order(tmp_path):
    async def scenario():
        st = filled()
        confirm_once(st)
        f, s, _ = setup(st)
        results, db = result_service(tmp_path)
        st.customer.customer_seq = db.add_customer(s.caller, "테스트고객")
        f.svc.results = results
        f.svc.begin_closing = lambda *a, **kw: None
        s.tools.backend = results.backend
        await f.control(s, action("no_more"))
        assert not db.results and not st.order_submitted
        await f.control(s, action("more"))
        for k, v in filled("다른분").current.fields.items():
            st.current.fields[k] = v
        st.current.sender_geo = st.current.receiver_geo = GEO
        confirm_once(st, 300)
        await f.control(s, action("end"))
        await results.tasks[s.call_id]
        assert len(db.results) == 1 and len(db.results[0]["body"]["parcels"]) == 2
        results.outbox.close()
    run(scenario())


def test_late_record_cannot_overwrite_new_utterance_and_timeout_blocks_confirmation():
    async def scenario():
        c = ctx(live_led=True, tool_budget_sec=.2)
        c.state = filled()
        c.state.require_resolved_addresses = True
        c.last_utterance_id = 1
        started, release = asyncio.Event(), asyncio.Event()

        async def resolve(heard):
            started.set()
            await release.wait()
            return SimpleNamespace(status="confirmed", address=heard, geo=GEO, alternatives=())

        c.address = SimpleNamespace(resolve=resolve)
        work = asyncio.create_task(run_tool(c, "record_fields", json.dumps({
            "receiver_address": "새 주소 1", "utterance_id": 1}), "old"))
        await started.wait()
        c.last_utterance_id = 2
        release.set()
        assert (await work)["code"] == "RESULT_SUPERSEDED"
        assert c.state.current["receiver_address"].value != "새 주소 1"
        assert prepare_confirmation(c) == {}
        release.clear()
        c.tool_budget_sec = .01
        out = await run_tool(c, "record_fields", json.dumps({"receiver_address": "새 주소 2", "utterance_id": 2}), "timeout")
        assert out["code"] == "TOOL_TIMEOUT" and c.address_pending == 0
        assert prepare_confirmation(c) == {}
    run(scenario())


def test_relative_pickup_uses_current_execution_time():
    c = ctx(live_led=True)
    c.last_utterance_id = 1
    from datetime import datetime, timedelta
    c.now = lambda: datetime.fromisoformat("2026-11-05T10:05:01+09:00")
    out = run(run_tool(c, "record_fields", '{"utterance_id":1,"pickup_after_minutes":60}', "relative"))
    assert out["status"] == "ok"
    at = datetime.fromisoformat(c.state.pickup_at.value)
    assert at >= c.now()+timedelta(hours=1) and at.minute % 10 == 0


def test_address_geo_missing_and_old_reference_do_not_allow_record_or_readback():
    c = ctx(live_led=True)
    c.state = filled()
    c.state.require_resolved_addresses = True
    c.state.current.receiver_geo = None
    c.last_utterance_id = 2
    assert run(run_tool(c, "record_fields", '{"item_price":100,"utterance_id":1}', "stale"))["code"] == "RECORD_STALE"
    assert prepare_confirmation(c) == {}


def test_end_waits_for_already_received_record_and_more_keeps_only_sender():
    async def scenario():
        f, s, _ = setup()
        confirm_once(s.state)
        sender = s.state.parcels[0].draft["sender_address"].value
        await f._follow(s, "more", None)
        assert s.state.current["sender_address"].value == sender
        assert not s.state.current["receiver_name"].valid
        s.tools.recording = 1

        async def finish():
            await asyncio.sleep(.03)
            s.state.record("item_price", 12345)
            s.tools.recording = 0

        work = asyncio.create_task(finish())
        f.svc.begin_closing = lambda *a, **kw: None
        await f._on_intent(s, "end")
        assert work.done() and s.state.current["item_price"].value == 12345
    run(scenario())


def test_late_history_does_not_restore_old_profile_or_customer_address():
    from app.calls.service import _apply_history
    st = filled()
    st.origin_applied = True
    st.customer.default_address = "고객이 새로 저장한 주소"
    before = st.current["sender_address"].value
    history = SimpleNamespace(customer_seq=st.customer.customer_seq,
                              recent_origin=Place("이전", "01000000000", "예전 주소", "", GEO),
                              recent_destinations=[Place("이전수령인", "01000000001", "이전 도착지", "", GEO)])
    _apply_history(st, history)
    assert st.current["sender_address"].value == before
    assert st.customer.default_address == "고객이 새로 저장한 주소"
    assert st.customer.origin_place is None and st.customer.places[0].name == "이전수령인"


def test_persona_manager_does_not_acknowledge_unreviewed_pending_version():
    from app.calls.persona import PersonaManager

    async def scenario():
        async def config(status):
            return {"aiPersonaVersionSeq": 10 if status == "ACTIVE" else 11,
                    "promptText": "검토한 말투", "applicationId": "synthetic", "status": status}

        async def report(body):
            raise AssertionError("검토하지 않은 버전을 적용 완료로 회신하면 안 됨")

        manager = PersonaManager(SimpleNamespace(persona_config=config, persona_result=report), allowed_version=10)
        await manager.sync()
        assert manager.active.version_seq == 10 and not manager.unresolved
    run(scenario())


def test_more_cannot_skip_current_unconfirmed_contents():
    async def scenario():
        f, s, _ = setup()
        draft = s.state.current
        out = await f.control(s, action("more"))
        assert out["code"] == "CURRENT_PARCEL_UNCONFIRMED"
        assert s.state.current is draft and out["confirmation_id"] == s.state.pending.id
    run(scenario())


def test_default_pickup_rounds_up_seconds_at_one_hour_boundary():
    from datetime import datetime, timedelta
    from app.domain.pickup import default_pickup, rule_of
    now = datetime.fromisoformat("2026-11-05T10:00:05+09:00")
    at, _ = default_pickup(now, rule_of(P.pickup))
    assert datetime.fromisoformat(at) >= now+timedelta(hours=1)


def test_late_record_tool_does_not_change_current_lookup_intent():
    async def scenario():
        f, s, _ = setup()
        s.state.intent = "lookup"
        f.cfg = f.cfg.model_copy(update={"response_fallback_sec": .001})
        old_name = s.state.current["receiver_name"].value
        await f.call_tool(s, "old", {"name": "record_fields", "call_id": "late",
                                    "arguments": json.dumps({"utterance_id": 1, "receiver_name": "오래된 정정"})})
        assert s.state.intent == "lookup" and s.state.current["receiver_name"].value == old_name
        assert s.tool_calls[-1]["output"]["code"] == "RECORD_STALE"
    run(scenario())
