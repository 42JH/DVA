"""미완료 주문 이어받기 1단계(사용자 결정 2026-11-06): createdAt 일주일 안 → 먼저 묻고 → 예면 같은 값 PATCH로 연결 →
가장 최근 상세 1건을 불러와 빠진 항목·되읽기 → 확정은 PATCH + submit(새 주문 POST 없음). 끊기면 PATCH만."""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx2
from conftest import CALLER, run

from app.calls.session import Phase
from app.domain.resume import can_offer, load_resumed, within_window
from app.domain.state import ConversationState, Customer, FieldStatus, Items, ResumeCandidate, Source
from app.integrations.backend.mapping import resume_candidate
from app.tests.test_calls import incoming, started, until
from app.tests.test_live_flow import ai, flow, say
from backend_client.api import BackendAPI, link_body, resume_body
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
    load_resumed(st, 4)
    cur = st.current
    assert st.resume_version == 4 and st.origin_applied and cur.order_parcel_seq == 11
    assert cur["receiver_name"].source == Source.HISTORY and cur["item_price"].value == 30000
    st = state(resume_candidate(detail(parcels=[{"orderParcelSeq": 11, "status": "ACTIVE",
                                                 **parcel(destination={"name": "이영희", "roadAddress": "부산 어딘가"})}])))
    load_resumed(st, 4)
    assert st.current["receiver_address"].status == FieldStatus.EMPTY and st.current["receiver_name"].valid


# --- BE 본문 ---

def test_link_body_resaves_an_existing_value():
    assert link_body(3, detail(paymentMethodType="credit"), 11) == {"expectedVersion": 3, "paymentMethodType": "credit"}
    assert link_body(3, detail(pickupRequestedAt="2026-11-06T13:00:00+09:00"), 11)["pickupRequestedAt"]
    assert link_body(3, detail(), 11) == {"expectedVersion": 3, "parcels": [{"orderParcelSeq": 11, "clientComment": ""}]}


def test_resume_body_zeroes_omitted_counts_on_existing_parcel():
    body = resume_body(4, [(Order(medium_box_count=1, item_price=1000), 5000, 11), (Order(document_count=2), 3000, None)],
                       "billing", None, 8000)
    old, new = body["parcels"]
    assert old["orderParcelSeq"] == 11 and old["smallBoxCount"] == 0 and old["mediumBoxCount"] == 1
    assert old["otherItemDescription"] == "" and "orderParcelSeq" not in new and "smallBoxCount" not in new
    assert body["expectedVersion"] == 4 and body["totalAmount"] == 8000 and body["paymentMethodType"] == "billing"


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
