"""분기 로직을 LLM 없이 검증(spec/LANGGRAPH_REBUILD.md §8): 시나리오마다 "보고 순서 → 단계 경로"를 데이터로 적는다.
보고는 세 종류: 백엔드 도구 호출(tool), 서버의 고객 말 판별 결과(say), 확정 지연이 끝남(commit).
서버가 실행하는 도구(취소)는 보고마다 바로 실행한다(sideband의 after_change와 같은 일).
끼어들기 시각이 필요한 시나리오(15~18, 20, 23~25)는 tests/test_sideband.py에 있다."""

import json

import pytest
from conftest import CALLER, CFG, FULL_ORDER, GEO, INCOMING_AT, PICKUP_AT, TEXTS, FakeBackend, make_call, run

from app import address
from app.address import kakao
from app.dispatcher import dispatch
from app.flow import engine
from app.listener import apply_answer, stage_choices
from app.config import FareConfig
from app.order import Place
from app.rag.context import build_search_context
from app.rag.schemas import Evidence

SENDER = {k: v for k, v in FULL_ORDER.items() if k.startswith("sender")}
RECEIVER = {k: v for k, v in FULL_ORDER.items() if k.startswith("receiver")}
ITEM = {"small_box_count": 1, "item_price": 30000}
WHEN = {"pickup_at": PICKUP_AT}

ORIGIN = Place(name="김철수", phone=CALLER, address="서울 강남구 테헤란로 212", address_detail="1201호", geo=GEO)
DEST = Place(name="이영희", phone="01098765432", address="부산 해운대구 센텀로 10", address_detail="", geo=GEO)
DEST2 = Place(name="이영희", phone="01098765432", address="서울 마포구 월드컵로 5", address_detail="301호", geo=GEO)
DEST3 = Place(name="박민수", phone="01055556666", address="대구 중구 동성로 1", address_detail="", geo=GEO)
FLOORS = [DEST.model_copy(update={"address_detail": d}) for d in ("301호", "502호", "701호")]
OPEN = CFG.model_copy(update={"flow": CFG.flow.model_copy(update={"agent_open_hour": 0, "agent_close_hour": 24})})
CLOSED = CFG.model_copy(update={"flow": CFG.flow.model_copy(update={"agent_open_hour": 0, "agent_close_hour": 0})})


def new_db():
    return FakeBackend()


def saved_db(pins=(DEST, DEST2, ORIGIN), recent=(ORIGIN, DEST), payment_methods=("billing", "credit"),
             cls=FakeBackend):
    """주소록이 있는 등록 고객. 최근 접수 1건: 강남 테헤란로(출발지) → 부산 해운대 이영희(도착지). 월결제 자격 있음."""
    db = cls()
    db.add_customer(CALLER, "김철수", list(pins), recent=recent, payment_methods=list(payment_methods))
    return db


def floors_db():
    """같은 건물 여러 층의 받는 곳(최근 도착지는 다른 곳)."""
    return saved_db(pins=(ORIGIN, *FLOORS), recent=(ORIGIN, DEST3))


def no_recent_db():
    """접수 완료된 주문도, 본인 주소(발신번호의 핀)도 없는 등록 고객."""
    return saved_db(pins=(DEST, DEST2), recent=None)


def own_pin_db():
    """접수 완료된 주문은 없고(개인 카드 결제 대기뿐·등록만 함) 본인 주소록에 보내는 곳이 있는 고객."""
    return saved_db(recent=None)


def withdrawn_db():
    db = FakeBackend()
    db.add_customer(CALLER, "김철수", status="WITHDRAWN")
    return db


def orders_db(newest_status="notPaid", cls=FakeBackend):
    """조회·취소: 이영희(오래된 것)와 박민수(최근 것)께 보낸 택배(개인 카드 결제 대기라 취소 가능), 다른 발신번호의 주문."""
    db = saved_db(cls=cls)
    db.add_order(CALLER, "notPaid", [("이영희", "부산 해운대구 센텀로 10")])
    db.add_order(CALLER, newest_status, [("박민수", "대구 중구 동성로 1")])
    db.add_order("01099999999", "notPaid", [("남", "남의 집")])
    return db


def picked_db():
    """결제가 끝나 접수가 진행된 주문(취소 불가)."""
    return orders_db("ACCEPTED")


def parcel_status(db, i):
    return db.orders[i]["parcels"][0]["status"]


class FakeRag:
    """매뉴얼 검색: 질문에 "모르는"이 있으면 근거 없음(RAG No)."""

    async def __call__(self, question):
        evidence = [] if "모르는" in question else [Evidence(chunk_id="1", source_id="faq", title="배송", content="2일")]
        return {"context": build_search_context(question, evidence).llm_payload(), "timings": {}}


def tool(name, args, stage):
    return ("tool", name, args, stage)


def say(answer, stage, intent="none", slot="none"):
    return ("say", answer, (intent, slot), stage)


def commit(stage):
    return ("commit", None, None, stage)


def ask(question, found=True):
    """질문 → QNA → RAG에서 검색 결과(백엔드의 search_manual)까지."""
    return [say("none", "RAG", intent="question"),
            tool("search_manual", {"question": question if found else f"모르는 {question}"},
                 "D_AFTER_ANSWER" if found else "D_AGENT_OFFER")]


def serve(call):
    """서버가 실행할 도구(취소)를 실행한다(app/progress.py run_server_tool과 같은 일, 잠금·전송 없이)."""
    while call.server_tool:
        name, args, fail = call.server_tool
        call.server_tool = None
        out = run(dispatch(call, name, json.dumps(args, ensure_ascii=False), args["operation_id"]))
        if not out["ok"] and not call.tool_calls[args["operation_id"]]["events"]:
            run(engine.apply(call, [fail], name))


def report(call, step, i=0):
    kind, a, b, _ = step
    if kind == "tool":
        out = run(dispatch(call, a, json.dumps(b, ensure_ascii=False), f"c{i}"))
    elif kind == "commit":
        assert call.flow.pending, f"{call.flow.stage}에 미뤄 둔 확정이 없음"
        out = run(engine.apply(call, [engine.COMMIT], "commit"))
    else:
        assert a in stage_choices(call), f"{call.flow.stage}에 없는 답 {a}"
        out = run(apply_answer(call, a, *b))
    serve(call)
    return out


def play(db, steps, cfg=None):
    call = make_call(db)
    call.rag, call.cfg = FakeRag(), cfg or call.cfg
    for i, step in enumerate(steps):
        report(call, step, i)
        assert call.flow.stage == step[3], f"{i}번째 {step}: {call.flow.stage}"
    return call


def path(call):
    return [call.flow.history[0]["from"]] + [h["to"] for h in call.flow.history]


TO_DEST = [say("yes", "B_DEST_CONFIRM_Q"), say("no", "B_DEST_MATCH")]  # 기존 출발지 예 → 최근 도착지 아니오
ROUTE = ["B_ORIGIN_ROUTE", "B_LOAD_RECENT", "B_DEST_CONFIRM_Q"]
NEW_TO_PICKUP = [say("order", "A_REGISTER_SENDER"), tool("record_order", SENDER, "A_RECEIVER_HUB"),
                 tool("record_order", RECEIVER, "A_ITEM_SIZE"), tool("record_order", ITEM, "A_PICKUP_TIME")]
NEW_ONE = NEW_TO_PICKUP + [tool("record_order", WHEN, "A_PICKUP_TIME"), commit("A_CHOICE")]
FIND = [say("lookup", "C_FIND_RECENT"), tool("lookup_orders", {"receiver_name": "박민수"}, "C_CHECK_RECORD"),
        say("yes", "C_CHOICE")]
