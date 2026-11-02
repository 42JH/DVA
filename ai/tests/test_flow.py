"""분기 로직을 LLM 없이 검증(spec/flow.md): 시나리오마다 "보고 순서 → 단계 경로"를 데이터로 적는다.
보고는 세 종류: 백엔드 도구 호출(tool), 고객 답(say), 확정 지연이 끝남(commit). 고객 답은 확인 단계면 서버 판별로,
아니면 음성 모델이 알아듣고 백엔드가 보고한 것으로(answer·switch_task 도구) 넣는다.
서버가 실행하는 도구(취소)는 보고마다 바로 실행한다(sideband의 after_change와 같은 일).
정보 받기는 단계 하나(ORDER)라 경로보다 "다음에 할 말"과 임시 주문으로 확인한다.
끼어들기 시각이 필요한 시나리오는 tests/test_sideband.py에 있다."""

import json

import pytest
from conftest import CALLER, CFG, FULL_ORDER, GEO, INCOMING_AT, PICKUP_AT, TEXTS, FakeBackend, make_call, run

from app import address
from app.address import kakao
from app.config import FareConfig
from app.dispatcher import dispatch
from app.flow import engine
from app.listener import apply_answer, stage_choices
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
    db.add_customer(CALLER, "김철수", list(pins), recent=recent, payment_methods=list(payment_methods),
                    default_origin=ORIGIN if ORIGIN in pins or recent else None)
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


def say(answer, stage, intent="none"):
    """고객 답. intent: 업무 바꾸기(lookup·restricted·end → switch_task)나 확인 단계에서 섞인 용건."""
    return ("say", answer, intent, stage)


def commit(stage):
    return ("commit", None, None, stage)


def ask(question, found=True):
    """질문 → 백엔드의 search_manual → 결과로 QNA(검색 결과가 있으면 답변 뒤, 없으면 상담원 제안)."""
    return [tool("search_manual", {"question": question if found else f"모르는 {question}"},
                 "D_AFTER_ANSWER" if found else "D_AGENT_OFFER")]


TASKS = {"lookup": "lookup", "restricted": "agent", "end": "end", "order": "order"}


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
    elif engine.current(call).confirm:  # 확인 단계: 서버가 고객 말을 직접 판별(동의는 Live-1 보고와 두 열쇠)
        assert a in stage_choices(call), f"{call.flow.stage}에 없는 답 {a}"
        if a in engine.current(call).consent and b == "none":
            assert run(dispatch(call, "answer", json.dumps({"choice": a}), f"a{i}"))["ok"]
        out = run(apply_answer(call, a, b))
    else:  # 음성 모델이 알아들은 답을 백엔드가 보고
        out = None
        if a != "none":
            out = run(dispatch(call, "answer", json.dumps({"choice": a}), f"a{i}"))
            assert out["ok"], out
    if kind == "say" and b in TASKS:
        out = run(dispatch(call, "switch_task", json.dumps({"task": TASKS[b]}), f"t{i}"))
    serve(call)
    return out


# 정보 받기 질문(문구 키) → 그 질문이 받는 항목. 질문은 늘 빠진 항목만 묻는다(이미 채운 항목을 다시 묻지 않는다)
ASKS = {"A1_1": "sender_name", "A1_3": "sender_phone", "A1_2": "sender_address", "ORIGIN_ASK": "sender_address",
        "GREET_REGISTERED": "sender_address", "A_ADDR_RETRY_SENDER": "sender_address",
        "A_ADDR_DETAIL_SENDER": "sender_address_detail", "B4": "receiver_name", "B6": "receiver_name",
        "B8": "receiver_name", "B9": "receiver_name", "A2_1": "receiver_name", "A2_2": "receiver_phone",
        "A2_3": "receiver_address", "A_ADDR_RETRY_RECEIVER": "receiver_address",
        "A_ADDR_DETAIL_RECEIVER": "receiver_address_detail", "A3": "item", "A4": "item_price", "A5": "pickup_at"}


def check_question(call):
    """정보 받기 중이면 지금 질문이 묻는 항목이 비어 있다(2026-11-01 통화: 받는 곳 주소를 받은 뒤에도 주소를 되풀이)."""
    if call.flow.stage != "ORDER":
        return
    for key in engine.question(call):
        field = ASKS.get(key)
        assert field is None or not call.field_done(field), f"이미 채운 {field}를 묻는 {key}"


def cancelled(db):
    return sum(p["status"] == "CANCELLED" for o in db.orders for p in o["parcels"])


class Rules:
    """AGENTS.md "안전장치"를 모든 시나리오의 보고마다 확인한다. 장치(판별·지연·문구)가 아니라 지켜야 할 결과를 본다.
    고객 동의 = 그 확인 단계에서 다른 용건 없이 "예"를 보고한 것. 되돌릴 수 없는 일은 동의한 횟수를 넘지 않는다."""

    CONSENT = ("A_CONFIRM", "C_CANCEL_CONFIRM", "D_AGENT_OFFER")  # 택배 담기·취소·상담원 연결의 확인 질문

    def __init__(self, call, db):
        self.call, self.db = call, db
        self.yes = dict.fromkeys(self.CONSENT, 0)
        self.cancelled = cancelled(db)

    def before(self, step):
        kind, answer, intent, _ = step
        if kind == "say" and answer == "yes" and intent == "none" and self.call.flow.stage in self.yes:
            self.yes[self.call.flow.stage] += 1
        self.order, self.parcels = self.call.order.model_copy(deep=True), len(self.call.parcels)

    def after(self, i):
        call, db, yes = self.call, self.db, self.yes
        where = f"{i}번째 보고 뒤 {call.flow.stage}"
        # 빠진 항목이 있으면 되읽기 확인(A_CONFIRM)으로 가지 않는다
        assert call.flow.stage != "A_CONFIRM" or (call.order.complete() and call.pickup_at), f"{where}: 빠진 항목"
        # 택배는 접수 확인에 동의한 만큼만, 임시 주문 그대로 담는다
        assert len(call.parcels) <= yes["A_CONFIRM"], f"{where}: 동의 없이 택배를 담음"
        if len(call.parcels) > self.parcels:
            assert call.parcels[-1] == self.order and self.order.complete(), f"{where}: 담은 택배가 임시 주문과 다름"
        # 취소는 취소 확인에 동의한 만큼만
        assert cancelled(db) - self.cancelled <= yes["C_CANCEL_CONFIRM"], f"{where}: 동의 없이 취소"
        # 상담원 연결은 동의했을 때만(탈퇴 고객은 다이어그램 밖 바로 연결, entry.py)
        assert not call.refer_requested.is_set() or yes["D_AGENT_OFFER"] or call.customer_type == "withdrawn", \
            f"{where}: 동의 없이 상담원 연결"
        assert len(db.results) <= 1, f"{where}: 접수를 두 번 보냄"  # 통화당 한 번


def play(db, steps, cfg=None):
    call = make_call(db)
    call.rag, call.cfg = FakeRag(), cfg or call.cfg
    rules = Rules(call, db)
    for i, step in enumerate(steps):
        rules.before(step)
        report(call, step, i)
        assert call.flow.stage == step[3], f"{i}번째 {step}: {call.flow.stage}"
        check_question(call)
        rules.after(i)
    return call


def path(call):
    return [call.flow.history[0]["from"]] + [h["to"] for h in call.flow.history]


def said(call, key, **values):
    """진행 상태의 "다음"에 그 문구(값을 채운 것)가 있음."""
    return TEXTS.say[key].format(**{**call.text_vars(), **values}) in engine.next_text(call)


# 등록 고객: 인사(기존 출발지 제안) 예 → 최근 도착지 예
SAVED_TO_ITEM = [say("yes", "ORDER"), say("yes", "ORDER")]
NEW_TO_PICKUP = [say("order", "ORDER"), tool("record_order", SENDER, "ORDER"), tool("record_order", RECEIVER, "ORDER"),
                 tool("record_order", ITEM, "ORDER")]
NEW_ONE = NEW_TO_PICKUP + [tool("record_order", WHEN, "A_CONFIRM"), say("yes", "A_CONFIRM"), commit("A_CHOICE")]
FIND = [say("none", "C_FIND_RECENT", intent="lookup"),
        tool("lookup_orders", {"receiver_name": "박민수"}, "C_CHECK_RECORD"), say("yes", "C_CHOICE")]
ENTRY_SAVED = ["CALLER_ID", "IS_REGISTERED", "ORDER"]
ENTRY_NEW = ["CALLER_ID", "IS_REGISTERED", "HUB"]
TAIL = ["A_CONFIRM", "A_PAYMENT", "A_DONE", "A_CHOICE"]
LOOKUP = ["C_REQUIRED_INFO", "C_FIND_RECENT"]
QNA = ["GLOBAL_INTENT", "QNA", "RAG"]
ANSWERED = QNA + ["RAG_LLM_ANSWER", "D_AFTER_ANSWER"]
NO_ANSWER = QNA + ["D_AGENT_OFFER"]

