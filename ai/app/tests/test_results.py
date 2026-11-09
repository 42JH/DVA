"""S6: 아웃박스·통화 결과 전송·신규 고객 등록·최종 분석·이벤트·미답변(spec/ai-integration-current.md). 가짜 BE."""

import asyncio
import json

import httpx2
from conftest import CALLER, run

from app.calls.results import ResultService, _batches
from app.calls.session import CallSession
from app.domain.state import ConversationState, Customer
from app.integrations.backend.gateway import BackendGateway
from app.persistence.outbox import Outbox
from app.tests.test_domain import GEO, P, confirm_once, fare, filled
from app.tools.context import ToolContext
from backend_client.mock import MockBackend

INCOMING_AT = "2026-11-03T01:00:00Z"


def session(state: ConversationState, sid="live_1") -> CallSession:
    s = CallSession(sid, "trace", CALLER, INCOMING_AT, ToolContext(sid, state, P, None))
    s.started_t = 1000.0
    return s


def service(tmp_path, db=None):
    db = db or MockBackend()
    return ResultService(BackendGateway(db), Outbox(tmp_path / "outbox.sqlite3"), P, fare), db


def test_outbox_keeps_key_and_body_across_reopen(tmp_path):
    ob = Outbox(tmp_path / "o.sqlite3")
    first = ob.create_result("s1", "key-1", {"outcome": "INCOMPLETE"})
    again = ob.create_result("s1", "key-2", {"outcome": "COMPLETE"})  # 키·본문 불변
    assert (again["key"], again["body"]) == ("key-1", {"outcome": "INCOMPLETE"}) and first["status"] == "PENDING"
    ob.update_result("s1", "SENT_UNCERTAIN", {"error": "BE_UNAVAILABLE"})
    ob.close()
    ob = Outbox(tmp_path / "o.sqlite3")
    assert [r["key"] for r in ob.unfinished_results()] == ["key-1"]


def test_submit_complete_once_and_status_facts(tmp_path):
    rs, db = service(tmp_path)
    st = filled()
    confirm_once(st)
    st.customer.customer_seq = db.add_customer(CALLER, "김철수")
    s = session(st)
    data = run(rs.submit(s))
    assert data["status"] == "notPaid" and not st.result_accepted  # 카드 결제 대기 ≠ 접수 성공
    body = db.results[-1]["body"]
    assert body["outcome"] == "COMPLETE" and body["paymentMethodType"] == "billing" and body["pickupRequestedAt"].endswith("+09:00")
    assert body["customerSeq"] == st.customer.customer_seq and "customer" not in body
    again = run(rs.submit(s))
    assert again == data and len(db.results) == 1  # 같은 통화: 아웃박스의 같은 키·본문(새 주문 없음)


def test_meaningless_call_sends_nothing(tmp_path):
    rs, db = service(tmp_path)
    assert run(rs.submit(session(ConversationState(customer=Customer(caller_phone=CALLER))))) is None
    assert db.results == [] and rs.outbox.result("live_1") is None


def test_uncertain_submit_is_rechecked_with_same_key_after_restart(tmp_path):
    class Down(MockBackend):
        async def submit_result(self, body, key):
            raise httpx2.ConnectError("down")

    rs, _ = service(tmp_path, Down())
    rs.submit_budget_sec = 0.5
    st = filled()
    confirm_once(st)
    assert run(rs.submit(session(st))) is None
    row = rs.outbox.result("live_1")
    assert row["status"] == "SENT_UNCERTAIN"
    healthy = MockBackend()
    healthy.add_customer(CALLER, "김철수")  # 고객 번호 12의 결제 자격(billing)
    healthy.customers[CALLER]["seq"] = 12
    healthy.payment_methods[CALLER] = ["billing"]
    rs2 = ResultService(BackendGateway(healthy), Outbox(tmp_path / "outbox.sqlite3"), P, fare)
    run(rs2.recover())
    assert healthy.results[-1]["key"] == row["key"] and rs2.outbox.result("live_1")["status"] == "DONE"


