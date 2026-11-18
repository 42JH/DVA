"""도메인 단위 테스트: Business State·assess·확인 관문(G1~G5)·담은 택배 수정(P5)·통화 결과."""

from datetime import datetime, timedelta, timezone

import pytest

from app.domain.assess import assess, readback_facts
from app.domain.claims import unverified_values
from app.domain.confirm import ConfirmAnswer, Utterance, check_gate, commit_parcel, issue_parcel_confirmation, release
from app.domain.outcome import decide_outcome
from app.domain.state import ConversationState, Customer, FieldStatus, Geo, Items, Source
from app.domain.store import open_for_edit, pending_reconfirm, snapshot_for_submit
from app.integrations.backend.mapping import submit_body
from app.policy.model import load_policy

P = load_policy()
KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 11, 3, 10, 0, tzinfo=KST)
PICKUP = (NOW + timedelta(days=1)).isoformat()
GEO = Geo("서울 강남구 역삼동 737", "역삼동", "06236")
YES = ConfirmAnswer("yes", {"yes": 0.97, "no": 0.01, "change": 0.01, "not_answer": 0.01})


def filled(receiver="이영희", **over) -> ConversationState:
    # 등록 주소에서 보내는 등록 고객(발송 주소가 등록 주소와 같아 등록 주소 변경 질문이 없다)
    s = ConversationState(customer=Customer(customer_seq=12, name="김철수", caller_phone="01012345678",
                                            payment_methods=("billing",), default_address=over.get(
                                                "sender_address", "서울 강남구 테헤란로 212"),
                                            default_address_detail=over.get("sender_address_detail", "1201호")),
                          intent="order")
    s.record("sender_phone", "01012345678", Source.CALLER_ID)
    values = {"sender_name": "김철수", "sender_address": "서울 강남구 테헤란로 212", "sender_address_detail": "1201호",
              "receiver_name": receiver, "receiver_phone": "01098765432", "receiver_address": "부산 해운대구 센텀로 10",
              "receiver_address_detail": "", "items": Items(small_box_count=1), "item_price": 30000,
              "pickup_at": PICKUP} | over
    for k, v in values.items():
        s.record(k, v)
    s.current.sender_geo = s.current.receiver_geo = GEO
    return s


def confirm_once(s: ConversationState, t: float = 100.0) -> str:
    p = issue_parcel_confirmation(s, P, t)
    gate = check_gate(s, P, p.id, YES, Utterance(2, 5000, 5400, t + 3),
                      Utterance(1, 3000, 4800, t + 1, "이대로 접수할까요?", p.id),
                      latest_applied_utterance=None, closed=False)
    assert gate.ok, gate
    return commit_parcel(s, P, p.id)


# --- state ---

def test_record_versions_and_invalid_correction_keeps_value():
    s = ConversationState(intent="order")
    assert s.record("receiver_phone", "01098765432")
    v = s.field_of("receiver_phone").version
    assert not s.record("receiver_phone", "01098765432")  # 같은 값은 버전 그대로
    s.record_invalid("receiver_phone", "PHONE_INVALID_DIGITS")  # 잘못 들은 정정
    f = s.field_of("receiver_phone")
    assert (f.value, f.status, f.attempts, f.code) == ("01098765432", FieldStatus.VALID, 1, "PHONE_INVALID_DIGITS")
    assert f.version > v and s.current.receiver_phone_pending
    s.record_invalid("receiver_address", "ADDRESS_NOT_FOUND")
    assert s.field_of("receiver_address").status == FieldStatus.INVALID


# --- assess ---

def test_assess_stage_progression_and_missing_order():
    s = ConversationState()
    assert assess(s, P).stage == "intent"
    s.intent = "order"
    assert assess(s, P).stage == "sender"
    s.record("sender_name", "김철수")
    a = assess(s, P)
    assert a.stage == "sender" and a.missing[0] == "sender_address" and not a.readback_ready
    s.record("receiver_name", "이영희")
    s.record("receiver_phone", "01098765432")
    a = assess(s, P)
    assert a.stage == "sender" and a.missing[0] == "sender_address"
    s.record("sender_address", "서울 강남구 테헤란로 212")
    assert assess(s, P).missing[0] == "sender_address_detail"
    s.record("sender_address_detail", "")
    a = assess(s, P)
    assert a.stage == "receiver" and a.missing[0] == "receiver_address"
    s = filled()
    a = assess(s, P)
    assert (a.stage, a.missing, a.readback_ready) == ("readback", (), True)
    s.record_invalid("item_price", "x")  # VALID 유지
    s.clear("receiver_address_detail")
    a = assess(s, P)
    assert a.stage == "receiver" and a.missing == ("receiver_address_detail",) and not a.readback_ready