# (이름, DB 준비, [보고], 기대 단계 경로, 설정)
SCENARIOS = [
    ("1 기존 출발지 예 → 최근 도착지 예 → 접수 완료 후 종료", saved_db, SAVED_TO_ITEM + [
        tool("record_order", {"small_box_count": 1}, "ORDER"),
        tool("record_order", {"item_price": 30000}, "ORDER"),
        tool("record_order", WHEN, "A_CONFIRM"), say("yes", "A_CONFIRM"),
        commit("A_CHOICE"),
        say("no_more", "END_CALL"),
    ], ENTRY_SAVED + TAIL + ["HUB", "END_CALL"], None),
    ("2 인사에 접수가 아닌 용건 → 무엇을 도와드릴까요 → 조회", saved_db, [
        say("other", "HUB"),
        say("lookup", "C_FIND_RECENT"),
    ], ENTRY_SAVED + ["HUB"] + LOOKUP, None),
    ("3 인사 아니요(다른 곳) → 출발지 주소 → 최근 도착지 확인", saved_db, [
        say("no", "ORDER"),
        tool("record_order", {"sender_address": "인천 연수구 송도동 1", "sender_address_detail": ""}, "ORDER"),
    ], ENTRY_SAVED, None),
    ("3-1 도착지 아니요 → 주소만 → 여러 핀 → 층 고르기 → 확인 예", floors_db, [
        say("yes", "ORDER"), say("no", "ORDER"),
        tool("match_pins", {"place": "센텀로"}, "ORDER"),
        say("pin_2", "ORDER"),
        say("yes", "ORDER"),
    ], ENTRY_SAVED, None),
    ("3-2 이름만 → 핀 없음 → 주소 → 핀 없음 → 연락처만 받고 접수", saved_db, [
        say("yes", "ORDER"), say("no", "ORDER"),
        tool("match_pins", {"name": "최지우"}, "ORDER"),
        tool("match_pins", {"place": "대구 중구 동성로 1"}, "ORDER"),
        tool("record_order", {"receiver_phone": "010-5555-6666", "receiver_address_detail": ""}, "ORDER"),
        tool("record_order", ITEM, "ORDER"),
        tool("record_order", WHEN, "A_CONFIRM"), say("yes", "A_CONFIRM"),
        commit("A_CHOICE"),
    ], ENTRY_SAVED + TAIL, None),
    ("5 신규 고객 조회 요청 → 안내 후 접수", new_db, [say("lookup", "ORDER")], ENTRY_NEW + ["ORDER"], None),
    ("6 조회: 기억 안 남 → 최근부터 → 아니오 → 그 전 → 맞음 → 상태 → 아니오", orders_db, [
        say("none", "C_FIND_RECENT", intent="lookup"),
        say("forgot", "C_CHECK_RECORD"),
        say("no", "C_CHECK_RECORD"),
        say("yes", "C_CHOICE"),
        say("no", "HUB"),
    ], ENTRY_SAVED + LOOKUP + ["C_CHECK_RECORD", "C_CHOICE", "HUB"], None),
    ("7 조회 → 취소 → 예 → 성공 → HUB", orders_db, FIND + [
        say("cancel", "C_CANCEL_CONFIRM"),
        say("yes", "C_CANCEL_CONFIRM"),
        commit("HUB"),
    ], ENTRY_SAVED + LOOKUP + ["C_CHECK_RECORD", "C_CHOICE", "C_CANCEL_INFO", "C_CANCEL_CONFIRM", "C_CANCEL", "HUB"],
     None),
    ("8 조회 → 취소 → 이미 수거 → HUB", picked_db, FIND + [say("cancel", "HUB")],
     ENTRY_SAVED + LOOKUP + ["C_CHECK_RECORD", "C_CHOICE", "C_CANCEL_INFO", "HUB"], None),
    ("9 접수 중 질문 → 답변 → 다른 업무 → 접수로 복귀", new_db, NEW_TO_PICKUP + ask("배송 며칠") + [
        say("other_task", "ORDER"),
    ], ENTRY_NEW + ["ORDER"] + ANSWERED + ["RESUME_TASK", "ORDER"], None),
    ("10 RAG 실패 3번째에 상담원 제안 → 예 → 연결 가능 → 이관", saved_db,
     ask("1", False) + ask("2", False) + ask("3", False) + [say("yes", "AGENT_HANDOFF")],
     ENTRY_SAVED + NO_ANSWER * 3 + ["D_AGENT_AVAILABLE", "AGENT_HANDOFF"], OPEN),
    ("12 상담원 연결 불가 → 추가 질문 → QnA → 다른 업무 → 복귀", saved_db,
     ask("1", False) + ask("2", False) + ask("3", False) + [say("yes", "D_AFTER_NO_AGENT")] + ask("4") + [
         say("other_task", "ORDER")],
     ENTRY_SAVED + NO_ANSWER * 3 + ["D_AGENT_AVAILABLE", "D_AFTER_NO_AGENT"] + ANSWERED + ["RESUME_TASK", "ORDER"],
     CLOSED),
    ("14 조회 결과에서 수정 → 제한된 요청 → 다른 업무 → 복귀", orders_db, FIND + [
        say("modify", "D_AGENT_OFFER"),
        say("other_task", "C_CHOICE"),
    ], ENTRY_SAVED + LOOKUP + ["C_CHECK_RECORD", "C_CHOICE", "GLOBAL_INTENT", "RESTRICTED_REQUEST", "D_AGENT_OFFER",
                               "RESUME_TASK", "C_CHOICE"], None),
    ("21 받는 분 번호 정정 → 고친 값 확인 → 하던 질문으로", new_db, NEW_TO_PICKUP[:3] + [
        tool("record_order", {"small_box_count": 1}, "ORDER"),
        tool("record_order", {"receiver_phone": "010-1111-2222"}, "ORDER"),
    ], ENTRY_NEW + ["ORDER"], None),
    ("22 저장된 도착지 정정 → 주소록 찾기부터 다시", saved_db, SAVED_TO_ITEM + [
        tool("record_order", {"small_box_count": 1}, "ORDER"),
        tool("match_pins", {"name": "이영희", "place": "마포"}, "ORDER"),
        say("yes", "ORDER"),
    ], ENTRY_SAVED, None),
    ("23 인사에 예 + 이름 정정(한 마디에 답과 정정)", saved_db, [
        say("yes", "ORDER"),
        tool("record_order", {"sender_name": "박민수"}, "ORDER"),
    ], ENTRY_SAVED, None),
    ("24 순서 밖 정보부터 말해도 기록 → 다 차면 되읽기", new_db, [
        say("order", "ORDER"),
        tool("record_order", {**ITEM, **WHEN}, "ORDER"),
        tool("record_order", RECEIVER, "ORDER"),
        tool("record_order", SENDER, "A_CONFIRM"),
    ], ENTRY_NEW + ["ORDER", "A_CONFIRM"], None),
    ("25 용건 없이 주문 정보부터 말함 → 접수", new_db, [tool("record_order", SENDER, "ORDER")],
     ENTRY_NEW + ["ORDER"], None),
    ("26 되읽기에 예 + 정정 → 확정하지 않고 고친 뒤 다시 확인", new_db, NEW_TO_PICKUP + [
        tool("record_order", WHEN, "A_CONFIRM"),
        say("yes", "A_CONFIRM", intent="correction"),
        tool("record_order", {"receiver_name": "이영수"}, "A_CONFIRM"),
        say("yes", "A_CONFIRM"),
        commit("A_CHOICE"),
    ], ENTRY_NEW + ["ORDER"] + TAIL, None),
    ("27 인사 질문 중 질문 → 답변 → 인사 질문으로 복귀", saved_db, [
        tool("search_manual", {"question": "배송 며칠"}, "D_AFTER_ANSWER"),
        say("other_task", "ORDER"),
    ], ENTRY_SAVED + ANSWERED + ["RESUME_TASK", "ORDER"], None),
    ("28 추가 접수 질문에 다음 택배 정보를 바로 말함 → 받기", new_db, NEW_ONE + [
        tool("record_order", {"receiver_name": "박민수"}, "ORDER"),
    ], ENTRY_NEW + ["ORDER"] + TAIL + ["ORDER"], None),
]


def steps(no: str) -> list:
    """시나리오 번호("3-1" 등)의 보고 목록."""
    return next(sc[2] for sc in SCENARIOS if sc[0].split()[0] == no)