ENTRY_SAVED = ["CALLER_ID", "IS_REGISTERED", "B_GREET_CHOICE"]
ENTRY_NEW = ["CALLER_ID", "IS_REGISTERED", "A_NEW_ORDER"]
NEW_INFO = ["A_REGISTER_SENDER", "A_RECEIVER_HUB", "A_REGISTER_RECEIVER"]
TAIL = ["A_ITEM_SIZE", "A_ITEM_VALUE", "A_PICKUP_TIME", "A_PAYMENT", "A_DONE", "A_CHOICE"]
QNA = ["GLOBAL_INTENT", "QNA", "RAG"]
ANSWERED = QNA + ["RAG_LLM_ANSWER", "D_AFTER_ANSWER"]
NO_ANSWER = QNA + ["D_AGENT_OFFER"]

# (이름, DB 준비, [보고], 기대 단계 경로, 설정)
SCENARIOS = [
    ("1 기존 출발지 예 → 최근 도착지 예 → 접수 완료 후 종료", saved_db, [
        say("yes", "B_DEST_CONFIRM_Q"),
        say("yes", "A_ITEM_SIZE"),
        tool("record_order", {"small_box_count": 1}, "A_ITEM_VALUE"),
        tool("record_order", {"item_price": 30000}, "A_PICKUP_TIME"),
        tool("record_order", WHEN, "A_PICKUP_TIME"),
        commit("A_CHOICE"),
        say("no_more", "END_CALL"),
    ], ENTRY_SAVED + ROUTE + ["B_DEST_FIXED"] + TAIL + ["HUB", "END_CALL"], None),
    ("2 인사 질문 아니오 → 무엇을 도와드릴까요 → 조회", saved_db, [
        say("no", "HUB"),
        say("lookup", "C_FIND_RECENT"),
    ], ENTRY_SAVED + ["HUB", "C_REQUIRED_INFO", "C_FIND_RECENT"], None),
    ("3 인사 질문 아니오 → 접수 → 출발지 변경 → 최근 도착지 확인", saved_db, [
        say("no", "HUB"),
        say("order", "B_ORIGIN_CHANGE"),
        tool("record_order", {"sender_address": "인천 연수구 송도동 1", "sender_address_detail": ""},
             "B_DEST_CONFIRM_Q"),
    ], ENTRY_SAVED + ["HUB", "B_ORIGIN_ROUTE", "B_ORIGIN_CHANGE", "B_LOAD_RECENT", "B_DEST_CONFIRM_Q"], None),
    ("3-1 도착지 아니오 → 주소만 → 여러 핀 → 층 확인 → 하나 → 예 → 도착지 확정", floors_db, TO_DEST + [
        tool("match_pins", {"place": "센텀로"}, "B_DEST_MATCH"),
        say("pin_2", "B_DEST_VERIFY"),
        say("yes", "A_ITEM_SIZE"),
    ], ENTRY_SAVED + ROUTE + ["B_DEST_MATCH", "B_DEST_DIFF", "B_DEST_MATCH", "B_DEST_VERIFY", "B_DEST_FIXED",
                              "A_ITEM_SIZE"], None),
    ("3-2 이름만 → 핀 없음 → 주소 질문 → 핀 없음 → 수신인 정보 Hub(연락처만)", saved_db, TO_DEST + [
        tool("match_pins", {"name": "최지우"}, "B_DEST_MATCH"),
        tool("match_pins", {"place": "대구 중구 동성로 1"}, "A_RECEIVER_HUB"),
        tool("record_order", {"receiver_phone": "010-5555-6666", "receiver_address_detail": ""}, "A_ITEM_SIZE"),
        tool("record_order", ITEM, "A_PICKUP_TIME"),
        tool("record_order", WHEN, "A_PICKUP_TIME"),
        commit("A_CHOICE"),
    ], ENTRY_SAVED + ROUTE + ["B_DEST_MATCH", "A_RECEIVER_HUB", "A_REGISTER_RECEIVER"] + TAIL, None),
    ("5 신규 고객 조회 요청 → 안내 후 접수", new_db, [say("lookup", "A_REGISTER_SENDER")],
     ENTRY_NEW + ["A_REGISTER_SENDER"], None),
    ("6 조회: 기억 안 남 → 최근부터 → 아니오 → 그 전 → 맞음 → 상태 → 아니오", orders_db, [
        say("lookup", "C_FIND_RECENT"),
        say("forgot", "C_CHECK_RECORD"),
        say("no", "C_CHECK_RECORD"),
        say("yes", "C_CHOICE"),
        say("no", "HUB"),
    ], ENTRY_SAVED + ["C_REQUIRED_INFO", "C_FIND_RECENT", "C_CHECK_RECORD", "C_CHOICE", "HUB"], None),
    ("7 조회 → 취소 → 예 → 성공 → HUB", orders_db, FIND + [
        say("cancel", "C_CANCEL_CONFIRM"),
        say("yes", "C_CANCEL_CONFIRM"),
        commit("HUB"),
    ], ENTRY_SAVED + ["C_REQUIRED_INFO", "C_FIND_RECENT", "C_CHECK_RECORD", "C_CHOICE", "C_CANCEL_INFO",
                      "C_CANCEL_CONFIRM", "C_CANCEL", "HUB"], None),
    ("8 조회 → 취소 → 이미 수거 → HUB", picked_db, FIND + [say("cancel", "HUB")],
     ENTRY_SAVED + ["C_REQUIRED_INFO", "C_FIND_RECENT", "C_CHECK_RECORD", "C_CHOICE", "C_CANCEL_INFO", "HUB"], None),
    ("9 수거 일시 단계에서 질문 → 답변 → 다른 업무 → 수거 일시로 복귀", new_db, NEW_TO_PICKUP + ask("배송 며칠") + [
        say("other_task", "A_PICKUP_TIME"),
    ], ENTRY_NEW + NEW_INFO + ["A_ITEM_SIZE", "A_ITEM_VALUE", "A_PICKUP_TIME"] + ANSWERED + ["RESUME_TASK",
                                                                                         "A_PICKUP_TIME"], None),
    ("10 RAG 실패 3번째에 상담원 제안 → 예 → 연결 가능 → 이관", saved_db,
     ask("1", False) + ask("2", False) + ask("3", False) + [say("yes", "AGENT_HANDOFF")],
     ENTRY_SAVED + NO_ANSWER * 3 + ["D_AGENT_AVAILABLE", "AGENT_HANDOFF"], OPEN),
    ("12 상담원 연결 불가 → 추가 질문 → QnA → 다른 업무 → 복귀", saved_db,
     ask("1", False) + ask("2", False) + ask("3", False) + [say("yes", "D_AFTER_NO_AGENT")] + ask("4") + [
         say("other_task", "B_GREET_CHOICE")],
     ENTRY_SAVED + NO_ANSWER * 3 + ["D_AGENT_AVAILABLE", "D_AFTER_NO_AGENT"] + ANSWERED + ["RESUME_TASK",
                                                                                         "B_GREET_CHOICE"],
     CLOSED),
    ("14 조회 결과에서 수정 → 제한된 요청 → 다른 업무 → 복귀", orders_db, FIND + [
        say("modify", "D_AGENT_OFFER"),
        say("other_task", "C_CHOICE"),
    ], ENTRY_SAVED + ["C_REQUIRED_INFO", "C_FIND_RECENT", "C_CHECK_RECORD", "C_CHOICE", "GLOBAL_INTENT",
                      "RESTRICTED_REQUEST", "D_AGENT_OFFER", "RESUME_TASK", "C_CHOICE"], None),
    ("21 가액 단계에서 받는 분 번호 정정 → 가액 질문으로", new_db, NEW_TO_PICKUP[:3] + [
        tool("record_order", {"small_box_count": 1}, "A_ITEM_VALUE"),
        say("none", "A_ITEM_VALUE", intent="correction", slot="receiver_phone"),
        tool("record_order", {"receiver_phone": "010-1111-2222"}, "A_ITEM_VALUE"),
    ], ENTRY_NEW + NEW_INFO + ["A_ITEM_SIZE", "A_ITEM_VALUE"], None),
    ("22 도착지 정정 → 핀 매칭부터 다시", saved_db, [
        say("yes", "B_DEST_CONFIRM_Q"),
        say("yes", "A_ITEM_SIZE"),
        tool("record_order", {"small_box_count": 1}, "A_ITEM_VALUE"),
        say("none", "B_DEST_MATCH", intent="correction", slot="receiver_address"),
        tool("match_pins", {"name": "이영희", "place": "마포"}, "B_DEST_VERIFY"),
        say("yes", "A_ITEM_VALUE"),
    ], ENTRY_SAVED + ROUTE + ["B_DEST_FIXED", "A_ITEM_SIZE", "A_ITEM_VALUE", "B_DEST_MATCH", "B_DEST_VERIFY",
                              "B_DEST_FIXED", "A_ITEM_SIZE", "A_ITEM_VALUE"], None),
]