def test_uncertain_submit_is_rechecked_while_running(tmp_path):
    """BE 확인 2번: 재시작 없이도 SENT_UNCERTAIN 결과를 같은 키·본문으로 재확인한다. 전송 중·방금 바뀐 행은 건너뛴다."""
    class Flaky(MockBackend):
        down = True

        async def submit_result(self, body, key):
            if self.down:
                raise httpx2.ConnectError("down")
            return await super().submit_result(body, key)

    db = Flaky()
    db.add_customer(CALLER, "김철수")
    db.customers[CALLER]["seq"] = 12
    db.payment_methods[CALLER] = ["billing"]
    rs, _ = service(tmp_path, db)
    rs.submit_budget_sec = 0.5
    st = filled()
    confirm_once(st)
    assert run(rs.submit(session(st))) is None
    row = rs.outbox.result("live_1")
    assert row["status"] == "SENT_UNCERTAIN"
    db.down = False

    async def scenario():
        await rs.resend_unfinished()  # 방금 바뀐 행(전송 예산 안): 다음 주기로
        assert rs.outbox.result("live_1")["status"] == "SENT_UNCERTAIN" and db.results == []
        rs.outbox.db.execute("UPDATE call_results SET updated_at = updated_at - 100")  # 예산이 지난 행
        rs.tasks["live_1"] = asyncio.create_task(asyncio.sleep(10))  # 이 프로세스가 전송 중
        await rs.resend_unfinished()
        assert rs.outbox.result("live_1")["status"] == "SENT_UNCERTAIN" and db.results == []
        rs.tasks.pop("live_1").cancel()
        await rs.resend_unfinished()

    run(scenario())
    assert rs.outbox.result("live_1")["status"] == "DONE"
    assert len(db.results) == 1 and db.results[0]["key"] == row["key"]  # 같은 키로 주문 1건, 새 키 없음


def test_new_customer_registration_with_address_then_payment_auto(tmp_path):
    rs, db = service(tmp_path)
    st = filled()
    st.customer = Customer(status="UNREGISTERED", initial_status="UNREGISTERED", caller_phone=CALLER)
    s = session(st)
    s.tools.ops["register"] = {"status": "running"}

    async def seq(_s):
        ctx = await db.caller_context(CALLER, {"providerCallId": "live_1", "incomingAt": INCOMING_AT})
        _s.state.customer.call_session_seq = ctx.call_session_seq
        return ctx.call_session_seq

    run(rs.register(s, seq))
    assert s.tools.ops["register"]["status"] == "done" and st.customer.customer_seq
    saved = db.customers[CALLER]
    assert saved["name"] == "김철수" and saved["address"] == {
        "roadAddress": "서울 강남구 테헤란로 212", "jibunAddress": GEO.jibun_address, "detailAddress": "1201호",
        "dongName": GEO.dong_name, "postalCode": GEO.postal_code}  # 이름·번호·좌표 없는 내 주소
    assert not db.pins.get(CALLER)  # 보내는 곳은 고객 기본 주소에만(PIN은 받는 곳 전용)
    assert st.customer.payment_methods == ("billing",)  # 등록 후 받은 가능 방식(하나면 자동)


def test_registration_failure_keeps_unregistered_and_sends_customer_name(tmp_path):
    class NoReg(MockBackend):
        async def create_customer(self, *a, **kw):
            raise httpx2.ConnectError("down")

    rs, db = service(tmp_path, NoReg())
    st = filled()
    st.customer = Customer(status="UNREGISTERED", caller_phone=CALLER, payment_methods=())
    s = session(st)
    s.tools.ops["register"] = {"status": "running"}

    async def seq(_s):
        return None

    run(rs.register(s, seq))
    assert s.tools.ops["register"]["status"] == "failed"
    confirm_once(st)
    run(rs.submit(s))
    body = db.results[-1]["body"]
    assert body["outcome"] == "INCOMPLETE" and body["customer"] == {"name": "김철수", "phoneNumber": CALLER}
    assert "paymentMethodType" not in body  # 기본 billing 없음
    assert "parcels" not in body and db.results[-1]["status"] == "NO_ORDER"