@pytest.mark.parametrize("name, make_db, steps, expected_path, cfg", SCENARIOS, ids=[s[0] for s in SCENARIOS])
def test_scenario(name, make_db, steps, expected_path, cfg):
    assert path(play(make_db(), steps, cfg)) == expected_path


# --- 접수 결과·운임·결제 ---

def test_1_registered_order_submits_once_and_hangs_up():
    db = saved_db()
    call = play(db, steps("1"))
    assert len(db.results) == 1 and call.hangup_requested.is_set()
    body = db.results[0]["body"]
    assert body["outcome"] == "COMPLETE" and body["customerSeq"] == call.customer_seq
    assert body["paymentMethodType"] == "credit"
    assert body["parcels"][0]["origin"]["roadAddress"] == ORIGIN.address  # 기존 출발지 그대로
    assert body["parcels"][0]["destination"]["roadAddress"] == DEST.address
    text = engine.next_text(call)
    assert "TEST0001" in text and TEXTS.say["END_CALL"] in text  # ACCEPTED만 접수 완료 안내


def test_1_fare_notice_waits_for_commit_then_is_not_repeated():
    call = play(saved_db(), steps("1")[:6])
    assert call.flow.pending and call.flow.stage == "A_CONFIRM"
    # 확정을 기다리는 동안은 새 질문 없이 기다린다. 확정되면 운임 → 결제 방식 → 추가 접수 질문을 한 진행 상태로
    assert engine.next_text(call) == TEXTS.note["COMMIT_WAIT"]
    report(call, commit("A_CHOICE"))
    assert engine.next_text(call) == f"'운임은 4,000원이에요.' '{TEXTS.say['PAY_CREDIT']}' '{TEXTS.say['A_ADDED']}' '{TEXTS.say['A8']}'"
    assert len(call.parcels) == 1 and call.payment_method == "credit"


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
    call = play(db, steps("1")[:6], no_fare)
    report(call, steps("1")[6])
    assert engine.next_text(call).startswith(f"'{TEXTS.say['PAY_CREDIT']}'") and "운임" not in engine.next_text(call)
    report(call, steps("1")[7])
    body = db.results[0]["body"]
    assert body["outcome"] == "INCOMPLETE" and "totalAmount" not in body and "notifiedPrice" not in body["parcels"][0]


def test_both_postpaid_methods_ask_and_wait_reverts_choice():
    """기업 월결제와 부서 그룹결제를 둘 다 쓸 수 있으면 묻는다. 고른 답은 확정 지연 뒤에 정한다."""
    db = saved_db(payment_methods=("billing", "credit", "groupBilling"))
    call = play(db, steps("1")[:4] + [tool("record_order", WHEN, "A_CONFIRM"), say("yes", "A_PAYMENT")])
    assert engine.next_text(call) == f"'운임은 4,000원이에요.' '{TEXTS.say['PAY_ASK']}'"
    assert set(stage_choices(call)) == {"credit", "groupBilling", "none"}
    report(call, say("groupBilling", "A_PAYMENT"))
    assert call.flow.pending and call.payment_method is None
    run(apply_answer(call, "none", "wait"))  # "잠깐만요": 고른 것을 정하지 않고 다시 묻는다
    assert call.flow.pending is None and call.payment_method is None and call.flow.stage == "A_PAYMENT"
    report(call, say("groupBilling", "A_PAYMENT"))
    report(call, commit("A_CHOICE"))
    assert call.payment_method == "groupBilling"
    assert engine.next_text(call) == f"'{TEXTS.say['PAY_GROUP']}' '{TEXTS.say['A_ADDED']}' '{TEXTS.say['A8']}'"


def test_card_payment_order_is_saved_but_not_announced_as_accepted():
    """개인 카드(신규 고객)는 결제 대기(notPaid): 결제 완료·접수 완료·메시지 발송을 말하지 않는다."""
    db = new_db()
    call = play(db, NEW_ONE + [say("no_more", "END_CALL")])
    assert db.results[0]["body"]["paymentMethodType"] == "billing" and db.results[0]["status"] == "notPaid"
    text = engine.next_text(call)
    assert TEXTS.say["END_NOT_PAID"].format(**call.text_vars()) in text and "완료" not in text


def test_not_accepted_is_never_announced_as_success():
    db = saved_db()
    db.dver_status = "SUBMISSION_FAILED"  # 결제(월결제)는 됐지만 디버 접수 실패
    call = play(db, steps("1"))
    text = engine.next_text(call)
    assert TEXTS.say["END_PENDING"] in text and "완료" not in text


def test_missing_geo_is_sent_as_incomplete(monkeypatch):
    async def not_found(address_, timeout_sec, transport=None):
        return None

    monkeypatch.setattr(kakao, "geocode", not_found)
    db = new_db()
    play(db, NEW_ONE + [say("no_more", "END_CALL")])
    assert db.results[0]["body"]["outcome"] == "INCOMPLETE"


# --- 진입과 기존 출발지 제안 ---

@pytest.mark.parametrize("make_db, caller, stage, greeting", [
    (new_db, CALLER, "HUB", "GREET_NEW"),
    (new_db, None, "HUB", "GREET_NEW"),
    (saved_db, CALLER, "ORDER", "GREET_REGISTERED"),
    (no_recent_db, CALLER, "HUB", "GREET_REGISTERED_PLAIN"),  # TODO(flow): 최근 접수도 본인 주소도 없을 때
    (own_pin_db, CALLER, "ORDER", "GREET_REGISTERED"),  # 접수 완료 주문이 없으면 본인 주소록 주소
    (withdrawn_db, CALLER, "AGENT_HANDOFF", "D9"),
])
def test_start(make_db, caller, stage, greeting):
    call = make_call(make_db(), caller=caller)
    assert call.flow.stage == stage and TEXTS.say[greeting].format(**call.text_vars()) in engine.next_text(call)


def test_registered_greeting_is_origin_offer_then_recent_destination():
    call = make_call(saved_db())
    assert engine.next_text(call) == "'김철수님, 안녕하세요. 서울 강남구 테헤란로 212에서 보내시는 택배 맞으실까요?'"
    assert set(stage_choices(call)) == {"yes", "no", "other", "none"}
    report(call, say("yes", "ORDER"))
    assert engine.next_text(call) == "'이번에도 부산 해운대구 센텀로 10로 보내시나요?'"
    assert call.order.sender_name == ORIGIN.name and call.order.sender_phone == CALLER
    assert call.order.sender_address == ORIGIN.address and call.order.sender_address_detail == "1201호"
    report(call, say("yes", "ORDER"))
    assert engine.next_text(call) == f"'{TEXTS.say['A3']}'"  # 다음 빠진 항목(물품)
    assert call.order.receiver_name == DEST.name and call.order.receiver_phone == DEST.phone


def test_registered_greeting_and_call_info_use_name():
    call = make_call(saved_db())
    info = TEXTS.call_info.format(**call.text_vars(), first=engine.next_text(call))
    assert "김철수님, 안녕하세요" in info and ORIGIN.address in info


def test_greeting_other_says_what_can_i_do_and_next_order_asks_origin():
    call = play(saved_db(), [say("other", "HUB")])
    assert engine.next_text(call) == f"'{TEXTS.say['HUB_ASK']}'" and call.origin_offer is None
    report(call, say("order", "ORDER"))  # 접수가 아니라고 했으니 기존 출발지를 다시 제안하지 않고 묻는다
    assert said(call, "A1_2") and not call.origin_offer


def test_greeting_lookup_intent_goes_straight_to_lookup():
    call = play(saved_db(), [say("none", "C_FIND_RECENT", intent="lookup")])
    assert said(call, "C1") and call.flow.task == "lookup"


def test_3_origin_no_keeps_sender_and_asks_only_address():
    call = play(saved_db(), steps("3")[:1])
    assert call.order.sender_name == "김철수" and call.order.sender_phone == CALLER  # 이름·번호 재질문 없음
    assert engine.next_text(call) == f"'{TEXTS.say['A1_2']}'"
    report(call, steps("3")[1])
    assert call.order.sender_address == "인천 연수구 송도동 1" and said(call, "B4")


def test_registered_without_recent_order_asks_origin_then_open_destination():
    """TODO(flow): 백엔드가 최근 접수를 주지 않으면 출발지 없이 인사하고, 접수는 출발지 주소·B6부터(§9)."""
    call = play(no_recent_db(), [say("order", "ORDER")])
    assert call.order.sender_name == "김철수" and call.order.sender_phone == CALLER  # MVP: 고객 = 보내는 분
    assert said(call, "A1_2")
    report(call, tool("record_order", {"sender_address": "인천 연수구 송도동 1", "sender_address_detail": ""}, "ORDER"))
    assert engine.next_text(call) == f"'{TEXTS.say['B6']}'"


