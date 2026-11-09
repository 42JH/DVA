"""미완료 주문 이어받기(사용자 결정 2026-11-06·11-08): createdAt 일주일 안 → 먼저 묻고 → 예면 같은 값 PATCH로 연결 →
가장 최근 상세 1건을 불러와 빠진 항목·되읽기 → 확정은 PATCH + submit(새 주문 POST 없음). 끊기면 PATCH만.
2단계: 결과는 아웃박스(목표 상태)로 남기고 보낼 때마다 다시 읽어 남은 변경만 — 유실·재시작·409에도 같은 결과."""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx2
from conftest import CALLER, run

from app.calls.session import Phase
from app.domain.assess import assess
from app.domain.resume import can_offer, load_resumed, within_window
from app.domain.state import ConversationState, Customer, FieldStatus, Items, ResumeCandidate, Source
from app.integrations.backend.mapping import resume_candidate, resume_draft_candidate
from app.tests.test_calls import incoming, started, until
from app.tests.test_live_flow import ai, flow, say
from app.calls.results import ResultService
from app.integrations.backend.gateway import BackendGateway
from app.persistence.outbox import Outbox
from app.tests.test_domain import P, fare
from backend_client.api import BackendAPI, BackendError, link_body, remaining_patch, resume_body
from backend_client.mock import MockBackend
from backend_client.order import Order

NOW = datetime(2026, 11, 6, 3, 0, tzinfo=timezone.utc)
WEEK = 7 * 24 * 3600
ADDR = {"jibunAddress": "서울 강남구 역삼동 737", "dongName": "역삼동", "postalCode": "06236"}
ORIGIN = {"name": "김철수", "phoneNumber": CALLER, "roadAddress": "서울 강남구 테헤란로 212", "detailAddress": "1201호"} | ADDR
DEST = {"name": "이영희", "phoneNumber": "01098765432", "roadAddress": "부산 해운대구 센텀로 10", "detailAddress": ""} | ADDR


def parcel(**over):
    return {"origin": ORIGIN, "destination": DEST, "documentCount": 0, "smallBoxCount": 1, "mediumBoxCount": 0,
            "bigBoxCount": 0, "otherItemDescription": "", "clientComment": "", "itemPrice": 30000,
            "notifiedPrice": None} | over


def detail(created=NOW - timedelta(minutes=10), parcels=None, **over):
    ps = parcels or [{"orderParcelSeq": 11, "status": "ACTIVE", **parcel()}]
    return {"orderSeq": 5, "status": "COLLECTING", "version": 3, "createdAt": created.isoformat().replace("+00:00", "Z"),
            "paymentMethodType": None, "pickupRequestedAt": None, "parcels": ps} | over


def state(cand=None, **over):
    st = ConversationState(customer=Customer(status="REGISTERED", customer_seq=12, name="김철수", caller_phone=CALLER,
                                             payment_methods=("billing",)), intent="order")
    st.resume = cand or resume_candidate(detail())
    for k, v in over.items():
        setattr(st, k, v)
    return st


# --- 후보·기한·불러오기(순수 함수) ---

def test_candidate_is_latest_active_parcel_with_other_fares():
    d = detail(parcels=[{"orderParcelSeq": 11, "status": "ACTIVE", **parcel(notifiedPrice=4000)},
                        {"orderParcelSeq": 15, "status": "ACTIVE", **parcel(destination=DEST | {"name": "박민수"})},
                        {"orderParcelSeq": 19, "status": "CANCELLED", **parcel()}])
    c = resume_candidate(d)
    assert (c.order_seq, c.version, c.parcel_seq, c.other_fares) == (5, 3, 15, (4000,))
    assert c.parcel["receiver_name"] == "박민수" and c.parcel["items"] == Items(small_box_count=1)
    assert c.parcel["receiver_address_detail"] == "" and c.parcel["sender_geo"].postal_code == "06236"
    assert resume_candidate(detail(status="notPaid")) is None
    assert resume_candidate(detail(parcels=[{"orderParcelSeq": 1, "status": "CANCELLED", **parcel()}])) is None


def test_window_is_one_week_from_created_at():
    c = resume_candidate(detail())
    assert within_window(c, NOW, WEEK)
    assert within_window(resume_candidate(detail(created=NOW - timedelta(days=7, minutes=-1))), NOW, WEEK)
    assert not within_window(resume_candidate(detail(created=NOW - timedelta(days=7, minutes=1))), NOW, WEEK)
    assert not within_window(ResumeCandidate(5, 3, "not-a-date", 11, {}), NOW, WEEK)
    assert not within_window(ResumeCandidate(5, 3, "2026-11-06T02:50:00", 11, {}), NOW, WEEK)  # 시간대 없음