def test_insights_analysis_events_and_unanswered(tmp_path):
    rs, db = service(tmp_path)
    st = filled()
    st.customer.customer_seq = db.add_customer(CALLER, "김철수")
    st.customer.initial_status = "UNREGISTERED"
    ctx = run(db.caller_context(CALLER, {"providerCallId": "live_1", "incomingAt": INCOMING_AT}))
    st.customer.call_session_seq = ctx.call_session_seq
    confirm_once(st)
    s = session(st)
    s.transcript = [{"id": 1, "speaker": "agent", "text": "안녕하세요", "t": 1001.0},
                    {"id": 2, "speaker": "customer", "text": "제주도 운임 얼마예요", "t": 1005.2}]
    s.tool_calls = [{"name": "search_manual", "arguments": json.dumps({"question": "제주도 운임"}), "at": 1006.0,
                     "output": {"status": "unavailable", "code": "KB_UNAVAILABLE"}},
                    {"name": "record_fields", "arguments": "{}", "at": 1010.0,
                     "output": {"status": "ok", "facts": {"recorded": ["receiver_name"]}}}]
    run(rs.finish(s))
    a = db.analyses[ctx.call_session_seq]
    assert set(a) == {"providerCallId", "startedAt", "endedAt", "aiPersonaVersionSeq", "isNewCustomer",
                      "registeredParcelCount", "faqAnswerCount", "orderLookupCount", "cancelledParcelCount",
                      "hasHandoffRequest", "repeatQuestionCount", "hasComplaint", "complaints"}
    assert (a["isNewCustomer"], a["registeredParcelCount"], a["faqAnswerCount"], a["hasHandoffRequest"]) == (
        True, 1, 0, False) and a["hasComplaint"] is None and a["complaints"] == [] and a["aiPersonaVersionSeq"] is None
    events = sorted(db.events[ctx.call_session_seq].values(), key=lambda e: e["eventOrder"])
    kinds = [(e["kind"], e["payload"].get("action")) for e in events]
    assert ("UTTERANCE", None) in kinds and ("AI_ACTION", "FAQ_SEARCH") in kinds and ("AI_ACTION", "FIELD_SAVED") in kinds
    assert ("BUSINESS_RESULT", "ORDER_CREATED") in kinds  # notPaid도 주문 저장(registeredParcelCount 포함)
    [unanswered] = db.unanswered.values()
    qu = next(e for e in events if e["payload"].get("action") == "QUESTION_UNANSWERED")
    assert qu["payload"]["unansweredQuestionSeq"] == unanswered["seq"] and unanswered["body"]["questionText"] == "제주도 운임"
    said = next(e for e in events if e["payload"].get("speaker") == "CUSTOMER")
    assert all(isinstance(e["offsetSeconds"], int) for e in events) and said["offsetSeconds"] == 5  # 정수 초 버림
    assert rs.outbox.insight("live_1")["status"] == "DONE"
    before = dict(db.events[ctx.call_session_seq])
    run(rs._send_insight(rs.outbox.insight("live_1") | {"status": "PENDING", "progress": {}}))  # 재전송: 같은 eventId·본문
    assert db.events[ctx.call_session_seq] == before


def test_batches_split_at_50_events():
    events = [{"eventId": str(i), "eventOrder": i, "kind": "UTTERANCE", "payload": {}} for i in range(1, 121)]
    assert [len(b["events"]) for b in _batches("live_1", events)] == [50, 50, 20]




def test_callback_field_sent_only_when_enabled(tmp_path):
    """hasCallbackRequest는 048 + 새 BE 배포 뒤에만(구버전 BE는 400) — 설정으로 켠다."""
    rs, db = service(tmp_path)
    st = filled()
    st.callback_requested = True
    s = session(st)
    assert "hasCallbackRequest" not in rs.build_insights(s)["analysis"]
    rs.callback_field = True
    assert rs.build_insights(s)["analysis"]["hasCallbackRequest"] is True