def test_23_greeting_yes_with_name_correction_keeps_answer_then_records_name():
    """인사에 "네, 근데 이름이 박민수예요": 백엔드가 답(예)과 고친 이름을 각각 보고한다. 출발지를 쓴 뒤 이름을 고친다."""
    call = play(saved_db(), steps("23")[:1])
    assert call.order.sender_address == ORIGIN.address
    report(call, steps("23")[1])
    assert call.order.sender_name == "박민수"
    assert "박민수" in engine.next_text(call) and said(call, "B4")  # 고친 값을 한 번 확인하고 다음 질문


def test_greeting_name_correction_keeps_origin_question():
    """출발지 확인에 "아니요, 제 이름이 틀렸어요": 질문의 답이 아니므로 단계는 그대로. 음성 모델이 고친 이름을 받아
    백엔드가 기록하면 고친 값을 확인하고 출발지 확인을 다시 묻는다(2026-11-01 23:14 통화: 판별기가 "다른 일"로 읽어
    HUB → 조회로 빠지고 정정이 버려짐)."""
    call = play(saved_db(), [tool("record_order", {"sender_name": "최예린"}, "ORDER")])
    assert call.flow.task == "order" and call.origin_offer and call.order.sender_name == "최예린"
    assert "최예린" in engine.next_text(call) and said(call, "ORIGIN_ASK")


def test_27_answer_with_question_takes_only_the_question_then_asks_again():
    """"네, 근데 요금은요?": 질문만 받고, 답변이 끝나면 그 질문(기존 출발지)으로 돌아와 다시 묻는다(2026-11-01 결정)."""
    call = play(saved_db(), steps("27"))
    assert call.order.sender_address is None and said(call, "ORIGIN_ASK")


# --- 정보 받기(ORDER): 순서 밖·정정·예외 ---

def test_24_out_of_order_values_are_recorded_and_only_missing_asked():
    call = play(new_db(), steps("24")[:2])
    assert call.order.small_box_count == 1 and call.pickup_at is not None
    assert engine.next_text(call) == f"'{TEXTS.say['A1_1']}'"  # 빠진 첫 항목(권장 순서)
    report(call, steps("24")[2])
    assert said(call, "A1_1") and "receiver_name" not in engine.missing(call)


def test_progress_gives_only_the_next_question_not_what_to_say_before_the_result():
    """진행 상태는 지금 할 말만 준다. 결과가 오기 전에 미리 말할 것(그다음 항목·답마다 이어서 할 말)을 주면, 위임한 턴에
    음성 모델이 그것을 먼저 말하고 결과도 말해 두 번 말했다(2026-11-02 00:07 통화: 번호 정정 중 "맞으신 거죠?" 뒤
    "다시 불러 주시겠어요?")."""
    call = play(new_db(), [say("order", "ORDER")])
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert "먼저 성함을" in text and TEXTS.say["A1_2"] not in text
    call = make_call(saved_db())  # 제안 질문(기존 출발지)도 답마다 이어서 할 말을 미리 주지 않는다
    text = engine.progress_text(call, CFG.progress.max_chars)
    assert TEXTS.say["B4"].split("{")[0] not in text and TEXTS.say["A1_2"] not in text


def test_sender_phone_is_caller_without_asking_and_asked_only_without_caller():
    call = play(new_db(), [say("order", "ORDER")])
    assert call.order.sender_phone == CALLER and ("보내는 분 번호", TEXTS.caller_value) in call.recorded()
    assert "sender_phone" not in engine.missing(call)
    call = make_call(new_db(), caller=None)
    run(apply_answer(call, "order", "none"))
    report(call, tool("record_order", {"sender_name": "김철수"}, "ORDER"))
    assert engine.next_text(call) == f"'{TEXTS.say['A1_3']}'"  # 발신번호가 없으면 묻는다(접수가 멈추지 않게)


def test_new_customer_address_retry_texts_and_detail_names_which_address(monkeypatch):
    async def correct(text):
        return {"status": "not_found", "candidates": []} if "없는" in text else {"status": "confirmed",
                                                                                "candidates": [text]}

    monkeypatch.setattr(address, "correct", correct)
    call = play(new_db(), [say("order", "ORDER")])
    assert "먼저 성함을" in engine.next_text(call)
    report(call, tool("record_order", {"sender_name": "김철수"}, "ORDER"))
    assert engine.next_text(call) == f"'{TEXTS.say['A1_2']}'"  # 전화번호는 묻지 않고 발신번호로 등록
    report(call, tool("record_order", {"sender_address": "없는 주소 1"}, "ORDER"))
    assert said(call, "A_ADDR_RETRY_SENDER")
    report(call, tool("record_order", {"sender_address": ORIGIN.address}, "ORDER"))
    assert said(call, "A_ADDR_DETAIL_SENDER")
    report(call, tool("record_order", {"sender_address_detail": "1201호"}, "ORDER"))
    # 받는 분 성함과 주소를 한 번에 말했는데 주소를 못 찾으면 연락처보다 주소를 먼저 다시 묻는다
    report(call, tool("record_order", {"receiver_name": "이영희", "receiver_address": "없는 주소 2"}, "ORDER"))
    assert engine.next_text(call).startswith(f"'{TEXTS.say['A_ADDR_RETRY_RECEIVER']}'")
    report(call, tool("record_order", {"receiver_phone": "010-9876-5432"}, "ORDER"))
    assert said(call, "A_ADDR_RETRY_RECEIVER") and "보내시는 곳" not in engine.next_text(call)


def test_new_customer_second_parcel_uses_previous_origin_and_recent_destination():
    db = new_db()
    call = play(db, NEW_ONE + [say("order", "ORDER")])
    assert call.customer_type == "registered"  # 보내는 분 정보를 다 말한 순간 등록
    assert call.order.sender_address == FULL_ORDER["sender_address"] and not call.origin_offer  # 묻지 않고 그대로
    assert engine.next_text(call).endswith(f"'이번에도 {DEST.address}로 보내시나요?'")


def test_second_parcel_skips_pickup_and_keeps_call_values():
    db = new_db()
    call = play(db, NEW_ONE + [say("order", "ORDER"), say("yes", "ORDER"), tool("record_order", ITEM, "A_CONFIRM"),
                               say("yes", "A_CONFIRM")])
    assert call.flow.pending  # 수거 일시는 통화에 하나: 이미 있어 되읽기 확인 뒤 결제 단계 진입만 기다린다
    report(call, commit("A_CHOICE"))
    report(call, say("no_more", "END_CALL"))
    body = db.results[0]["body"]
    assert body["outcome"] == "COMPLETE" and len(body["parcels"]) == 2 and body["customerSeq"] == call.customer_seq


def test_21_correction_confirms_new_value_and_returns():
    call = play(new_db(), steps("21")[:-1])
    before = call.order.model_dump()
    report(call, steps("21")[-1])
    text = engine.next_text(call)
    assert "받으시는 분 연락처를 01011112222으로 바꿀게요" in text and TEXTS.say["A4"] in text
    assert call.order.model_dump() == {**before, "receiver_phone": "01011112222"}
    call.flow.notice = []  # 보낸 뒤에는 다시 말하지 않는다(app/progress.py)
    assert engine.next_text(call) == f"'{TEXTS.say['A4']}'"


def test_22_saved_destination_correction_drops_old_match():
    """저장된 곳에서 가져온 받는 곳을 다른 곳으로 말하면(match_pins) 그 받는 분 묶음을 비우고 새로 찾는다."""
    call = play(saved_db(), steps("22")[:4])
    assert call.pin_offer == DEST2 and said(call, "B9") and call.order.receiver_name is None
    assert call.order.small_box_count == 1  # 물품은 그대로
    report(call, steps("22")[4])
    assert call.order.receiver_address == DEST2.address and said(call, "A4")


def test_saved_origin_correction_asks_new_origin_keeping_sender():
    call = play(saved_db(), SAVED_TO_ITEM + [
        tool("record_order", {"sender_address": "인천 연수구 송도동 1", "sender_address_detail": ""}, "ORDER")])
    assert call.order.sender_name == "김철수" and call.order.sender_address == "인천 연수구 송도동 1"
    assert call.order.receiver_address == DEST.address  # 도착지는 그대로


def test_offer_dropped_when_customer_says_new_value_instead():
    call = play(saved_db(), [tool("record_order", {"sender_address": "인천 연수구 송도동 1"}, "ORDER")])
    assert call.origin_offer is None and said(call, "A_ADDR_DETAIL_SENDER")  # 제안에 답하지 않고 새 주소를 말함
    call = play(saved_db(), [say("yes", "ORDER"), tool("record_order", {"receiver_name": "최지우"}, "ORDER")])
    assert call.dest_offer is None and said(call, "A2_2")