def test_offer_only_once_before_customer_gives_parcel_values():
    assert can_offer(state(), NOW, WEEK)
    assert not can_offer(state(resume_offered=True), NOW, WEEK)
    assert not can_offer(state(intent="lookup"), NOW, WEEK)
    st = state()
    st.record("receiver_name", "박민수")  # 고객이 이미 택배 정보를 말함
    assert not can_offer(st, NOW, WEEK)
    st = state()
    st.record("sender_phone", CALLER, Source.CALLER_ID)  # 서버가 채운 발신번호는 상관없다
    assert can_offer(st, NOW, WEEK)


def test_load_resumed_marks_history_and_rereads_address_without_geo():
    st = state()
    load_resumed(st, 4, P.input_limits)
    cur = st.current
    assert st.resume_version == 4 and st.origin_applied and cur.order_parcel_seq == 11
    assert cur["receiver_name"].source == Source.HISTORY and cur["item_price"].value == 30000
    st = state(resume_candidate(detail(parcels=[{"orderParcelSeq": 11, "status": "ACTIVE",
                                                 **parcel(destination={"name": "이영희", "roadAddress": "부산 어딘가"})}])))
    load_resumed(st, 4, P.input_limits)
    assert st.current["receiver_address"].status == FieldStatus.EMPTY and st.current["receiver_name"].valid


def test_load_resumed_document_draft_sets_server_value():
    cand = resume_draft_candidate({"draftSeq": 7, "version": 1, "createdAt": NOW.isoformat(),
                                   "parcel": parcel(documentCount=2, smallBoxCount=0, itemPrice=None)})
    st = state(cand)
    load_resumed(st, 1, P.input_limits, client_parcel_id="document-draft")
    assert (st.current["item_price"].value, st.current["item_price"].source) == (1, Source.SERVER)
    assert "item_price" not in assess(st, P).missing


def test_load_resumed_box_price_is_rounded():
    cand = resume_draft_candidate({"draftSeq": 7, "version": 1, "createdAt": NOW.isoformat(),
                                   "parcel": parcel(itemPrice=128_000)})
    st = state(cand)
    load_resumed(st, 1, P.input_limits, client_parcel_id="box-draft")
    assert (st.current["item_price"].value, st.current["item_price"].source) == (130_000, Source.HISTORY)


# --- BE 본문 ---

def test_link_body_resaves_an_existing_value():
    assert link_body(3, detail(paymentMethodType="credit"), 11) == {"expectedVersion": 3, "paymentMethodType": "credit"}
    assert link_body(3, detail(pickupRequestedAt="2026-11-06T13:00:00+09:00"), 11)["pickupRequestedAt"]
    assert link_body(3, detail(), 11) == {"expectedVersion": 3, "parcels": [{"orderParcelSeq": 11, "clientComment": ""}]}


def test_resume_body_zeroes_omitted_counts_on_existing_parcel():
    body = resume_body([(Order(medium_box_count=1, item_price=1000), 5000, 11), (Order(document_count=2), 3000, None)],
                       "billing", None, 8000)
    old, new = body["parcels"]
    assert old["orderParcelSeq"] == 11 and old["smallBoxCount"] == 0 and old["mediumBoxCount"] == 1
    assert old["otherItemDescription"] == "" and "orderParcelSeq" not in new and "smallBoxCount" not in new
    assert "expectedVersion" not in body and body["totalAmount"] == 8000 and body["paymentMethodType"] == "billing"


def test_api_paths_and_call_header():
    seen = []

    def handler(req):
        seen.append(req)
        if req.method == "GET":
            return httpx2.Response(200, json={"data": [{"orderSeq": 5}]})
        if req.method == "PATCH":
            return httpx2.Response(200, json={"data": {"version": 9}})
        return httpx2.Response(202, json={"data": {"status": "SUBMITTING"}})

    api = BackendAPI("http://backend", 3.0, transport=httpx2.MockTransport(handler))
    assert run(api.collecting_orders(20, 1)) == [{"orderSeq": 5}]
    assert run(api.patch_order(20, 5, {"expectedVersion": 3, "paymentMethodType": "billing"})) == 9
    assert run(api.submit_order(20, 5, 9)) == {"status": "SUBMITTING"}
    assert [(r.method, r.url.path) for r in seen] == [("GET", "/api/orders"), ("PATCH", "/api/orders/5"),
                                                      ("POST", "/api/orders/5/submit")]
    assert dict(seen[0].url.params) == {"status": "COLLECTING", "limit": "1"}
    assert all(r.headers["call_session_seq"] == "20" for r in seen)
    assert json.loads(seen[2].content) == {"expectedVersion": 9}