def steps(no: str) -> list:
    """시나리오 번호("3-1" 등)의 보고 목록."""
    return next(sc[2] for sc in SCENARIOS if sc[0].split()[0] == no)


@pytest.mark.parametrize("name, make_db, steps, expected_path, cfg", SCENARIOS, ids=[s[0] for s in SCENARIOS])
def test_scenario(name, make_db, steps, expected_path, cfg):
    assert path(play(make_db(), steps, cfg)) == expected_path


# --- 시나리오별 확인(§8) ---

def test_1_registered_order_submits_once_and_hangs_up():
    db = saved_db()
    call = play(db, steps("1"))
    assert len(db.results) == 1 and call.hangup_requested.is_set()
    body = db.results[0]["body"]
    assert body["outcome"] == "COMPLETE" and body["customerSeq"] == call.customer_seq
    assert body["paymentMethodType"] == "credit"  # TODO(flow): 현장 결제 값 미정
    assert body["parcels"][0]["origin"]["roadAddress"] == ORIGIN.address  # 최근 접수의 출발지 그대로
    assert body["parcels"][0]["destination"]["roadAddress"] == DEST.address
    text = engine.next_text(call)
    assert "TEST0001" in text and TEXTS.say["END_CALL"] in text  # ACCEPTED만 접수 완료 안내


def test_1_fare_notice_waits_for_commit_then_is_not_repeated():
    call = play(saved_db(), steps("1")[:5])
    assert call.flow.pending and call.flow.stage == "A_PICKUP_TIME"
    # 확정을 기다리는 동안 운임(요금표: 소형 1개)과 결제 방식(월결제 자격 하나 → 자동)만 안내
    assert engine.next_text(call) == f"'운임은 4,000원이에요.' '{TEXTS.say['PAY_CREDIT']}'"
    report(call, commit("A_CHOICE"))
    assert engine.next_text(call) == f"'{TEXTS.say['A8']}'" and len(call.parcels) == 1
    assert call.payment_method == "credit"


def test_fare_and_amounts_are_sent_from_fare_table():
    db = saved_db()
    play(db, steps("1"))
    body = db.results[0]["body"]
    assert body["parcels"][0]["notifiedPrice"] == 4000 and body["totalAmount"] == 4000
    assert body["paymentMethodType"] == "credit" and db.results[0]["status"] == "ACCEPTED"


def test_unknown_fare_is_not_said_and_result_is_incomplete():
    """요금표가 비어 있으면 금액을 지어 말하거나 보내지 않고 미완료로 넘긴다(운영이 보완)."""
    db = saved_db()
    no_fare = CFG.model_copy(update={"fare": FareConfig()})
    call = play(db, steps("1")[:5], no_fare)
    assert engine.next_text(call) == f"'{TEXTS.say['PAY_CREDIT']}'"
    for step in steps("1")[5:]:
        report(call, step)
    body = db.results[0]["body"]
    assert body["outcome"] == "INCOMPLETE" and "totalAmount" not in body and "notifiedPrice" not in body["parcels"][0]


def test_both_postpaid_methods_ask_and_wait_reverts_choice():
    """기업 월결제와 부서 그룹결제를 둘 다 쓸 수 있으면 묻는다. 고른 답은 확정 지연 뒤에 정한다."""
    db = saved_db(payment_methods=("billing", "credit", "groupBilling"))
    call = play(db, steps("1")[:4] + [tool("record_order", WHEN, "A_PAYMENT")])
    assert engine.next_text(call) == f"'운임은 4,000원이에요.' '{TEXTS.say['PAY_ASK']}'"
    assert set(stage_choices(call)) == {"credit", "groupBilling", "none"}
    report(call, say("groupBilling", "A_PAYMENT"))
    assert call.flow.pending and call.payment_method is None
    run(apply_answer(call, "none", "wait"))  # "잠깐만요": 고른 것을 정하지 않고 다시 묻는다
    assert call.flow.pending is None and call.payment_method is None and call.flow.stage == "A_PAYMENT"
    report(call, say("groupBilling", "A_PAYMENT"))
    assert TEXTS.say["PAY_GROUP"] in engine.next_text(call)
    report(call, commit("A_CHOICE"))
    assert call.payment_method == "groupBilling"


def test_1_greeting_asks_recent_origin_then_recent_destination():
    call = make_call(saved_db())
    assert engine.next_text(call) == "'김철수님, 안녕하세요. 서울 강남구 테헤란로 212에서 보내시는 택배 맞으실까요?'"
    report(call, say("yes", "B_DEST_CONFIRM_Q"))
    assert engine.next_text(call) == "'이번에도 부산 해운대구 센텀로 10로 보내시나요?'"
    assert call.order.sender_name == ORIGIN.name and call.order.sender_phone == CALLER


def test_2_greeting_no_says_what_can_i_do_and_next_order_changes_origin():
    call = play(saved_db(), [say("no", "HUB")])
    assert engine.next_text(call) == f"'{TEXTS.say['HUB_ASK']}'" and call.new_origin_requested
    report(call, say("order", "B_ORIGIN_CHANGE"))  # "아니요"만 하고 접수를 골라도 방금 아니라고 한 출발지는 쓰지 않는다
    assert not call.new_origin_requested


def test_greeting_lookup_goes_straight_to_lookup():
    call = play(saved_db(), [say("lookup", "C_FIND_RECENT")])
    assert TEXTS.say["C1"] in engine.next_text(call)


def test_3_origin_change_keeps_sender_and_asks_only_address():
    call = play(saved_db(), steps("3")[:2])
    assert call.order.sender_name == "김철수" and call.order.sender_phone == CALLER  # 이름·번호 재질문 없음
    assert engine.next_text(call) == f"'{TEXTS.say['A1_2']}'"
    report(call, steps("3")[2])
    assert call.order.sender_address == "인천 연수구 송도동 1" and "부산 해운대구 센텀로 10" in engine.next_text(call)


def test_3_1_diff_lists_candidates_then_verifies():
    call = play(floors_db(), steps("3-1")[:3])
    assert "301호·502호·701호 중 어디로" in engine.next_text(call)
    assert set(stage_choices(call)) == {"pin_1", "pin_2", "pin_3", "other", "none"}
    report(call, say("pin_2", "B_DEST_VERIFY"))
    assert engine.next_text(call) == "'받으시는 분은 이영희 님 맞으신가요?'"
    report(call, say("yes", "A_ITEM_SIZE"))
    assert call.order.receiver_address_detail == "502호"