def test_past_pickup_date_is_told_once_then_asked_again():
    call = play(new_db(), NEW_TO_PICKUP)
    out = report(call, tool("record_order", {"pickup_at": "2020-01-01T10:00:00+09:00"}, "ORDER"))
    assert out["ok"] is False and call.pickup_at is None
    text = engine.next_text(call)
    assert "이미 지나서" in text and f"오늘은 {call.text_vars()['월']}월" in text and TEXTS.say["A5"] in text


def test_9_slots_kept_after_qna():
    call = play(new_db(), NEW_TO_PICKUP)
    before = call.order.model_dump()
    for step in ask("배송 며칠") + [say("other_task", "ORDER")]:
        report(call, step)
    assert call.order.model_dump() == before and said(call, "A5")


def test_order_value_said_during_qna_goes_back_to_order():
    call = play(new_db(), NEW_TO_PICKUP + ask("배송 며칠"))
    report(call, tool("record_order", WHEN, "A_CONFIRM"))  # 답변 뒤 단계에서 기록 → 하던 접수로(다 차서 되읽기)
    assert call.flow.stage == "A_CONFIRM"


def test_new_customer_is_registered_when_sender_info_is_given():
    """보내는 분 정보(성함·주소)를 다 말하면 백엔드에 고객 등록 + 보내는 곳을 개인 주소록에 저장, 이때부터 기존 고객."""
    db = new_db()
    call = play(db, NEW_TO_PICKUP[:2])
    assert call.customer_type == "registered" and db.customers[CALLER]["name"] == "김철수"
    assert [p.address for p in db.pins[CALLER]] == [FULL_ORDER["sender_address"]]
    for step in NEW_TO_PICKUP[2:] + [tool("record_order", WHEN, "A_CONFIRM"), say("yes", "A_CONFIRM"),
                                     commit("A_CHOICE"), say("no_more", "END_CALL")]:
        report(call, step)
    body = db.results[0]["body"]
    assert body["customerSeq"] == call.customer_seq and "customer" not in body
    assert body["call"]["incomingAt"] == INCOMING_AT
    # 개인 PIN 저장은 고객 기본주소 등록과 별개다. 기본주소가 없는 다음 통화는 출발지를 자동 제안하지 않는다.
    again = make_call(db, session_id="live_next")
    assert again.flow.stage == "HUB" and again.origin_offer is None
    assert again.pins[0].address == FULL_ORDER["sender_address"]


def test_registration_is_tried_once_and_failure_keeps_new_customer_flow():
    db = new_db()
    tries = []

    async def down(name, phone):
        tries.append(name)
        raise RuntimeError("백엔드 없음")

    db.create_customer = down
    call = play(db, NEW_ONE + [say("no_more", "END_CALL")])
    assert call.customer_type == "new" and call.errors and len(tries) == 1  # 기록할 때마다 다시 하지 않는다
    assert db.results[0]["body"]["customer"] == {"name": "김철수", "phoneNumber": CALLER}  # 결과는 이름·발신번호로


# --- 되읽기 확인(관문) ---

def test_confirm_reads_back_order_and_no_asks_what_to_fix():
    call = play(new_db(), NEW_TO_PICKUP + [tool("record_order", WHEN, "A_CONFIRM")])
    text = engine.next_text(call)
    assert "받는 분 이영희님" in text and "이대로 접수할까요?" in text and "1201호" in text  # 고객이 말한 상세주소는 읽는다
    report(call, say("no", "A_CONFIRM"))
    assert engine.next_text(call).endswith(f"'{TEXTS.say['A_CONFIRM_FIX']}'") and "이대로" not in engine.next_text(call)
    report(call, tool("record_order", {"receiver_phone": "010-1111-2222"}, "A_CONFIRM"))
    assert "이대로 접수할까요?" in engine.next_text(call)  # 고친 값으로 다시 되읽기


def test_26_yes_with_correction_at_confirm_is_not_committed():
    call = play(new_db(), steps("26")[:6])
    assert call.flow.pending is None and call.flow.stage == "A_CONFIRM"
    report(call, steps("26")[6])
    assert call.order.receiver_name == "이영수" and "받는 분 이영수님" in engine.next_text(call)


def test_confirm_value_cleared_goes_back_to_order(monkeypatch):
    async def correct(text):
        return {"status": "not_found", "candidates": []}

    call = play(new_db(), NEW_TO_PICKUP + [tool("record_order", WHEN, "A_CONFIRM")])
    monkeypatch.setattr(address, "correct", correct)
    report(call, tool("record_order", {"receiver_address": "대구 없는 길 1"}, "ORDER"))
    assert said(call, "A_ADDR_RETRY_RECEIVER")


def test_saved_values_are_not_read_back():
    call = play(saved_db(), steps("1")[:5])
    text = engine.next_text(call)
    assert "1201호" not in text and DEST.phone not in text  # 저장된 상세주소·번호는 읽지 않는다


def test_wait_drops_pending_commit_and_only_yes_rearms():
    call = play(new_db(), NEW_ONE[:-1])
    assert call.flow.pending
    run(apply_answer(call, "none", "wait"))
    assert call.flow.pending is None
    run(apply_answer(call, "none", "none"))
    assert call.flow.pending is None  # 되읽기 확정은 고객의 "예"로만 다시 건다
    report(call, say("yes", "A_CONFIRM"))
    assert call.flow.pending and call.flow.stage == "A_CONFIRM"


def test_input_that_paused_commit_resumes_it_when_not_a_reversal():
    """새 말(늦게 온 지난 단계의 조각 포함)이 멈춘 확정은, 그 말이 번복·끼어드는 용건이 아니면 다시 잰다."""
    from app.listener import apply_side
    call = play(new_db(), NEW_ONE[:-1])
    call.flow.pending["suspended"] = True
    run(apply_side(call, "none"))
    assert call.flow.pending and not call.flow.pending["suspended"]
    call.flow.pending["suspended"] = True
    run(apply_side(call, "wait"))  # "잠깐만요"는 확정을 버린다
    assert call.flow.pending is None


def test_lookup_intent_during_pending_commit_drops_it():
    """확정을 기다리는 중의 끼어드는 용건은 확정을 버리고(서버), 용건은 백엔드가 보고한다(switch_task)."""
    call = play(new_db(), NEW_ONE[:-1])
    run(apply_answer(call, "none", "lookup"))
    assert call.flow.pending is None and call.flow.stage == "A_CONFIRM"
    report(call, say("none", "C_FIND_RECENT", intent="lookup"))
    assert not call.parcels


# --- 주소록(핀) ---

def test_3_1_lists_candidates_then_verifies():
    call = play(floors_db(), steps("3-1")[:3])
    assert "301호·502호·701호 중 어디로" in engine.next_text(call)
    assert set(stage_choices(call)) == {"pin_1", "pin_2", "pin_3", "other", "none"}
    report(call, say("pin_2", "ORDER"))
    assert engine.next_text(call) == "'받으시는 분은 이영희 님 맞으신가요?'"
    report(call, say("yes", "ORDER"))
    assert call.order.receiver_address_detail == "502호" and said(call, "A3")


def test_3_2_name_only_asks_address_then_carries_both():
    call = play(saved_db(), steps("3-2")[:3])
    assert engine.next_text(call) == f"'{TEXTS.say['A2_3']}'"  # 이름만 말했고 핀이 없으면 주소를 묻는다
    report(call, steps("3-2")[3])
    assert call.order.receiver_name == "최지우" and call.order.receiver_address == "대구 중구 동성로 1"
    assert engine.next_text(call) == f"'{TEXTS.say['A2_2']}'"  # 앞서 받은 이름·주소는 다시 묻지 않는다


def test_address_only_without_pin_asks_name_and_partial_place_is_not_taken_as_address():
    call = play(saved_db(), [say("yes", "ORDER"), say("no", "ORDER"), tool("match_pins", {"place": "제주"}, "ORDER")])
    assert engine.next_text(call) == f"'{TEXTS.say['A2_1']}'"
    report(call, tool("match_pins", {"name": "최지우"}, "ORDER"))
    # 번지·건물번호 없는 지역 이름은 주소로 가져가지 않는다(주소DB가 엉뚱한 주소를 고르지 않게)
    assert call.order.receiver_name == "최지우" and call.order.receiver_address is None
    assert engine.next_text(call) == f"'{TEXTS.say['A2_2']}'"