def test_assess_blocked_attempts_and_payment():
    s = ConversationState(intent="order", customer=Customer(payment_methods=("credit", "groupBilling")))
    for _ in range(P.reask.max_attempts):
        s.record_invalid("sender_address", "ADDRESS_NOT_FOUND")
    a = assess(s, P)
    assert a.stages["sender"].blocked == ("sender_address",) and a.attempts_exceeded == ("sender_address",)
    assert a.payment_auto == "groupBilling"


@pytest.mark.parametrize("methods, want", [
    (("billing",), "billing"), (("billing", "credit"), "credit"), (("billing", "groupBilling"), "groupBilling"),
    (("billing", "credit", "groupBilling"), "groupBilling"), (("credit", "groupBilling"), "groupBilling"),
    ((), None),  # 기본 billing 없음(BE 최신 규약)
])
def test_payment_is_never_asked_and_picked_from_methods(methods, want):
    assert assess(ConversationState(customer=Customer(payment_methods=methods)), P).payment_auto == want


def test_assess_after_parcels():
    s = filled()
    confirm_once(s)
    assert assess(s, P).stage == "more_parcels"
    assert assess(s, P).missing == ()  # 담은 뒤(받는 중 아님)에는 빠진 항목 없음(관제 표시)
    s.no_more_parcels = True
    assert assess(s, P).stage == "closing"
    s.customer.payment_methods = ("credit", "groupBilling")
    assert assess(s, P).stage == "closing"  # 결제 단계 없음: 더 없음 → 바로 마무리


def test_readback_facts_are_names_and_dong_only():
    """되읽기는 성함과 동 이름만(S15P31D109-164, 사용자 결정 2026-11-09). 주소·연락처·상세주소·물품·가액은 주지 않는다."""
    s = filled()
    snap = issue_parcel_confirmation(s, P, 1.0).snapshot
    assert readback_facts(snap) == {"sender_name": "김철수", "from": "역삼동", "receiver_name": "이영희", "to": "역삼동"}
    # 보정 실패로 geo가 없으면 건물번호를 뺀 주소로 대신한다
    assert readback_facts(snap | {"receiver_geo": None})["to"] == "부산 해운대구 센텀로"


# --- 확인 관문 ---

def test_issue_requires_readback_ready_and_is_idempotent():
    s = filled()
    s.clear("item_price")
    assert issue_parcel_confirmation(s, P, 1.0) is None  # 빠진 항목이 있으면 되읽기 gate 닫힘
    s.record("item_price", 30000)
    p1 = issue_parcel_confirmation(s, P, 1.0)
    assert issue_parcel_confirmation(s, P, 2.0) is p1


@pytest.mark.parametrize("case, code", [
    ("closed", "CALL_ENDING"), ("other_id", "DECISION_STALE"), ("newer_utterance", "DECISION_STALE"),
    ("low_yes", "CONFIRM_UNCLEAR"), ("change", "CONFIRM_UNCLEAR"), ("no_prev_ai", "CONFIRM_BEFORE_READBACK_END"),
    ("readback_before_issue", "CONFIRM_BEFORE_READBACK_END"), ("answer_during_readback", "CONFIRM_BEFORE_READBACK_END"),
    ("field_changed", "CONFIRM_SNAPSHOT_CHANGED"),
])
def test_gate_rejections(case, code):
    s = filled()
    p = issue_parcel_confirmation(s, P, 100.0)
    answer, cust = YES, Utterance(5, 5000, 5400, 104.0)
    ai = Utterance(4, 3000, 4800, 101.0, "이대로 접수할까요?", p.id)
    kw = {"latest_applied_utterance": None, "closed": False}
    pid = p.id
    if case == "closed":
        kw["closed"] = True
    elif case == "other_id":
        pid = "pc-old"
    elif case == "newer_utterance":
        kw["latest_applied_utterance"] = 6
    elif case == "low_yes":
        answer = ConfirmAnswer("yes", {"yes": 0.5, "change": 0.1})
    elif case == "change":
        answer = ConfirmAnswer("yes", {"yes": 0.7, "change": 0.3})
    elif case == "no_prev_ai":
        ai = None
    elif case == "readback_before_issue":  # Live가 확인 내용을 받기 전에 되읽음(S0b b1)
        ai = Utterance(4, 3000, 4800, 99.0)
    elif case == "answer_during_readback":  # 끝까지 듣기 전 "네"(원본 11-02 사고)
        cust = Utterance(5, 4000, 4400, 104.0)
    elif case == "field_changed":  # 확인 중 같은 발화의 위임이 받는 분을 바꿈
        s.record("receiver_name", "박민수")
    assert check_gate(s, P, pid, answer, cust, ai, **kw).code == code