# --- 통화(가짜 OpenAI·가짜 BE) ---

def _setup(tmp_path, minutes_ago=10):
    svc, client = flow(tmp_path)
    svc.d.cfg.resume_window_sec = WEEK
    db = svc.d.backend.api
    db.add_customer(CALLER, "김철수")
    created = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")
    order_seq = db.add_order(CALLER, "COLLECTING", [], parcels=[parcel()], created_at=created)
    return svc, client, db, order_seq


def _facts(conn, key):
    for e in conn.sent:
        content = e.get("content") or ""
        if f'"{key}"' in content:
            return json.loads(content.split("[서버 결과] ", 1)[1])
    return None


async def _open(svc, client):
    task = asyncio.create_task(svc.on_incoming(incoming()))
    await until(lambda: client.conns)
    conn = client.conns[0]
    conn.push(started())
    await until(lambda: svc.registry.calls["live_1"].phase == Phase.ACTIVE)
    return task, conn, svc.registry.calls["live_1"]


def test_default_call_does_not_offer_or_load_previous_incomplete_order(tmp_path):
    svc, client, _, _ = _setup(tmp_path)
    svc.d.cfg.resume_window_sec = 0

    async def scenario():
        task, conn, s = await _open(svc, client)
        await say(conn, "택배 보내려고요", 1000)
        await until(lambda: s.state.customer.call_session_seq is not None)
        assert s.rt.resume_task is None and s.state.resume is None
        assert _facts(conn, "resume_confirm") is None
        assert "resume_confirm" not in svc.session_config(s, None)["instructions"]
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task

    run(scenario())


def test_resume_yes_confirms_then_patches_and_submits_without_new_order(tmp_path):
    svc, client, db, order_seq = _setup(tmp_path)

    async def scenario():
        task, conn, s = await _open(svc, client)
        await say(conn, "택배 보내려고요", 1000)
        await until(lambda: _facts(conn, "resume_confirm"))
        assert _facts(conn, "resume_confirm")["resume_confirm"] == {"receiver_name": "이영희"}
        assert "origin_confirm" not in _facts(conn, "resume_confirm")  # 출발지보다 먼저 묻는다
        await ai(conn, "아까 이영희 님께 보내시던 택배 접수를 이어서 진행할까요?", 2000)
        await say(conn, "네 이어서 해 주세요", 3000)
        await until(lambda: _facts(conn, "resume"))
        loaded = _facts(conn, "resume")
        assert loaded["resume"] == "loaded" and "readback" in loaded  # 빠진 항목 없음 → 바로 되읽기
        assert db.linked[s.state.customer.call_session_seq] == order_seq  # 동의 직후 PATCH로 통화 연결
        await ai(conn, "받는 분 이영희님, 부산 해운대구 센텀로 10. 맞으세요?", 4000)
        await say(conn, "네 맞아요", 5000)
        await until(lambda: s.state.parcels)
        await ai(conn, "담아 두었어요. 더 보내실 택배 있으세요?", 6000)
        await say(conn, "아니요 없어요", 7000)
        await until(lambda: s.phase == Phase.CLOSING)
        await ai(conn, "감사합니다.", 8000)
        await task
        return s

    s = run(scenario())
    order = next(o for o in db.orders if o["orderSeq"] == order_seq)
    assert db.results == []  # 새 주문(POST /api/orders)을 만들지 않았다
    assert order["status"] == "notPaid" and order["totalAmount"] == 4000 and len(order["parcels"]) == 1
    assert order["parcels"][0]["notifiedPrice"] == 4000 and order["paymentMethodType"] == "billing"
    assert s.result == {"orderSeq": order_seq, "status": "notPaid"}
    assert db.analyses[s.state.customer.call_session_seq]["registeredParcelCount"] == 1


def test_resume_then_hangup_saves_with_patch_only(tmp_path):
    svc, client, db, order_seq = _setup(tmp_path)

    async def scenario():
        task, conn, s = await _open(svc, client)
        await say(conn, "택배 보내려고요", 1000)
        await until(lambda: _facts(conn, "resume_confirm"))
        await ai(conn, "아까 이영희 님께 보내시던 택배 접수를 이어서 진행할까요?", 2000)
        await say(conn, "네", 3000)
        await until(lambda: _facts(conn, "resume"))
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s

    s = run(scenario())
    order = next(o for o in db.orders if o["orderSeq"] == order_seq)
    assert db.results == [] and order["status"] == "COLLECTING" and order["version"] == 3  # 연결 PATCH + 저장 PATCH
    assert s.result == {"orderSeq": order_seq, "status": "COLLECTING"}