def test_receiver_address_known_asks_only_name_not_where():
    """받는 곳 주소를 이미 받았으면 "어디로 보내실 건가요?"를 다시 묻지 않고 성함만(2026-11-01 21:47 통화)."""
    call = play(saved_db(), [say("yes", "ORDER"), say("no", "ORDER"),
                             tool("record_order", {"receiver_address": DEST3.address, "receiver_address_detail": ""},
                                  "ORDER")])
    assert engine.next_text(call) == f"'{TEXTS.say['A2_1']}'"


def test_place_said_at_recent_destination_question_is_matched_directly():
    call = play(saved_db(), [say("yes", "ORDER"), tool("match_pins", {"name": "이영희", "place": "마포"}, "ORDER")])
    assert call.pin_offer == DEST2 and call.dest_offer is None and said(call, "B9")


def test_destination_verify_no_registers_new_receiver():
    """B11(2026-10-31 결정): 하나 남은 핀이 아니라고 하면 그 핀은 버리고 새 받는 분으로. 핀의 값은 가져가지 않는다."""
    call = play(saved_db(), [say("yes", "ORDER"), say("no", "ORDER"),
                             tool("match_pins", {"name": "이영희", "place": "해운대"}, "ORDER"), say("no", "ORDER")])
    text = engine.next_text(call)
    assert text.startswith("'이영희님으로 저장된 다른 배송지가 없으니 새로 접수하겠습니다.'")
    assert call.order.receiver_name == "이영희" and call.order.receiver_phone is None  # 고객이 말한 이름만
    assert TEXTS.say["A2_2"] in text and DEST in call.pin_rejected["destination"]


def test_verify_no_among_candidates_asks_remaining():
    call = play(floors_db(), steps("3-1")[:4] + [say("no", "ORDER")])
    assert "301호·701호 중 어디로" in engine.next_text(call)  # 고른 층이 아니면 남은 후보로 다시


def test_pins_are_only_callers():
    db = saved_db()
    db.add_customer("01099999999", "남", [Place(name="남", phone="0212345678", address="남의 집", address_detail="")])
    call = make_call(db)
    assert DEST in call.places["destination"] and all(p.name != "남" for p in call.places["destination"])


def test_recent_pins_first():
    """주소록 앞쪽(최근) N개에서 먼저 찾는다. 거기 있으면 오래된 같은 이름 핀은 후보로 늘어놓지 않는다."""
    olds = [DEST3.model_copy(update={"address_detail": f"{i}호"}) for i in range(CFG.flow.pin_recent_count)]
    to_dest = [say("yes", "ORDER"), say("no", "ORDER")]
    call = play(saved_db(pins=(DEST, *olds, DEST2)), to_dest + [tool("match_pins", {"name": "이영희"}, "ORDER")])
    assert call.pin_offer == DEST
    call = play(saved_db(pins=(*olds, DEST, DEST2), recent=(ORIGIN, DEST3)),
                to_dest + [tool("match_pins", {"name": "이영희"}, "ORDER")])
    assert call.pin_candidates == [DEST, DEST2]  # 최근 N개에 없으면 전체에서


TO_DEST = [say("yes", "ORDER"), say("no", "ORDER")]  # 기존 출발지 예 → 최근 도착지 아니요(받는 곳을 묻는 중)


def test_partial_address_by_record_offers_similar_pin_first():
    """받는 분이 정해지기 전에 주소를 일부만 말해 값 기록(record_order)으로 들어와도 주소록에서 비슷한 곳을 찾아
    확인한다(B9). 받아쓰기 철자("센툼")·일반 낱말("아파트")은 넘어간다. 확인 전에는 받는 곳을 기록하지 않는다."""
    call = play(saved_db(), TO_DEST + [tool("record_order", {"receiver_address": "해운대 센툼 아파트"}, "ORDER")])
    assert call.pin_offer == DEST and call.order.receiver_address is None and said(call, "B9")
    report(call, say("yes", "ORDER"))
    assert call.order.place("receiver") == DEST and call.pin_offer is None


def test_partial_address_with_spoken_number_matches_pin_number():
    """한글로 말한 번지도 숫자로 비교한다. 말한 숫자가 핀과 다르면 다른 곳이라 권하지 않고 그대로 기록한다."""
    call = play(saved_db(), TO_DEST + [tool("record_order", {"receiver_address": "센텀로 십"}, "ORDER")])
    assert call.pin_offer == DEST
    call = play(saved_db(), TO_DEST + [tool("record_order", {"receiver_address": "부산 센텀로 20"}, "ORDER")])
    assert call.pin_offer is None and call.order.receiver_address == "부산 센텀로 20"


def test_region_only_matches_but_new_road_in_same_region_does_not():
    """시·구만 말하면 그 지역의 핀을 확인하고, 도로까지 말했는데 그 도로의 핀이 없으면 같은 구라도 권하지 않는다."""
    call = play(saved_db(), TO_DEST + [tool("match_pins", {"place": "서울 마포구"}, "ORDER")])
    assert call.pin_offer == DEST2
    call = play(saved_db(), TO_DEST + [tool("record_order", {"receiver_address": "서울 마포구 성미산로 3"}, "ORDER")])
    assert call.pin_offer is None and call.order.receiver_address == "서울 마포구 성미산로 3"


def test_none_of_candidates_then_same_address_is_recorded_not_offered_again():
    """여러 후보에 "이 중에 없다"고 하면 그 후보들은 버린다: 같은 주소를 다시 기록해도 또 묻지 않고 기록한다."""
    call = play(floors_db(), TO_DEST + [tool("record_order", {"receiver_address": "센텀로 10"}, "ORDER")])
    assert len(call.pin_candidates) == 3 and said(call, "B8", 후보="301호·502호·701호")
    report(call, say("other", "ORDER"))
    report(call, tool("record_order", {"receiver_address": "센텀로 10"}, "ORDER"))
    assert call.pin_candidates == [] and call.order.receiver_address == "센텀로 10"


def test_address_with_name_already_recorded_is_not_matched_to_pins():
    """받는 분 성함을 이미 직접 기록했으면(주소록 확인 질문 자리가 지났음) 주소는 그대로 기록한다."""
    call = play(saved_db(), TO_DEST + [tool("record_order", {"receiver_name": "한승준"}, "ORDER"),
                                       tool("record_order", {"receiver_address": "해운대 센텀로"}, "ORDER")])
    assert call.pin_offer is None and call.order.receiver_address == "해운대 센텀로"


def test_match_pins_strips_particles_but_not_names():
    other = DEST.model_copy(update={"name": "이영수"})
    call = play(saved_db(pins=(ORIGIN, DEST, other)), [say("yes", "ORDER"), say("no", "ORDER")])
    out = report(call, tool("match_pins", {"name": "이영희님", "place": "해운대로"}, "ORDER"))
    assert out["ok"] and call.pin_offer == DEST  # "이영희님"은 "이영희"로 보되 "이영"까지 줄여 이영수를 찾지 않는다
    assert run(dispatch(call, "match_pins", "{}", "x"))["ok"] is False  # 찾을 말이 없으면 오류


def test_saved_values_are_hidden_until_customer_says_them():
    call = play(saved_db(), SAVED_TO_ITEM)
    shown = dict(call.recorded())
    assert shown["받는 분 번호"] == TEXTS.saved_value and shown["받는 분"] == DEST.name
    assert shown["보내는 분 번호"] == TEXTS.saved_value  # 기존 출발지의 번호도 읽지 않는다
    report(call, tool("record_order", {"receiver_phone": "01011112222"}, "ORDER"))
    assert dict(call.recorded())["받는 분 번호"] == "01011112222"


# --- 조회·취소 ---

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
    assert said(call, "C9")
    assert [op["status"] for op in call.running_ops.values()] == ["done"]


def test_8_already_picked_up_counts_a_failure():
    call = play(picked_db(), steps("8"))
    assert call.fail_count == 1 and said(call, "C7_LOCKED")


def test_lookup_intent_while_looking_up_is_ignored():
    call = play(orders_db(), FIND)
    run(apply_answer(call, "none", "lookup"))
    assert call.flow.stage == "C_CHOICE"  # 같은 업무를 처음부터 다시 하지 않는다


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
    assert said(call, "C9_FAIL") and call.fail_count == 1
    report(call, say("yes", "HUB"))  # 한 번 더: 먼저 조회해 보니 이미 취소됨
    assert FlakyCancel.calls == 1 and said(call, "C9")
    ops = list(call.running_ops.values())
    assert [op["status"] for op in ops] == ["unknown", "done"] and ops[1]["checked"]
    assert len(call.running_ops) == 2 and all(":cancel:" in op_id for op_id in call.running_ops)