def test_commit_rechecks_snapshot_and_release():
    s = filled()
    p = issue_parcel_confirmation(s, P, 1.0)
    s.record("item_price", 50000)  # 확정 지연 중 정정
    assert commit_parcel(s, P, p.id) is None and s.parcels == []
    p = issue_parcel_confirmation(s, P, 2.0)
    assert release(s, p.id) and s.pending is None
    p = issue_parcel_confirmation(s, P, 3.0)
    assert commit_parcel(s, P, p.id) == "p1" and s.current is None and s.pending is None
    assert commit_parcel(s, P, p.id) is None  # 같은 확인 두 번 → 실행 1회


# --- 담은 택배 수정(P5) ---

def test_edit_parcel_then_submit_uses_last_confirmed_snapshot_until_reconfirmed():
    s = filled()
    confirm_once(s)
    open_for_edit(s, "p1")
    s.record("receiver_name", "박민수")
    assert pending_reconfirm(s) == ["p1"]
    assert snapshot_for_submit(s)[0]["receiver_name"] == "이영희"  # B안: 미확인 수정은 보내지 않음
    assert confirm_once(s, t=200.0) == "p1" and len(s.parcels) == 1
    assert pending_reconfirm(s) == [] and snapshot_for_submit(s)[0]["receiver_name"] == "박민수"


def test_edit_while_collecting_new_parcel_keeps_it_unconfirmed():
    s = filled()
    confirm_once(s)
    s.record("receiver_name", "최지우")  # 두 번째 택배 받는 중
    open_for_edit(s, "p1")
    assert [p.confirmed_snapshot is None for p in s.parcels] == [False, True]
    assert len(snapshot_for_submit(s)) == 1  # 한 번도 확인받지 않은 택배는 보내지 않는다


# --- 통화 결과 ---

def fare(p):
    return 4000


def test_outcome_complete_and_body():
    s = filled()
    confirm_once(s)
    o = decide_outcome(s, P, NOW, fare)
    assert (o.kind, o.payment, o.fares, o.reasons) == ("COMPLETE", "billing", (4000,), ())
    assert pending_reconfirm(s) == [] and "pickup_at" not in o.parcels[0]
    call = {"providerCallId": "live_1", "callerPhoneNumber": "01012345678", "incomingAt": "2026-11-03T01:00:00Z"}
    body = submit_body(o, call, 12, None, "01012345678")
    assert body["outcome"] == "COMPLETE" and body["totalAmount"] == 4000 and body["pickupRequestedAt"].endswith("+09:00")
    assert body["parcels"][0]["smallBoxCount"] == 1 and body["parcels"][0]["destination"]["postalCode"] == "06236"


@pytest.mark.parametrize("change, reason", [
    (lambda s: setattr(s.parcels[0].draft, "receiver_geo", None), None),  # 확인 뒤 geo 변경은 스냅샷에 영향 없음
    (lambda s: setattr(s, "agent_transferred", True), "AGENT_TRANSFER"),
    (lambda s: s.customer.__setattr__("customer_seq", None) or s.customer.__setattr__("name", None), None),  # 이름 = 보내는 분
    (lambda s: s.customer.__setattr__("payment_methods", ()), "PAYMENT_UNKNOWN"),
])
def test_outcome_incomplete_reasons(change, reason):
    s = filled()
    confirm_once(s)
    change(s)
    o = decide_outcome(s, P, NOW, fare)
    assert (o.kind == "COMPLETE") if reason is None else (o.kind == "INCOMPLETE" and reason in o.reasons)