def test_3_2_name_only_asks_address_then_carries_both_into_receiver_hub():
    call = play(saved_db(), steps("3-2")[:3])
    assert engine.next_text(call) == f"'{TEXTS.say['A2_3']}'"  # 이름만 말했고 핀이 없으면 주소를 묻는다
    report(call, steps("3-2")[3])
    assert call.order.receiver_name == "최지우" and call.order.receiver_address == "대구 중구 동성로 1"
    assert engine.next_text(call) == f"'{TEXTS.say['A2_2']}'"  # 앞서 받은 이름·주소는 다시 묻지 않는다
    report(call, tool("record_order", {"receiver_phone": "010-5555-6666", "receiver_address_detail": ""},
                      "A_ITEM_SIZE"))


def test_address_only_without_pin_asks_name_and_partial_place_is_not_taken_as_address():
    call = play(saved_db(), TO_DEST + [tool("match_pins", {"place": "제주"}, "B_DEST_MATCH")])
    assert engine.next_text(call) == f"'{TEXTS.say['A2_1']}'"
    report(call, tool("match_pins", {"name": "최지우"}, "A_RECEIVER_HUB"))
    # 번지·건물번호 없는 지역 이름은 주소로 가져가지 않는다(주소DB가 엉뚱한 주소를 고르지 않게)
    assert call.order.receiver_name == "최지우" and call.order.receiver_address is None
    assert engine.next_text(call) == f"'{TEXTS.say['A2_2']}'"


def test_place_said_at_recent_destination_question_is_matched_directly():
    call = play(saved_db(), [say("yes", "B_DEST_CONFIRM_Q"),
                             tool("match_pins", {"name": "이영희", "place": "마포"}, "B_DEST_VERIFY")])
    assert call.pin_offer == DEST2
    call = play(saved_db(), [say("yes", "B_DEST_CONFIRM_Q"), tool("match_pins", {"name": "최지우"}, "B_DEST_MATCH")])
    assert engine.next_text(call) == f"'{TEXTS.say['A2_3']}'"  # 매칭 단계로 옮겨 빠진 쪽만 묻는다


def test_4_new_customer_address_retry_texts_then_registered_like_flow(monkeypatch):
    async def correct(text):
        return {"status": "not_found", "candidates": []} if "없는" in text else {"status": "confirmed",
                                                                                "candidates": [text]}

    monkeypatch.setattr(address, "correct", correct)
    call = play(new_db(), [say("order", "A_REGISTER_SENDER")])
    assert "먼저 성함을" in engine.next_text(call)
    report(call, tool("record_order", {"sender_name": "김철수"}, "A_REGISTER_SENDER"))
    assert engine.next_text(call) == f"'{TEXTS.say['A1_2']}'"  # 전화번호는 묻지 않고 발신번호로 등록
    assert call.order.sender_phone == CALLER
    report(call, tool("record_order", {"sender_address": "없는 주소 1"}, "A_REGISTER_SENDER"))
    assert TEXTS.say["A_ADDR_RETRY_SENDER"] in engine.next_text(call)
    report(call, tool("record_order", {"sender_address": ORIGIN.address, "sender_address_detail": "1201호"},
                      "A_RECEIVER_HUB"))
    assert engine.next_text(call) == f"'{TEXTS.say['A2_1']}'"
    # 수신인 정보 Hub: 성함과 주소를 한 번에 말하면 연락처만 묻는다
    report(call, tool("record_order", {"receiver_name": "이영희", "receiver_address": "없는 주소 2"}, "A_RECEIVER_HUB"))
    assert engine.next_text(call) == f"'{TEXTS.say['A2_2']}'"
    report(call, tool("record_order", {"receiver_phone": "010-9876-5432"}, "A_RECEIVER_HUB"))
    assert TEXTS.say["A_ADDR_RETRY_RECEIVER"] in engine.next_text(call)
    assert "보내시는 곳" not in engine.next_text(call)  # 단계에 맞는 쪽만
    for step in (tool("record_order", {"receiver_address": DEST.address, "receiver_address_detail": ""}, "A_ITEM_SIZE"),
                 tool("record_order", ITEM, "A_PICKUP_TIME"), tool("record_order", WHEN, "A_PICKUP_TIME"),
                 commit("A_CHOICE"), say("order", "B_DEST_CONFIRM_Q")):
        report(call, step)
    # 접수 완료 뒤에는 기존 고객처럼: 방금 보낸 택배가 최근 접수(출발지 그대로, "이번에도 {도착지}로")
    assert engine.next_text(call) == f"'이번에도 {DEST.address}로 보내시나요?'"
    assert call.order.sender_address == ORIGIN.address and call.customer_type == "registered"


def test_5_new_customer_lookup_text_then_order():
    call = play(new_db(), steps("5"))
    text = engine.next_text(call)
    assert text.index(TEXTS.say["NEW_LOOKUP"]) < text.index("먼저 성함을")


def test_6_lookup_reads_newest_then_previous_and_status():
    call = play(orders_db(), steps("6")[:2])
    assert TEXTS.say["C1_FORGOT"] in engine.next_text(call) and "박민수님께 대구 중구 동성로 1로" in engine.next_text(call)
    report(call, say("no", "C_CHECK_RECORD"))
    assert "그 전에 보내신 택배" in engine.next_text(call) and "부산 해운대구 센텀로 10" in engine.next_text(call)
    assert TEXTS.say["C1_FORGOT"] not in engine.next_text(call)  # 앞 경로의 안내는 되풀이하지 않는다
    report(call, say("yes", "C_CHOICE"))
    assert "지금 카드 결제 대기 중이에요" in engine.next_text(call) and call.target_order["receiver_name"] == "이영희"


def test_7_cancel_success_resets_fail_count():
    db = orders_db()
    call = play(db, steps("7")[:-1])
    call.fail_count = 2
    report(call, commit("HUB"))
    assert parcel_status(db, 1) == "CANCELLED" and call.fail_count == 0
    assert TEXTS.say["C9"] in engine.next_text(call)
    assert [op["status"] for op in call.running_ops.values()] == ["done"]


def test_8_already_picked_up_counts_a_failure():
    call = play(orders_db("ACCEPTED"), steps("8"))
    assert call.fail_count == 1 and TEXTS.say["C7_LOCKED"] in engine.next_text(call)


def test_9_slots_kept_after_qna():
    call = play(new_db(), NEW_TO_PICKUP)
    before = call.order.model_dump()
    for step in ask("배송 며칠") + [say("other_task", "A_PICKUP_TIME")]:
        report(call, step)
    assert call.order.model_dump() == before and TEXTS.say["A5"] in engine.next_text(call)


def test_10_offer_only_on_third_failure():
    call = play(saved_db(), ask("1", False), OPEN)
    assert engine.next_text(call) == f"'{TEXTS.say['D5']}'" and not call.agent_offered
    for step in ask("2", False):
        report(call, step)
    assert engine.next_text(call) == f"'{TEXTS.say['D5']}'"
    for step in ask("3", False) + [say("yes", "AGENT_HANDOFF")]:
        report(call, step)
    assert call.refer_requested.is_set() and TEXTS.say["D9"] in engine.next_text(call)


def test_11_yes_before_offer_is_not_a_choice():
    call = play(saved_db(), ask("1", False), OPEN)
    assert "yes" not in stage_choices(call)
    run(apply_answer(call, "yes", "none"))
    assert call.flow.stage == "D_AGENT_OFFER" and not call.refer_requested.is_set()


def test_12_no_agent_then_other_task_resumes():
    call = play(saved_db(), ask("1", False) + ask("2", False) + ask("3", False) + [say("yes", "D_AFTER_NO_AGENT")],
                CLOSED)
    assert TEXTS.say["D11"] in engine.next_text(call)
    report(call, say("other_task", "B_GREET_CHOICE"))
    assert TEXTS.say["GREET_REGISTERED"].format(**call.text_vars()) in engine.next_text(call)  # 저장된 단계의 질문