def test_lookup_none_for_name_asks_again_and_failure_offers_retry():
    db = orders_db()
    call = play(db, [say("none", "C_FIND_RECENT", intent="lookup"),
                     tool("lookup_orders", {"receiver_name": "최지우"}, "C_FIND_RECENT")])
    assert "최지우님께 보내신 택배를 찾지 못했어요" in engine.next_text(call)
    report(call, say("unclear", "C_FIND_RECENT"))
    assert said(call, "C1_RETRY")

    async def down(call_session_seq, limit):
        raise RuntimeError("백엔드 없음")

    db.find_parcels = down
    report(call, tool("lookup_orders", {"receiver_name": "이영희"}, "C_FIND_RECENT"))
    assert said(call, "C3_FAIL") and set(stage_choices(call)) == {"yes", "no", "none"}
    assert call.fail_count == 1
    report(call, say("yes", "C_FIND_RECENT"))
    report(call, say("yes", "C_FIND_RECENT"))
    report(call, say("yes", "HUB"))  # 다시 조회 상한(2회)을 넘으면 HUB


def test_lookup_without_any_order_returns_to_hub():
    call = play(saved_db(), [say("none", "C_FIND_RECENT", intent="lookup"), say("forgot", "HUB")])
    assert said(call, "C_NO_ORDERS")


def test_cancel_no_and_already_cancelled():
    call = play(orders_db(), FIND + [say("cancel", "C_CANCEL_CONFIRM"), say("no", "HUB")])
    assert said(call, "C10") and said(call, "RESUME_HUB")
    call = play(orders_db("CANCELLED"), FIND + [say("cancel", "HUB")])
    assert said(call, "C7_CANCELLED")


def test_cancel_runs_only_after_confirmed_yes_and_commit():
    db = orders_db()
    call = play(db, FIND + [say("cancel", "C_CANCEL_CONFIRM"), say("yes", "C_CANCEL_CONFIRM")])
    assert parcel_status(db, 1) == "ACTIVE" and not call.running_ops  # 확정 지연 중: 아직 실행하지 않음
    target = {k: call.target_order[k] for k in ("order_seq", "order_parcel_seq")}
    out = run(dispatch(call, "cancel_order", json.dumps({**target, "customer_confirmed": True,
                                                         "operation_id": "x"}), "x"))
    assert out["ok"] is False and "쓸 수 없는" in out["error"]  # C_CANCEL 밖에서는 실행하지 않는다


def test_cancel_yes_with_question_is_held():
    call = play(orders_db(), FIND + [say("cancel", "C_CANCEL_CONFIRM")])
    run(apply_answer(call, "yes", "question"))  # "네, 근데 환불은요?": 취소를 확정하지 않는다(질문은 음성 모델이 응대)
    assert call.flow.pending is None and call.flow.stage == "C_CANCEL_CONFIRM"


def test_resume_into_check_record_does_not_reset_failures():
    call = play(orders_db(), [say("none", "C_FIND_RECENT", intent="lookup"), say("forgot", "C_CHECK_RECORD")]
                + ask("1", False))
    assert call.fail_count == 1
    report(call, say("other_task", "C_CHECK_RECORD"))
    assert call.fail_count == 1


# --- QnA·상담원 ---

def test_10_offer_only_on_third_failure():
    call = play(saved_db(), ask("1", False), OPEN)
    assert engine.next_text(call) == f"'{TEXTS.say['D5']}'" and not call.agent_offered
    for step in ask("2", False):
        report(call, step)
    assert engine.next_text(call) == f"'{TEXTS.say['D5']}'"
    for step in ask("3", False) + [say("yes", "AGENT_HANDOFF")]:
        report(call, step)
    assert call.refer_requested.is_set() and said(call, "D9")


def test_11_yes_before_offer_is_not_a_choice():
    call = play(saved_db(), ask("1", False), OPEN)
    assert "yes" not in stage_choices(call)
    run(apply_answer(call, "yes", "none"))
    assert call.flow.stage == "D_AGENT_OFFER" and not call.refer_requested.is_set()


def test_12_no_agent_then_other_task_resumes():
    call = play(saved_db(), ask("1", False) + ask("2", False) + ask("3", False) + [say("yes", "D_AFTER_NO_AGENT")],
                CLOSED)
    assert said(call, "D11")
    report(call, say("other_task", "ORDER"))
    assert said(call, "ORIGIN_ASK")  # 하던 질문(기존 출발지 제안)을 다시


def test_resume_to_hub_asks_resume_hub():
    call = play(saved_db(), [say("other", "HUB")] + ask("1", False) + [say("other_task", "HUB")])
    assert engine.next_text(call) == f"'{TEXTS.say['RESUME_HUB']}'"  # §9 복귀 대상이 HUB


def test_13_restricted_texts_and_consecutive_failures_across_kinds():
    call = play(saved_db(), [])
    texts = []
    for _ in range(3):
        report(call, say("none", "D_AGENT_OFFER", intent="restricted"))
        texts.append(engine.next_text(call))
        report(call, say("other_task", "ORDER"))
    assert texts == [f"'{TEXTS.say['D6']}'"] * 2 + [f"'{TEXTS.say['D6_3']}'"]
    # 업무 예외 1번 + RAG 실패 2번 = 3번째에 상담원 제안(연속 합산)
    call = play(picked_db(), FIND + [say("cancel", "HUB")] + ask("1", False))
    assert engine.next_text(call) == f"'{TEXTS.say['D5']}'" and call.fail_count == 2
    for step in ask("2", False):
        report(call, step)
    assert engine.next_text(call) == f"'{TEXTS.say['D5_3']}'" and call.agent_offered


# --- 끼어들기(판별 결과 단위) ---

def test_unheard_yes_is_reasked_once_per_question_but_no_is_taken():
    """확인 질문의 핵심 구간을 듣기 전의 "예"는 한 번 다시 묻고, 거절은 받는다(§2.5(1))."""
    call = play(orders_db(), FIND + [say("cancel", "C_CANCEL_CONFIRM")])
    call.flow.entered_ms = 1000
    call.agent_deltas = [("이 택배 접수를 ", 1000, 1400), ("취소해 드릴까요?", 1400, 4000)]
    run(apply_answer(call, "yes", "none", start_ms=1500))
    assert call.flow.pending is None and call.reask and call.flow.reasked
    run(dispatch(call, "answer", json.dumps({"choice": "yes"}), "a1"))  # 두 열쇠의 Live-1 쪽
    run(apply_answer(call, "yes", "none", start_ms=1500))  # 한 번 다시 물은 뒤에는 받는다(되풀이 방지)
    assert call.flow.pending
    call = play(orders_db(), FIND + [say("cancel", "C_CANCEL_CONFIRM")])
    call.flow.entered_ms, call.agent_deltas = 1000, [("이 택배 접수를 ", 1000, 1400), ("취소해", 1400, 4000)]
    run(apply_answer(call, "no", "none", start_ms=1500))  # 거절은 되돌릴 수 있어 받는다(시나리오 16)
    assert call.flow.stage == "HUB"


def test_heard_after_core_or_after_agent_finished():
    call = play(orders_db(), FIND + [say("cancel", "C_CANCEL_CONFIRM")])
    call.flow.entered_ms = 1000
    call.agent_deltas = [("이 택배 접수를 취소해 드릴까요?", 1000, 3000)]
    from app.listener import prompt_heard
    assert prompt_heard(call, 3100)  # 핵심 구간을 들었다
    call.agent_deltas = [("이걸 정말 없던 걸로 할까요?", 1000, 3000)]
    assert prompt_heard(call, 3500)  # 바꿔 말했어도 말을 마친 뒤의 답은 받는다
    assert not prompt_heard(call, 2000)  # 말하는 중에 끼어듦
    assert prompt_heard(call, None)  # 시각을 모르면 따지지 않는다


def test_end_task_goes_to_end_call_and_nothing_moves_after():
    call = play(new_db(), NEW_TO_PICKUP[:2] + [say("none", "END_CALL", intent="end")])
    assert call.hangup_requested.is_set()
    out = run(dispatch(call, "switch_task", json.dumps({"task": "lookup"}), "x"))  # 마무리 인사 중에는 업무를 바꾸지 않는다
    assert not out["ok"] and call.flow.stage == "END_CALL"


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


# --- 정의 ---