def test_resume_declined_or_expired_takes_a_new_order(tmp_path):
    for said, minutes_ago in (("아니요 새로 할게요", 10), (None, 7 * 24 * 60 + 1)):
        svc, client, db, order_seq = _setup(tmp_path / str(minutes_ago), minutes_ago)

        async def scenario():
            task, conn, s = await _open(svc, client)
            await say(conn, "택배 보내려고요", 1000)
            await until(lambda: _facts(conn, "intent"))
            if said:
                await ai(conn, "아까 이영희 님께 보내시던 택배 접수를 이어서 진행할까요?", 2000)
                await say(conn, said, 3000)
                await until(lambda: _facts(conn, "resume"))
                assert _facts(conn, "resume")["resume"] == "declined"
            else:
                await asyncio.sleep(0.2)
                assert _facts(conn, "resume_confirm") is None  # 일주일이 지나면 묻지 않는다
            conn.push({"type": "session.closed", "reason": "remote_hangup"})
            await task
            return s

        s = run(scenario())
        assert s.state.resume_version is None and db.linked == {}
        assert next(o for o in db.orders if o["orderSeq"] == order_seq)["version"] == 1  # 이전 주문은 그대로


# --- 2단계: 남은 변경 계산(순수 함수) ---

def test_remaining_patch_sends_only_differences_and_never_duplicates_a_new_parcel():
    target = {"parcels": [{"orderParcelSeq": 11, **parcel(clientComment="문 앞")}, parcel(destination=DEST | {"name": "박민수"})],
              "paymentMethodType": "billing", "pickupRequestedAt": "2026-11-07T10:00:00+09:00", "totalAmount": 8000}
    d = detail(paymentMethodType="billing", pickupRequestedAt="2026-11-07T01:00:00Z")  # 같은 시각 다른 표기
    assert remaining_patch(target, d, [11]) == {"totalAmount": 8000, "parcels": [
        {"orderParcelSeq": 11, "clientComment": "문 앞"}, target["parcels"][1]]}
    # PATCH는 저장됐는데 응답만 잃음 → 다시 읽으면 보낼 것이 없다(새 상세 23을 다시 추가하지 않는다)
    saved = detail(paymentMethodType="billing", pickupRequestedAt="2026-11-07T01:00:00Z", totalAmount=8000, parcels=[
        {"orderParcelSeq": 11, "status": "ACTIVE", **parcel(clientComment="문 앞")},
        {"orderParcelSeq": 23, "status": "ACTIVE", **parcel(destination=DEST | {"name": "박민수"})}])
    assert remaining_patch(target, saved, [11]) == {}
    # 이어받을 때 있던 상세(11)는 새 상세의 짝이 아니다 / 관리자가 그새 바꾼 값은 고객이 확인한 값으로 덮는다
    admin = detail(paymentMethodType="billing", pickupRequestedAt="2026-11-07T01:00:00Z", totalAmount=8000, parcels=[
        {"orderParcelSeq": 11, "status": "ACTIVE", **parcel(clientComment="문 앞", itemPrice=50000,
                                                            destination=DEST | {"name": "박민수"})}])
    assert remaining_patch(target, admin, [11])["parcels"] == [
        {"orderParcelSeq": 11, "itemPrice": 30000, "destination": {"name": "이영희"}}, target["parcels"][1]]


# --- 2단계: 아웃박스 전송(가짜 BE) ---

SEQ = 20


def _outbox_case(tmp_path, submit=True, new_parcel=False):
    db = MockBackend()
    db.add_customer(CALLER, "김철수")
    db.call_sessions[SEQ] = CALLER
    order_seq = db.add_order(CALLER, "COLLECTING", [], parcels=[parcel()])
    base = db.orders[-1]["parcels"][0]["orderParcelSeq"]
    db.linked[SEQ] = order_seq  # 통화 중 연결 PATCH를 했다
    parcels = [{"orderParcelSeq": base, **parcel(notifiedPrice=4000, clientComment="문 앞")}]
    if new_parcel:
        parcels.append(parcel(destination=DEST | {"name": "박민수"}, notifiedPrice=4000))
    target = {"parcels": parcels, "paymentMethodType": "billing", "totalAmount": 4000 * len(parcels)}
    body = {"resume": {"orderSeq": order_seq, "callSessionSeq": SEQ, "baseSeqs": [base], "target": target,
                       "submit": submit, "cancel": None, "onlyParcel": True}}
    outbox = Outbox(tmp_path / "outbox.sqlite3")
    outbox.create_result("live_1", "key-1", body)
    rs = ResultService(BackendGateway(db), outbox, P, fare)
    return rs, db, next(o for o in db.orders if o["orderSeq"] == order_seq)