def test_resume_to_hub_asks_resume_hub():
    call = play(saved_db(), [say("no", "HUB")] + ask("1", False) + [say("other_task", "HUB")])
    assert engine.next_text(call) == f"'{TEXTS.say['RESUME_HUB']}'"  # §9 복귀 대상이 HUB


def test_13_restricted_texts_and_consecutive_failures_across_kinds():
    call = play(saved_db(), [])
    texts = []
    for _ in range(3):
        report(call, say("none", "D_AGENT_OFFER", intent="restricted"))
        texts.append(engine.next_text(call))
        report(call, say("other_task", "B_GREET_CHOICE"))
    assert texts == [f"'{TEXTS.say['D6']}'"] * 2 + [f"'{TEXTS.say['D6_3']}'"]
    # 업무 예외 1번 + RAG 실패 2번 = 3번째에 상담원 제안(연속 합산)
    call = play(orders_db("ACCEPTED"), FIND + [say("cancel", "HUB")] + ask("1", False))
    assert engine.next_text(call) == f"'{TEXTS.say['D5']}'" and call.fail_count == 2
    for step in ask("2", False):
        report(call, step)
    assert engine.next_text(call) == f"'{TEXTS.say['D5_3']}'" and call.agent_offered


def test_19_retry_checks_first_and_never_cancels_twice():
    class FlakyCancel(FakeBackend):
        """처음 취소는 백엔드에서 처리됐지만 응답이 실패로 온다."""
        calls = 0

        async def cancel_parcels(self, call_session_seq, order_seq, order_parcel_seqs):
            FlakyCancel.calls += 1
            await super().cancel_parcels(call_session_seq, order_seq, order_parcel_seqs)
            raise RuntimeError("응답 유실")

    flaky = orders_db(cls=FlakyCancel)
    call = play(flaky, FIND + [say("cancel", "C_CANCEL_CONFIRM"), say("yes", "C_CANCEL_CONFIRM"),
                               commit("C_CANCEL")])
    assert TEXTS.say["C9_FAIL"] in engine.next_text(call) and call.fail_count == 1
    report(call, say("yes", "HUB"))  # 한 번 더: 먼저 조회해 보니 이미 취소됨
    assert FlakyCancel.calls == 1 and TEXTS.say["C9"] in engine.next_text(call)
    ops = list(call.running_ops.values())
    assert [op["status"] for op in ops] == ["unknown", "done"] and ops[1]["checked"]
    assert len(call.running_ops) == 2 and all(":cancel:" in op_id for op_id in call.running_ops)


def test_21_correction_asks_new_value_then_confirms_and_returns():
    call = play(new_db(), steps("21")[:-1])
    assert TEXTS.say["CORRECT_ASK"].format(**{"항목": "받으시는 분 연락처를"}) in engine.next_text(call)
    before = call.order.model_dump()
    report(call, steps("21")[-1])
    text = engine.next_text(call)
    assert "받으시는 분 연락처를 01011112222으로 바꿀게요" in text and TEXTS.say["A4"] in text
    assert call.order.model_dump() == {**before, "receiver_phone": "01011112222"}
    run(engine.apply(call, []))
    call.flow.notice = []  # 보낸 뒤에는 다시 말하지 않는다(app/progress.py)
    assert engine.next_text(call) == f"'{TEXTS.say['A4']}'"


def test_22_destination_correction_drops_old_match():
    call = play(saved_db(), steps("22")[:4])
    assert call.order.receiver_address is None and call.order.receiver_name is None and not call.pin_candidates
    assert TEXTS.say["B6"] in engine.next_text(call) and call.order.item_price is None and call.order.small_box_count
    report(call, steps("22")[4])
    assert call.pin_offer == DEST2


def test_origin_correction_asks_new_origin_keeping_sender():
    call = play(saved_db(), steps("22")[:3] + [
        say("none", "B_ORIGIN_CHANGE", intent="correction", slot="sender_address"),
        tool("record_order", {"sender_address": "인천 연수구 송도동 1", "sender_address_detail": ""}, "A_ITEM_VALUE")])
    assert call.order.sender_name == "김철수" and call.order.sender_address == "인천 연수구 송도동 1"
    assert call.order.receiver_address == DEST.address  # 도착지·물품은 그대로


# --- 진입 ---

@pytest.mark.parametrize("make_db, caller, stage, greeting", [
    (new_db, CALLER, "A_NEW_ORDER", "GREET_NEW"),
    (new_db, None, "A_NEW_ORDER", "GREET_NEW"),
    (saved_db, CALLER, "B_GREET_CHOICE", "GREET_REGISTERED"),
    (no_recent_db, CALLER, "HUB", "GREET_REGISTERED_PLAIN"),  # TODO(flow): 최근 접수도 본인 주소도 없을 때
    (own_pin_db, CALLER, "B_GREET_CHOICE", "GREET_REGISTERED"),  # 접수 완료 주문이 없으면 본인 주소록 주소
    (withdrawn_db, CALLER, "AGENT_HANDOFF", "D9"),
])
def test_start(make_db, caller, stage, greeting):
    call = make_call(make_db(), caller=caller)
    assert call.flow.stage == stage and TEXTS.say[greeting].format(**call.text_vars()) in engine.next_text(call)


def test_registered_greeting_and_call_info_use_name():
    call = make_call(saved_db())
    info = TEXTS.call_info.format(**call.text_vars(), first=engine.next_text(call))
    assert "김철수님, 안녕하세요" in info and ORIGIN.address in info


def test_withdrawn_customer_is_handed_to_agent_not_treated_as_new():
    call = make_call(withdrawn_db())
    assert call.customer_type == "withdrawn" and call.refer_requested.is_set()


def test_registered_without_recent_order_asks_new_origin_then_destination():
    """TODO(flow): 백엔드가 최근 접수를 주지 않으면 출발지 없이 인사하고, 접수는 새 출발지·B6부터(§9)."""
    call = play(no_recent_db(), [say("order", "B_ORIGIN_CHANGE")])
    assert call.order.sender_name == "김철수" and call.order.sender_phone == CALLER  # MVP: 고객 = 보내는 분
    report(call, tool("record_order", {"sender_address": "인천 연수구 송도동 1", "sender_address_detail": ""},
                      "B_DEST_MATCH"))
    assert engine.next_text(call) == f"'{TEXTS.say['B6']}'"


# --- B 핀 매칭 ---

def test_pins_are_only_callers():
    db = saved_db()
    db.add_customer("01099999999", "남", [Place(name="남", phone="0212345678", address="남의 집", address_detail="")])
    call = play(db, TO_DEST)
    assert DEST in call.places["destination"] and all(p.name != "남" for p in call.places["destination"])


def test_recent_pins_first():
    """주소록 앞쪽(최근) N개에서 먼저 찾는다. 거기 있으면 오래된 같은 이름 핀은 후보로 늘어놓지 않는다."""
    olds = [DEST3.model_copy(update={"address_detail": f"{i}호"}) for i in range(CFG.flow.pin_recent_count)]
    call = play(saved_db(pins=(DEST, *olds, DEST2)), TO_DEST + [tool("match_pins", {"name": "이영희"}, "B_DEST_VERIFY")])
    assert call.pin_offer == DEST
    call = play(saved_db(pins=(*olds, DEST, DEST2), recent=(ORIGIN, DEST3)),
                TO_DEST + [tool("match_pins", {"name": "이영희"}, "B_DEST_MATCH")])
    assert call.pin_candidates == [DEST, DEST2]  # 최근 N개에 없으면 전체에서