def test_stages_are_tasks_and_gates():
    nodes = """CALLER_ID IS_REGISTERED HUB END_CALL ORDER A_CONFIRM A_PAYMENT A_DONE A_CHOICE
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
    assert {("ORDER", "GLOBAL_INTENT"), ("RESUME_TASK", "ORDER"), ("HUB", "END_CALL"), ("ORDER", "C_REQUIRED_INFO")} \
        <= edges


def test_record_order_is_allowed_wherever_an_order_can_be_taken():
    for name in ("HUB", "ORDER", "A_CONFIRM", "A_CHOICE", "D_AFTER_ANSWER", "D_AGENT_OFFER", "D_AFTER_NO_AGENT"):
        assert "record_order" in engine.STAGES[name].tools, name
    gates = {s.name for s in engine.STAGES.values() if any(t.commit for t in s.transitions)}
    assert gates == {"A_CONFIRM", "A_PAYMENT", "C_CANCEL_CONFIRM"}


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


def test_pickup_time_is_shown_relative_to_call_received_day():
    """수거 일시는 전화 받은 날(한국 시간) 기준 "내일 오후 8시"·"26일 오전 9시"처럼 보여 준다(연·월을 말하지 않게)."""
    from datetime import datetime
    from app.call import KST, spoken_time
    base = datetime(2026, 10, 31, 18, 5, tzinfo=KST)
    assert spoken_time(datetime(2026, 10, 31, 20, 0, tzinfo=KST), base) == "오늘 오후 8시"
    assert spoken_time(datetime(2026, 11, 1, 8, 30, tzinfo=KST), base) == "내일 오전 8시 30분"
    assert spoken_time(datetime(2026, 11, 2, 12, 0, tzinfo=KST), base) == "모레 오후 12시"
    assert spoken_time(datetime(2026, 11, 26, 21, 0, tzinfo=KST), base) == "11월 26일 오후 9시"
    call = make_call()  # 수신 시각 2026-10-28T01:00:00Z = 한국 10시
    assert call.text_vars()["received"] == "2026-10-28 10:00 (수요일)"
    assert "2026-10-28 10:00" in TEXTS.backend_info.format(**call.text_vars())


def test_question_at_more_question_resumes_more_question_not_hub():
    """추가 접수 질문에 "하나만 더 여쭤볼게요": 질문 답변 뒤 추가 접수 질문으로 돌아온다(새 택배를 시작하지 않음)."""
    call = play(new_db(), NEW_ONE + ask("제주 운임") + [say("other_task", "A_CHOICE")])
    assert said(call, "A8") and len(call.parcels) == 1 and call.order.receiver_name is None


def test_name_by_pin_search_then_address_by_record_asks_next_field():
    """주소록 찾기로 이름만 듣고(없음) 주소는 값 기록으로 들어와도 이름을 옮기고 다음 항목을 묻는다
    (2026-11-01 마지막 통화: "받으시는 분 주소를 말씀해 주세요"만 되풀이)."""
    call = play(saved_db(), [say("yes", "ORDER"), say("no", "ORDER"), tool("match_pins", {"name": "한승준"}, "ORDER")])
    assert said(call, "A2_3")
    report(call, tool("record_order", {"receiver_address": DEST3.address, "receiver_address_detail": ""}, "ORDER"))
    assert call.order.receiver_name == "한승준" and call.pin_ask is None and said(call, "A2_2")


def test_place_by_pin_search_then_name_by_record_asks_next_field():
    call = play(saved_db(), [say("yes", "ORDER"), say("no", "ORDER"),
                             tool("match_pins", {"place": "대구 중구 동성로 1"}, "ORDER")])
    assert said(call, "A2_1")
    report(call, tool("record_order", {"receiver_name": "한승준"}, "ORDER"))
    assert call.order.receiver_address == "대구 중구 동성로 1" and call.pin_ask is None and said(call, "A2_2")


@pytest.mark.parametrize("sender_first", [False, True])
@pytest.mark.parametrize("db", [new_db, saved_db, floors_db])
def test_question_never_asks_a_filled_item_whatever_order_values_come_in(db, sender_first):
    """값이 어떤 순서·경로로 들어와도 질문은 빠진 항목만(한 항목씩 거꾸로·섞어 기록하며 매번 확인)."""
    fields = [("pickup_at", WHEN), ("item", ITEM), ("receiver_address", {"receiver_address": DEST3.address,
                                                                       "receiver_address_detail": ""}),
              ("receiver_name", {"receiver_name": "한승준"}), ("receiver_phone", {"receiver_phone": "010-5555-6666"}),
              ("sender_name", {"sender_name": "김철수"}),
              ("sender_address", {"sender_address": ORIGIN.address, "sender_address_detail": "1201호"})]
    if sender_first:  # 보내는 분부터 받고 받는 분은 주소 → 이름 순(받는 곳 질문이 지금 질문이 되게)
        fields = fields[-2:] + fields[:-2]
    call = make_call(db())
    if call.flow.stage == "HUB":
        report(call, say("order", "ORDER"))
    for name, args in fields:
        if name == "receiver_address" and call.pin_scope("destination"):
            report(call, tool("match_pins", {"name": "한승준"}, "ORDER"))  # 주소록 찾기로 이름만 → 주소는 값 기록으로
            check_question(call)
        report(call, tool("record_order", args, call.flow.stage))
        if call.flow.stage == "ORDER":
            check_question(call)
    assert call.flow.stage == "A_CONFIRM"


# --- 음성 모델이 알아들은 답·업무 바꾸기(answer·switch_task 도구) ---

def test_answer_tool_only_takes_current_choices():
    call = play(saved_db(), [])
    state = engine.summary(call)
    assert state["choices"].keys() == {"yes", "no", "other"} and "answer" in state["tools"]
    out = run(dispatch(call, "answer", json.dumps({"choice": "pin_1"}), "x1"))  # 지금 질문의 선택지가 아님
    assert not out["ok"] and call.origin_offer


AT_CONFIRM = NEW_TO_PICKUP + [tool("record_order", WHEN, "A_CONFIRM")]


def test_confirm_takes_yes_only_when_live1_and_server_both_heard_it():
    """두 열쇠(docs/flow-two-key-plan.md): 되돌릴 수 없는 확인은 Live-1 보고와 서버 판별이 둘 다 "예"일 때만."""
    call = play(new_db(), AT_CONFIRM)
    assert "answer" in engine.allowed_tools(call) and engine.summary(call)["choices"].keys() == {"yes", "no"}
    out = run(dispatch(call, "answer", json.dumps({"choice": "yes"}), "x1"))  # Live-1 보고만
    assert out["ok"] and call.flow.pending is None and out["state"]["next"] == TEXTS.note["CONSENT_WAIT"]
    run(apply_answer(call, "yes"))  # 같은 말의 서버 판별
    assert call.flow.pending and call.consent is None
    # 서버 판별만(Live-1이 다른 질문을 하고 고객이 그 질문에 "네"): 실행하지 않는다
    call = play(new_db(), AT_CONFIRM)
    run(apply_answer(call, "yes"))
    assert call.flow.pending is None and call.consent["source"] == "server"
    assert engine.next_text(call) != TEXTS.note["CONSENT_WAIT"]  # Live-1은 자기 대화를 이어 간다
    # 실제 통화에서 흔한 순서: 서버 판별(말 멈춤 뒤 약 0.9초)이 먼저, Live-1 보고(위임 → 백엔드)가 나중
    out = run(dispatch(call, "answer", json.dumps({"choice": "yes"}), "x0"))
    assert out["ok"] and call.flow.pending and TEXTS.note["COMMIT_WAIT"] in out["state"]["next"]
    # 서버가 다른 용건이 섞인 말로 들음: 실행하지 않고 Live-1 보고도 버린다(정정은 Live-1이 응대, 확인은 다시 받는다)
    call = play(new_db(), AT_CONFIRM)
    run(dispatch(call, "answer", json.dumps({"choice": "yes"}), "x2"))
    run(apply_answer(call, "none", "correction"))  # 서버는 "네, 근데 받는 분이…"로 들음
    assert call.flow.pending is None and call.consent is None


def test_confirm_refusal_is_taken_from_server_alone():
    call = play(new_db(), AT_CONFIRM)
    out = run(dispatch(call, "answer", json.dumps({"choice": "no"}), "x1"))  # 거절 보고는 서버 판별에 맡긴다
    assert out["ok"] and not out.get("events") and said(call, "A_CONFIRM")
    run(apply_answer(call, "no"))
    assert said(call, "A_CONFIRM_FIX")


def test_switch_task_from_middle_of_order_and_back():
    call = play(new_db(), NEW_TO_PICKUP[:2] + [say("none", "C_FIND_RECENT", intent="lookup")])
    out = run(dispatch(call, "switch_task", json.dumps({"task": "lookup"}), "x1"))
    assert out["ok"] and out["already"] and call.flow.stage == "C_FIND_RECENT"  # 같은 업무는 처음부터 다시 하지 않는다
    report(call, say("none", "ORDER", intent="order"))
    assert call.order.sender_name == SENDER["sender_name"]  # 받던 택배는 그대로 이어서