def test_outcome_fare_geo_pickup_and_empty_cases():
    s = filled()
    s.current.receiver_geo = None
    confirm_once(s)
    o = decide_outcome(s, P, NOW, lambda p: None)
    assert o.kind == "INCOMPLETE" and {"ADDRESS_GEO_MISSING", "FARE_UNKNOWN"} <= set(o.reasons)
    assert decide_outcome(ConversationState(), P, NOW, fare).kind is None  # 무의미 통화: 보내지 않음
    o = decide_outcome(ConversationState(intent="inquiry"), P, NOW, fare)
    assert (o.kind, o.parcels) == ("INCOMPLETE", ())  # 문의만: 빈 결과 → BE NO_ORDER
    s = filled()
    s.order_cancelled = True
    assert decide_outcome(s, P, NOW, fare).kind == "CANCELLED"


def test_domain_and_policy_do_not_import_sdk_http_or_be_contract():
    """overview.md §2.1: domain·policy는 SDK·HTTP·BE 계약을 import하지 않는다."""
    import ast
    from pathlib import Path
    banned = ("openai", "httpx", "httpx2", "fastapi", "backend_client", "app.integrations")
    for d in ("app/domain", "app/policy"):
        for f in Path(d).glob("*.py"):
            tree = ast.parse(f.read_text(encoding="utf-8"))
            names = [n.module or "" for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
            names += [a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names]
            assert not [m for m in names if m.split(".")[0] in banned or m.startswith(banned)], f


def test_gate_requires_previous_ai_line_to_be_the_question():
    """S5 실통화 2: 되읽기 도중("…연락처는") 고객 "네, 됐습니다" → 확인 질문을 듣지 않은 답이라 확정하지 않는다."""
    s = filled()
    p = issue_parcel_confirmation(s, P, 100.0)
    cust = Utterance(5, 5000, 5400, 104.0, "네")
    cut = Utterance(4, 3000, 4800, 101.0, "접수 내용을 확인하겠습니다. 보내시는 분 김철수 님, 연락처는")
    asked = Utterance(4, 3000, 4800, 101.0, "이대로 접수해 드릴까요?")
    kw = {"latest_applied_utterance": None, "closed": False}
    assert check_gate(s, P, p.id, YES, cust, cut, **kw).code == "CONFIRM_BEFORE_READBACK_END"
    assert check_gate(s, P, p.id, YES, cust, asked, **kw).ok
    proceed = ConfirmAnswer("proceed", {"proceed": 0.98})
    assert check_gate(s, P, p.id, proceed, cust, asked, **kw).ok
    for question, readback_id in (("가방 크기가 어느 정도인가요?", None), ("중형 박스가 맞으세요?", p.id), ("", p.id)):
        unrelated = Utterance(4, 3000, 4800, 101.0, question, readback_id)
        for answer in (YES, proceed):
            assert check_gate(s, P, p.id, answer, cust, unrelated, **kw).code == "CONFIRM_BEFORE_READBACK_END"
    unlinked = Utterance(4, 3000, 5500, 101.0, "접수 내용 확인 부탁드릴게요. 보내는 분은")
    assert check_gate(s, P, p.id, proceed, cust, unlinked, **kw).code == "CONFIRM_BEFORE_READBACK_END"
    stale = Utterance(4, 3000, 4800, 101.0, asked.text, "old-pending")
    assert check_gate(s, P, p.id, proceed, cust, stale, **kw).code == "CONFIRM_BEFORE_READBACK_END"
    interrupted = Utterance(4, 3000, 5500, 101.0, "바뀐 받는 분은", p.id)
    explicit_yes = Utterance(5, 5000, 5400, 104.0, "네, 그렇게 접수해 주세요")
    short_yes = Utterance(5, 5000, 5400, 104.0, "네, 맞아요")
    mixed_change = Utterance(5, 5000, 5400, 104.0, "주소를 바꿔서 접수해 주세요")
    assert check_gate(s, P, p.id, YES, explicit_yes, interrupted, **kw).ok
    assert check_gate(s, P, p.id, proceed, explicit_yes, interrupted, **kw).ok
    for early in (short_yes, mixed_change):
        for answer in (YES, proceed):
            assert check_gate(s, P, p.id, answer, early, interrupted, **kw).code == "CONFIRM_BEFORE_READBACK_END"
    assert check_gate(s, P, p.id, YES, explicit_yes, unlinked, **kw).code == "CONFIRM_BEFORE_READBACK_END"
    s.record("item_price", 31000)
    assert check_gate(s, P, p.id, proceed, explicit_yes, interrupted, **kw).code == "CONFIRM_SNAPSHOT_CHANGED"
    assert check_gate(s, P, p.id, YES, explicit_yes, interrupted, **kw).code == "CONFIRM_SNAPSHOT_CHANGED"


def test_unregistered_customer_name_is_sender_name_in_body():
    """버그 A(S6): 미등록 고객의 결과 본문 이름 = 보내는 분 성함."""
    s = filled()
    s.customer.customer_seq, s.customer.name = None, None
    confirm_once(s)
    o = decide_outcome(s, P, NOW, fare)
    call = {"providerCallId": "live_1", "callerPhoneNumber": "01012345678", "incomingAt": "2026-11-03T01:00:00Z"}
    body = submit_body(o, call, None, None, "01012345678")
    assert body["customer"] == {"name": "김철수", "phoneNumber": "01012345678"} and "customerSeq" not in body


def test_clean_name_strips_spoken_endings():
    from app.tools.record import clean_name
    cases = {"현승준이니다": "현승준", "현승준입니다": "현승준", "현승준이요": "현승준", "김하늘이에요": "김하늘",
             "박소이요": "박소이", "박소이예요": "박소이", "신지환이라고 합니다": "신지환", "심지환": "심지환", "최요": "최요"}
    assert {k: clean_name(k) for k in cases} == cases


def test_registered_customer_name_prefilled_regardless_of_origin_answer():
    """운영 통화 d62b7162: 출발지 답이 기준 미달로 버려져도 등록 고객 성함은 채워져 있어 다시 묻지 않는다."""
    s = ConversationState(customer=Customer(customer_seq=29, name="현승준", caller_phone="01012345678"), intent="order")
    assert s.origin_answer is None
    f = s.field_of("sender_name")
    assert f.valid and f.value == "현승준" and f.source == Source.CALLER_ID
    assert assess(s, P).missing[0] == "sender_address"
    assert s.current.empty()  # 서버가 채운 값뿐이면 빈 택배(빈 주문을 만들지 않음)
    assert readback_facts({"sender_name": "현승준"}) == {"sender_name": "현승준"}
    s.record("sender_name", "김영희")  # 고객이 다른 이름을 말하면 덮는다
    assert s.field_of("sender_name").value == "김영희" and s.field_of("sender_name").source == Source.CUSTOMER
    s.current = None  # 다음 택배도 같은 성함으로 시작
    assert s.field_of("sender_name").value == "현승준"


def test_unregistered_customer_name_not_prefilled():
    s = ConversationState(customer=Customer(customer_seq=None, name=None, caller_phone="01012345678"), intent="order")
    assert not s.field_of("sender_name").valid



def test_unverified_values_spoken_phone_and_ho():
    """말한 번호·호수가 서버 값에 없으면 잡는다(측정용). 한 자리씩 읽은 한글·자리 단위 호수도 맞춘다."""
    s = ConversationState(customer=Customer(caller_phone="01055556666"), intent="order")
    s.record("receiver_phone", "01012345678", Source.PIN)
    s.record("receiver_address_detail", "1203호", Source.PIN)
    assert unverified_values("연락처는 공일공 일이삼사 오육칠팔입니다", s) == {}
    assert unverified_values("010-1234-5678로 되어 있어요. 천이백삼호입니다", s) == {}
    assert unverified_values("일이공삼호요", s) == {}
    assert unverified_values("공일공 일이삼사 오육칠구입니다. 1204호예요", s) == {"phone": ["010****5679"], "ho": 1}
    assert unverified_values("일호선 타고 오세요. 이번 택배요. 삼호동 근처요", s) == {}  # 호선·일반 낱말은 번호가 아니다


def test_registered_mid_call_goes_to_more_parcels_after_commit():
    """통화 중 등록돼 등록 주소가 생겨도, 담은 뒤에는 발송 주소 확인 단계로 돌아가지 않는다(접수 안내가 막혔던 통화)."""
    from app.domain.state import Place
    s = filled()
    s.customer.origin_place = Place("김철수", "01012345678", "서울 강남구 테헤란로 212", "1201호", GEO, Source.PROFILE)
    s.origin_offered = True
    assert assess(s, P).stage == "readback"
    assert confirm_once(s)
    assert assess(s, P).stage == "more_parcels"