def test_match_pins_strips_particles_but_not_names():
    other = DEST.model_copy(update={"name": "이영수"})
    call = play(saved_db(pins=(ORIGIN, DEST, other)), TO_DEST)
    out = report(call, tool("match_pins", {"name": "이영희님", "place": "해운대로"}, "B_DEST_VERIFY"))
    assert out["ok"] and call.pin_offer == DEST  # "이영희님"은 "이영희"로 보되 "이영"까지 줄여 이영수를 찾지 않는다
    assert run(dispatch(call, "match_pins", "{}", "x"))["ok"] is False  # 찾을 말이 없으면 오류


def test_11_destination_verify_no_registers_new_receiver():
    """B11(2026-10-31 결정): 하나 남은 핀이 아니라고 하면 그 핀은 버리고 새 받는 분으로. 핀의 값은 가져가지 않는다."""
    call = play(saved_db(), TO_DEST + [tool("match_pins", {"name": "이영희", "place": "해운대"}, "B_DEST_VERIFY"),
                                       say("no", "A_RECEIVER_HUB")])
    text = engine.next_text(call)
    assert text.startswith("'이영희님으로 저장된 다른 배송지가 없으니 새로 접수하겠습니다.'")
    assert call.order.receiver_name == "이영희" and call.order.receiver_phone is None  # 고객이 말한 이름만
    assert TEXTS.say["A2_2"] in text and DEST in call.pin_rejected["destination"]


# --- A 구간 예외 ---

def test_item_and_value_exception_texts():
    call = play(new_db(), NEW_TO_PICKUP[:3] + [say("vague", "A_ITEM_SIZE")])
    assert TEXTS.say["A3_VAGUE"] in engine.next_text(call)
    report(call, say("partial", "A_ITEM_SIZE"))
    assert TEXTS.say["A3_PARTIAL"] in engine.next_text(call)
    report(call, tool("record_order", {"small_box_count": 2}, "A_ITEM_VALUE"))
    report(call, say("unclear", "A_ITEM_VALUE"))
    assert TEXTS.say["A4_UNCLEAR"] in engine.next_text(call)


def test_past_pickup_date_exception():
    call = play(new_db(), NEW_TO_PICKUP)
    out = report(call, tool("record_order", {"pickup_at": "2020-01-01T10:00:00+09:00"}, "A_PICKUP_TIME"))
    assert out["ok"] is False and call.pickup_at is None and "이미 지나서" in engine.next_text(call)
    assert f"오늘은 {call.text_vars()['월']}월" in engine.next_text(call)


def test_second_parcel_skips_pickup_and_keeps_call_values():
    db = new_db()
    call = play(db, NEW_ONE + [say("order", "B_DEST_CONFIRM_Q"), say("yes", "A_ITEM_SIZE"),
                               tool("record_order", ITEM, "A_PICKUP_TIME")])
    assert call.flow.pending  # 수거 일시는 통화에 하나: 이미 있어 결제 단계 진입만 기다린다
    report(call, commit("A_CHOICE"))
    report(call, say("no_more", "END_CALL"))
    body = db.results[0]["body"]
    assert body["outcome"] == "COMPLETE" and len(body["parcels"]) == 2 and body["customerSeq"] == call.customer_seq


def test_new_customer_info_before_choice_is_kept():
    call = play(new_db(), [tool("record_order", {"sender_name": "김철수"}, "A_REGISTER_SENDER")])
    assert TEXTS.say["A1_2"] in engine.next_text(call)


def test_backward_jump_when_earlier_value_is_cleared(monkeypatch):
    async def correct(text):
        return {"status": "not_found", "candidates": []}

    call = play(new_db(), NEW_TO_PICKUP[:3])
    monkeypatch.setattr(address, "correct", correct)
    report(call, tool("record_order", {"receiver_address": "대구 없는 길 1"}, "A_RECEIVER_HUB"))
    assert TEXTS.say["A_ADDR_RETRY_RECEIVER"] in engine.next_text(call)


# --- C 조회 예외 ---

def test_lookup_none_for_name_asks_again_and_failure_offers_retry():
    db = orders_db()
    call = play(db, [say("lookup", "C_FIND_RECENT"), tool("lookup_orders", {"receiver_name": "최지우"}, "C_FIND_RECENT")])
    assert "최지우님께 보내신 택배를 찾지 못했어요" in engine.next_text(call)
    report(call, say("unclear", "C_FIND_RECENT"))
    assert TEXTS.say["C1_RETRY"] in engine.next_text(call)

    async def down(call_session_seq, limit):
        raise RuntimeError("백엔드 없음")

    db.find_parcels = down
    report(call, tool("lookup_orders", {"receiver_name": "이영희"}, "C_FIND_RECENT"))
    assert TEXTS.say["C3_FAIL"] in engine.next_text(call) and set(stage_choices(call)) == {"yes", "no", "none"}
    assert call.fail_count == 1
    report(call, say("yes", "C_FIND_RECENT"))
    report(call, say("yes", "C_FIND_RECENT"))
    report(call, say("yes", "HUB"))  # 다시 조회 상한(2회)을 넘으면 HUB


def test_lookup_without_any_order_returns_to_hub():
    call = play(saved_db(), [say("lookup", "C_FIND_RECENT"), say("forgot", "HUB")])
    assert TEXTS.say["C_NO_ORDERS"] in engine.next_text(call)


def test_cancel_no_and_already_cancelled():
    call = play(orders_db(), FIND + [say("cancel", "C_CANCEL_CONFIRM"), say("no", "HUB")])
    assert TEXTS.say["C10"] in engine.next_text(call) and TEXTS.say["RESUME_HUB"] in engine.next_text(call)
    call = play(orders_db("CANCELLED"), FIND + [say("cancel", "HUB")])
    assert TEXTS.say["C7_CANCELLED"] in engine.next_text(call)


def test_cancel_runs_only_after_confirmed_yes_and_commit():
    db = orders_db()
    call = play(db, FIND + [say("cancel", "C_CANCEL_CONFIRM"), say("yes", "C_CANCEL_CONFIRM")])
    assert parcel_status(db, 1) == "ACTIVE" and not call.running_ops  # 확정 지연 중: 아직 실행하지 않음
    target = {k: call.target_order[k] for k in ("order_seq", "order_parcel_seq")}
    out = run(dispatch(call, "cancel_order", json.dumps({**target, "customer_confirmed": True,
                                                         "operation_id": "x"}), "x"))
    assert out["ok"] is False and "쓸 수 없는" in out["error"]  # C_CANCEL 밖에서는 실행하지 않는다


# --- §2.5 끼어들기·정정(판별 결과 단위) ---

def test_global_intent_first_answer_dropped():
    """질문이 섞이면 단계 답보다 질문이 먼저(§2.1). 복귀하면 같은 질문을 다시 한다."""
    call = play(saved_db(), [say("yes", "RAG", intent="question")])
    assert call.flow.resume == {"task": None, "stage": "B_GREET_CHOICE"}


def test_unheard_yes_is_reasked_once_but_no_is_taken():
    call = play(saved_db(), [say("yes", "B_DEST_CONFIRM_Q")])
    call.flow.entered_ms = 1000
    call.agent_deltas = [("이번에도 ", 1000, 1400), ("부산 해운대구 센텀로 10로 보내시나요?", 1400, 4000)]
    run(apply_answer(call, "yes", "none", start_ms=1500))
    assert call.flow.stage == "B_DEST_CONFIRM_Q" and call.reask and call.flow.reasked
    run(apply_answer(call, "yes", "none", start_ms=1500))  # 한 번 다시 물은 뒤에는 받는다(되풀이 방지)
    assert call.flow.stage == "A_ITEM_SIZE"
    call = play(saved_db(), [say("yes", "B_DEST_CONFIRM_Q")])
    call.flow.entered_ms, call.agent_deltas = 1000, [("이번에도 ", 1000, 1400), ("부산 해운대구", 1400, 4000)]
    run(apply_answer(call, "no", "none", start_ms=1500))  # 거절은 되돌릴 수 있어 받는다(시나리오 16)
    assert call.flow.stage == "B_DEST_MATCH"