def test_customer_info_offer_and_save(tmp_path):
    """업무 규칙 g: 되읽기 때 저장 대상 → 담으면 성함·기본 주소(PATCH 한 번, 통화 헤더)·받는 곳 PIN 저장, 고객 정보 갱신."""
    from app.domain.address_book import save_offer
    from app.domain.state import Source
    rs, db = service(tmp_path)
    st = filled()
    st.customer.customer_seq = db.add_customer(CALLER, "김옛이름")
    st.customer.default_address = "서울 강남구 테헤란로 1"  # 기본 주소와 다른 출발지
    assert save_offer(st) == {"sender": True, "receiver": True}
    st.customer.name = "김옛이름"  # 보내는 분 성함이 등록 이름과 다름 → 이름도 갱신
    assert save_offer(st) == {"name": True, "sender": True, "receiver": True}
    st.record("receiver_address", "부산 해운대구 센텀로 10", Source.PIN)  # 주소록에서 고른 받는 곳 → 추가 제안 없음
    assert save_offer(st) == {"name": True, "sender": True}
    ctx = run(db.caller_context(CALLER, {"providerCallId": "live_1", "incomingAt": INCOMING_AT}))
    pid = confirm_once(st)
    snap = next(p.confirmed_snapshot for p in st.parcels if p.parcel_id == pid)
    s = session(st)

    async def seq(_s):
        return ctx.call_session_seq

    run(rs.save_addresses(s, seq, snap, {"name": True, "sender": True, "receiver": True, "parcel": pid}))
    assert db.customers[CALLER]["name"] == snap["sender_name"] == st.customer.name
    assert db.customers[CALLER]["address"]["roadAddress"] == "서울 강남구 테헤란로 212"
    assert db.customers[CALLER]["address"]["postalCode"] == GEO.postal_code and "name" not in db.customers[CALLER]["address"]
    assert [p.address for p in db.pins[CALLER]] == ["부산 해운대구 센텀로 10"]
    assert st.customer.default_address == "서울 강남구 테헤란로 212"


def test_unregistered_customer_gets_no_address_offer():
    from app.domain.address_book import save_offer
    st = filled()
    st.customer.customer_seq = None
    assert save_offer(st) == {}


def test_sender_offer_when_only_detail_differs():
    """BE 확인 4번: 도로명이 같아도 상세(101호→102호)가 바뀌면 기본 주소 저장을 제안한다. 둘 다 같으면 제안 없음."""
    from app.domain.address_book import save_offer
    from app.domain.state import Source
    st = filled(sender_address_detail="102호")
    st.record("receiver_address", "부산 해운대구 센텀로 10", Source.PIN)  # 받는 곳 제안은 끈다
    st.customer.default_address, st.customer.default_address_detail = "서울 강남구 테헤란로 212", "101호"
    assert save_offer(st) == {"sender": True}
    st.customer.default_address_detail = "102호"
    assert save_offer(st) == {}
    st.record("sender_address_detail", "")  # 고객이 상세 없다고 함 ↔ BE 상세 ""(생략)도 같은 것으로
    st.customer.default_address_detail = ""
    assert save_offer(st) == {}


def test_order_intent_without_parcel_info_is_no_order_not_empty_collecting(tmp_path):
    """운영 통화 3a0b9c7f: 결제 방식 하나뿐인 등록 고객이 접수 의도만 말하고 끊음 → 결제 방식을 보내지 않아 NO_ORDER.
    (이전: paymentMethodType=billing이 들어가 BE가 빈 COLLECTING 주문 orderSeq 59를 만듦)"""
    from app.domain.state import Source
    rs, db = service(tmp_path)
    st = ConversationState(customer=Customer(customer_seq=db.add_customer(CALLER, "현승준"), name="현승준",
                                             caller_phone=CALLER, payment_methods=("billing",)), intent="order")
    st.record("sender_phone", CALLER, Source.CALLER_ID)  # 발신번호만 자동으로 채워진 받던 택배
    before = len(db.orders) if hasattr(db, "orders") else None
    data = run(rs.submit(session(st)))
    body = db.results[-1]["body"]
    assert body["outcome"] == "INCOMPLETE" and "paymentMethodType" not in body and "pickupRequestedAt" not in body
    assert not body.get("parcels") and data["status"] == "NO_ORDER" and data["orderSeq"] is None
    if before is not None:
        assert len(db.orders) == before  # 주문을 만들지 않는다