def _lose_first(db, method):
    """첫 호출은 BE에 반영되지만 응답을 잃는다(연결 끊김)."""
    real, calls = getattr(db, method), []

    async def wrapped(*a):
        calls.append(a)
        out = await real(*a)
        if len(calls) == 1:
            raise BackendError("connection reset", None, "TRANSPORT")
        return out
    setattr(db, method, wrapped)
    return calls


def test_restart_recovery_patches_and_submits_never_posts(tmp_path):
    rs, db, order = _outbox_case(tmp_path)
    run(rs.recover())  # 재시작 복구가 이어받기 행을 새 주문 POST로 보내지 않는다
    assert db.results == [] and order["status"] == "notPaid" and order["parcels"][0]["clientComment"] == "문 앞"
    assert rs.outbox.result("live_1")["status"] == "DONE" and rs.outbox.unfinished_results() == []


def test_lost_patch_response_is_reconciled_without_duplicate_parcel(tmp_path):
    rs, db, order = _outbox_case(tmp_path, new_parcel=True)
    patches = _lose_first(db, "patch_order")
    assert run(rs._send(rs.outbox.result("live_1"))) is None
    assert rs.outbox.result("live_1")["status"] == "SENT_UNCERTAIN" and order["status"] == "COLLECTING"
    data = run(rs._send(rs.outbox.result("live_1")))  # 주기 재확인: 다시 읽으니 보낼 PATCH가 없다 → 확정만
    assert len(patches) == 1 and len(order["parcels"]) == 2 and data["status"] == "notPaid"


def test_version_conflict_rereads_and_customer_value_wins(tmp_path):
    rs, db, order = _outbox_case(tmp_path)
    real = db.patch_order

    async def admin_first(*a):
        if order["version"] == 1:  # 우리 PATCH 직전에 관리자가 요청사항을 고침
            order["parcels"][0]["clientComment"], order["version"] = "경비실", 2
        return await real(*a)
    db.patch_order = admin_first
    data = run(rs._send(rs.outbox.result("live_1")))
    assert data["status"] == "notPaid" and order["parcels"][0]["clientComment"] == "문 앞"


def test_three_conflicts_stay_for_retry_and_changed_order_fails(tmp_path):
    rs, db, order = _outbox_case(tmp_path)

    async def always_conflict(*a):
        raise BackendError("409", 409, "VERSION_CONFLICT")
    db.patch_order = always_conflict
    assert run(rs._send(rs.outbox.result("live_1"))) is None
    assert rs.outbox.result("live_1")["status"] == "SENT_UNCERTAIN"
    order["status"] = "CANCELLED"  # 관리자가 주문을 취소함 → 다시 보내지 않는다
    assert run(rs._send(rs.outbox.result("live_1"))) is None
    row = rs.outbox.result("live_1")
    assert row["status"] == "FAILED" and row["data"]["error"] == "INVALID_STATE" and rs.outbox.unfinished_results() == []


def test_submit_after_call_ended_saves_patch_and_fails_for_staff(tmp_path):
    rs, db, order = _outbox_case(tmp_path)
    db.ended.add(SEQ)
    assert run(rs._send(rs.outbox.result("live_1"))) is None
    row = rs.outbox.result("live_1")
    assert row["status"] == "FAILED" and row["data"]["errorCode"] == "INVALID_STATE"
    assert order["status"] == "COLLECTING" and order["totalAmount"] == 4000 and order["parcels"][0]["clientComment"] == "문 앞"


def test_lost_link_response_relinks_with_current_version(tmp_path):
    svc, client, db, order_seq = _setup(tmp_path)
    links = _lose_first(db, "patch_order")

    async def scenario():
        task, conn, s = await _open(svc, client)
        await say(conn, "택배 보내려고요", 1000)
        await until(lambda: _facts(conn, "resume_confirm"))
        await ai(conn, "아까 이영희 님께 보내시던 택배 접수를 이어서 진행할까요?", 2000)
        await say(conn, "네", 3000)
        await until(lambda: _facts(conn, "resume"))
        assert _facts(conn, "resume")["resume"] == "loaded" and s.state.resume_version == 3
        conn.push({"type": "session.closed", "reason": "remote_hangup"})
        await task
        return s

    run(scenario())
    assert len(links) >= 2 and db.results == []  # 같은 값 PATCH 한 번 더로 연결 확정, 새 주문 없음