def test_greeting_yes_before_origin_is_heard_is_reasked():
    """첫 인사도 기존 출발지가 나오기 전의 "네"는 받지 않는다(받아쓰기가 오기 전 단계 진입 시각은 통화 시작 0)."""
    call = make_call(saved_db())
    assert call.flow.entered_ms == 0
    call.agent_deltas = [("김철수님, 안녕하세요. ", 0, 1500), ("서울 강남구 테헤란로 212에서 보내시는 택배 맞으실까요?", 1500, 4500)]
    run(apply_answer(call, "yes", "none", start_ms=1000))
    assert call.flow.stage == "B_GREET_CHOICE" and call.reask
    run(apply_answer(call, "lookup", "none", start_ms=1000))  # 다른 용건은 되돌릴 수 있어 받는다
    assert call.flow.stage == "C_FIND_RECENT"


def test_heard_after_core_or_after_agent_finished():
    call = play(saved_db(), [say("yes", "B_DEST_CONFIRM_Q")])
    call.flow.entered_ms = 1000
    call.agent_deltas = [("이번에도 부산 해운대구 센텀로 십으로 보내시나요?", 1000, 3000)]
    from app.listener import prompt_heard
    assert prompt_heard(call, 3100)  # 숫자를 한글로 읽어도 핵심 구간을 들었다
    call.agent_deltas = [("지난번 그 사무실에서 보내시나요?", 1000, 3000)]
    assert prompt_heard(call, 3500)  # 바꿔 말했어도 말을 마친 뒤의 답은 받는다
    assert not prompt_heard(call, 2000)  # 말하는 중에 끼어듦
    assert prompt_heard(call, None)  # 시각을 모르면 따지지 않는다


def test_wait_drops_pending_commit_and_next_plain_answer_rearms():
    call = play(new_db(), NEW_ONE[:-1])
    assert call.flow.pending
    run(apply_answer(call, "none", "wait"))
    assert call.flow.pending is None
    run(apply_answer(call, "none", "none"))
    assert call.flow.pending and call.flow.stage == "A_PICKUP_TIME"


def test_input_that_paused_commit_resumes_it_when_not_a_reversal():
    """새 말(늦게 온 지난 단계의 조각 포함)이 멈춘 확정은, 그 말이 번복이 아니면 다시 잰다."""
    from app.listener import apply_side
    call = play(new_db(), NEW_ONE[:-1])
    call.flow.pending["suspended"] = True
    run(apply_side(call, "none", "none", False, None))
    assert call.flow.pending and not call.flow.pending["suspended"]
    call.flow.pending["suspended"] = True
    run(apply_side(call, "wait", "none", False, None))  # 늦은 꼬리 조각의 기다림은 정정이 아니라 단계 답처럼 버린다
    assert call.flow.pending and not call.flow.pending["suspended"]
    call.flow.pending["suspended"] = True
    run(apply_side(call, "wait", "none", True, None))  # 듣지 않던 단계에서 쌓인 "잠깐만요"는 확정을 버린다
    assert call.flow.pending is None


def test_resume_into_check_record_does_not_reset_failures():
    call = play(orders_db(), [say("lookup", "C_FIND_RECENT"), say("forgot", "C_CHECK_RECORD")] + ask("1", False))
    assert call.fail_count == 1
    report(call, say("other_task", "C_CHECK_RECORD"))
    assert call.fail_count == 1


def test_correction_outside_order_task_is_ignored():
    call = play(orders_db(), FIND)
    run(apply_answer(call, "none", "correction", "receiver_phone"))
    assert call.flow.correcting is None and call.flow.stage == "C_CHOICE"


# --- 통화 결과(백엔드 POST /api/orders, 통화당 한 번) ---

@pytest.mark.parametrize("steps, outcome, parcels", [
    (NEW_ONE, "COMPLETE", 1),  # 접수 완료한 택배가 있는데 끊김 → 그것만 접수
    (NEW_TO_PICKUP, "INCOMPLETE", 1),  # 받는 중이던 것만
    ([], "INCOMPLETE", 0),
])
def test_call_end_sends_one_result(steps, outcome, parcels):
    db = new_db()
    call = play(db, steps)
    run(call.finish())
    body = db.results[0]["body"]
    assert len(db.results) == 1 and body["outcome"] == outcome and len(body.get("parcels", [])) == parcels


def test_handoff_sends_incomplete_even_with_parcels():
    db = new_db()
    call = play(db, NEW_ONE + ask("1", False) + ask("2", False) + ask("3", False) + [say("yes", "AGENT_HANDOFF")],
                OPEN)
    run(call.finish())
    assert db.results[0]["body"]["outcome"] == "INCOMPLETE"


def test_pending_commit_is_dropped_when_call_ends():
    db = new_db()
    call = play(db, NEW_ONE[:-1])
    run(call.finish())  # 확정 보류 상태는 실행하지 않고 버린다(§2.5(8))
    assert call.flow.pending is None and not call.parcels
    assert db.results[0]["body"]["outcome"] == "INCOMPLETE"


def test_not_accepted_is_never_announced_as_success():
    db = saved_db()
    db.dver_status = "SUBMISSION_FAILED"  # 결제(월결제)는 됐지만 디버 접수 실패
    call = play(db, steps("1"))
    text = engine.next_text(call)
    assert TEXTS.say["END_PENDING"] in text and "완료" not in text


def test_card_payment_order_is_saved_but_not_announced_as_accepted():
    """개인 카드(신규 고객)는 결제 대기(notPaid): 결제 완료·접수 완료·메시지 발송을 말하지 않는다."""
    db = new_db()
    call = play(db, NEW_ONE + [say("no_more", "END_CALL")])
    assert db.results[0]["body"]["paymentMethodType"] == "billing" and db.results[0]["status"] == "notPaid"
    text = engine.next_text(call)
    assert TEXTS.say["END_NOT_PAID"].format(**call.text_vars()) in text and "완료" not in text


def test_missing_geo_is_sent_as_incomplete(monkeypatch):
    async def not_found(address_, timeout_sec, transport=None):
        return None

    monkeypatch.setattr(kakao, "geocode", not_found)
    db = new_db()
    play(db, NEW_ONE + [say("no_more", "END_CALL")])
    assert db.results[0]["body"]["outcome"] == "INCOMPLETE"


def test_end_intent_goes_to_end_call_from_anywhere():
    call = play(new_db(), NEW_TO_PICKUP[:2] + [say("none", "END_CALL", intent="end")])
    assert call.hangup_requested.is_set()
    assert run(apply_answer(call, "none", "question")) == [] and call.flow.stage == "END_CALL"


# --- 정의 ---

def test_every_diagram_node_exists():
    nodes = """CALLER_ID IS_REGISTERED B_GREET_CHOICE HUB END_CALL B_ORIGIN_ROUTE B_ORIGIN_CHANGE B_LOAD_RECENT
    B_DEST_CONFIRM_Q B_DEST_MATCH B_DEST_DIFF B_DEST_VERIFY B_DEST_FIXED A_NEW_ORDER
    A_REGISTER_SENDER A_RECEIVER_HUB A_REGISTER_RECEIVER A_ITEM_SIZE A_ITEM_VALUE A_PICKUP_TIME A_PAYMENT A_DONE A_CHOICE
    C_REQUIRED_INFO C_FIND_RECENT C_CHECK_RECORD C_CHOICE C_CANCEL_INFO C_CANCEL_CONFIRM C_CANCEL QNA RAG
    RAG_LLM_ANSWER D_AFTER_ANSWER RESTRICTED_REQUEST D_AGENT_OFFER D_AGENT_AVAILABLE AGENT_HANDOFF
    D_AFTER_NO_AGENT RESUME_TASK GLOBAL_INTENT""".split()
    assert set(engine.STAGES) == set(nodes)


def test_every_stage_reachable_and_graph_draws_transitions():
    edges = {(e.source, e.target) for e in engine.GRAPH.get_graph().edges}
    reachable = {"CALLER_ID"}
    for _ in range(len(engine.STAGES)):
        for a, b in edges:
            if a in reachable and b in engine.STAGES:
                reachable.add(b)
    assert reachable == set(engine.STAGES)
    for s in engine.STAGES.values():
        assert {(s.name, t.target) for t in s.transitions if t.target not in (engine.RETURN, engine.STAY)} <= edges
    assert {("A_PICKUP_TIME", "GLOBAL_INTENT"), ("RESUME_TASK", "A_PICKUP_TIME"), ("HUB", "END_CALL")} <= edges


def test_waiting_stages_listen_and_terminal_stages_do_not():
    call = make_call()
    assert not engine.STAGES["END_CALL"].listen and not engine.STAGES["AGENT_HANDOFF"].listen
    assert not engine.STAGES["RAG"].listen
    call.cancel_state = "running"
    assert not engine.STAGES["C_CANCEL"].listen(call)
    call.cancel_state = "failed"
    assert engine.STAGES["C_CANCEL"].listen(call)


@pytest.mark.parametrize("moves", [engine.MAX_HOPS - 1, engine.MAX_HOPS])
def test_transition_chain_limit(moves):
    """사건 하나로 MAX_HOPS번 옮겨 가면 정의 오류(전이가 끝나지 않는 정의를 막는다)."""
    names = [f"chain_{i}" for i in range(moves + 1)]
    call = make_call()
    engine.STAGES.update({n: engine.Stage(
        name=n, description=n, tools=(),
        transitions=(engine.Transition("go" if i == 0 else engine.ENTERED, names[i + 1]),) if i < moves else (),
    ) for i, n in enumerate(names)})
    try:
        engine.build()
        call.flow.stage = names[0]
        if moves < engine.MAX_HOPS:
            run(engine.apply(call, ["go"]))
            assert call.flow.stage == names[-1]
        else:
            with pytest.raises(engine.FlowError, match="끝나지 않음"):
                run(engine.apply(call, ["go"]))
    finally:
        for n in names:
            del engine.STAGES[n]
        engine.build()


def test_validate_catches_missing_tool_and_text():
    engine.STAGES["bad"] = engine.Stage(name="bad", description="x", tools=("no_such_tool",), ask="NOPE")
    try:
        with pytest.raises(engine.FlowError, match="no_such_tool") as e:
            engine.validate({"get_state"}, TEXTS, make_call().text_vars())
        assert "NOPE" in str(e.value)
    finally:
        del engine.STAGES["bad"]


def test_progress_text_within_limit_with_longest_values():
    call = play(new_db(), NEW_TO_PICKUP[:3])
    for f in ("sender_name", "sender_address", "sender_address_detail", "receiver_name", "receiver_address",
              "receiver_address_detail"):
        setattr(call.order, f, "가" * 120)
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert len(text) <= CFG.progress.max_chars and TEXTS.say["A3"] in text  # 다음에 할 말은 잘리지 않는다


def test_progress_tells_the_question_after_next():
    call = play(new_db(), [say("order", "A_REGISTER_SENDER")])
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert "먼저 성함을" in text and "그다음" in text and TEXTS.say["A1_2"] in text


def test_progress_tells_what_to_say_after_each_answer():
    """답을 고르는 질문: 판별보다 먼저 말하는 음성 모델이 답에 맞는 다음 질문을 하게 답마다 미리 알려 준다
    (2026-10-31 통화: "접수할게요" 뒤 스스로 "어디에서 보내시나요?"를 물음)."""
    call = make_call(new_db())
    assert dict(engine.preview(call))["택배를 보내겠다(접수)"] == ["A1_1"]
    assert dict(engine.preview(call))["보낸 택배를 조회·취소하겠다"] == ["NEW_LOOKUP", "A1_1"]
    assert TEXTS.say["A1_1"] in engine.progress_text(call, CFG.progress.max_chars)
    # 가는 길이 답 처리 결과에 따라 갈리면(접수 → 기존/새 출발지) 미리 말하지 않는다
    call = make_call(saved_db())
    ahead = dict(engine.preview(call))
    assert call.flow.stage == "B_GREET_CHOICE" and ahead["아니다·다른 곳에서 보내겠다·다른 용건이다"] == ["HUB_ASK"]
    assert "예·맞다(그 출발지에서 보내겠다)" not in ahead
    # 항목을 받는 단계에는 없다
    call = play(new_db(), [say("order", "A_REGISTER_SENDER")])
    assert engine.preview(call) == [] and "바로 이어서" not in engine.progress_text(call, CFG.progress.max_chars)


def test_saved_values_are_hidden_until_customer_says_them():
    call = play(saved_db(), steps("1")[:2])
    shown = dict(call.recorded())
    assert shown["받는 분 번호"] == TEXTS.saved_value and shown["받는 분"] == DEST.name
    assert shown["보내는 분 번호"] == TEXTS.saved_value  # 최근 접수 출발지의 번호도 읽지 않는다
    report(call, tool("record_order", {"receiver_phone": "01011112222"}, "A_ITEM_SIZE"))
    assert dict(call.recorded())["받는 분 번호"] == "01011112222"


def test_sender_phone_is_caller_without_asking():
    call = play(new_db(), [say("order", "A_REGISTER_SENDER")])
    assert call.order.sender_phone == CALLER and ("보내는 분 번호", TEXTS.caller_value) in call.recorded()
    assert "sender_phone" not in engine.missing(call)


def test_new_customer_is_registered_when_sender_info_is_given():
    """보내는 분 정보(성함·주소)를 다 말하면 백엔드에 고객 등록 + 보내는 곳을 개인 주소록에 저장, 이때부터 기존 고객."""
    db = new_db()
    call = play(db, NEW_TO_PICKUP[:2])
    assert call.customer_type == "registered" and db.customers[CALLER]["name"] == "김철수"
    assert [p.address for p in db.pins[CALLER]] == [FULL_ORDER["sender_address"]]
    for step in NEW_TO_PICKUP[2:] + [tool("record_order", WHEN, "A_PICKUP_TIME"), commit("A_CHOICE"),
                                     say("no_more", "END_CALL")]:
        report(call, step)
    body = db.results[0]["body"]
    assert body["customerSeq"] == call.customer_seq and "customer" not in body
    assert body["call"]["incomingAt"] == INCOMING_AT
    # 다음 통화: 접수 완료(ACCEPTED) 주문이 없어도(개인 카드 결제 대기) 등록한 주소가 기존 출발지
    again = make_call(db, session_id="live_next")
    assert again.flow.stage == "B_GREET_CHOICE" and FULL_ORDER["sender_address"] in engine.next_text(again)


def test_registration_failure_keeps_new_customer_flow():
    db = new_db()

    async def down(name, phone):
        raise RuntimeError("백엔드 없음")

    db.create_customer = down
    call = play(db, NEW_ONE + [say("no_more", "END_CALL")])
    assert call.customer_type == "new" and call.errors
    assert db.results[0]["body"]["customer"] == {"name": "김철수", "phoneNumber": CALLER}  # 결과는 이름·발신번호로
