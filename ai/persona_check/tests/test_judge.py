"""판정기: 실제 시험 통화(11/11 23:28, 신규 고객 접수)에서 가짜 백엔드가 받은 것으로 판정을 확인한다. 모델은 부르지 않는다."""

import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from persona_check import judge

RECORD = json.loads((Path(__file__).parent / "fixtures" / "n01_backend.json").read_text("utf-8"))
# 그 통화의 시나리오(지금 scenarios.toml과 무관하게 고정)
NEW = {"id": "N01", "name": "신규 고객 접수", "customer": None,
       "lines": [{"text": "택배 접수하려고요."}, {"text": "김민수입니다."}, {"text": "네, 지금 거는 번호로 해 주세요.", "optional": True},
                 {"text": "받는 사람은 이지은이요."}, {"text": "010-2345-6789요."}, {"text": "서울시 강남구 테헤란로 212, 멀티캠퍼스 1층이요."},
                 {"text": "부산광역시 해운대구 센텀중앙로 79, 102동 1503호요."}, {"text": "옷이랑 책이요."}, {"text": "5만 원 정도요."},
                 {"text": "네, 맞아요.", "optional": True}, {"text": "네, 접수해 주세요.", "optional": True}],
       "expect": {"outcome": "registered", "parcel": {
           "sender_name": "김민수", "sender_address": "서울시 강남구 테헤란로 212", "sender_detail": "멀티캠퍼스 1층",
           "receiver_name": "이지은", "receiver_phone": "010-2345-6789", "receiver_address": "부산광역시 해운대구 센텀중앙로 79",
           "receiver_detail": "102동 1503호", "box": "medium", "item_price": 50000}}}
ORDERS = [{"receiver": "이지은", "address": "부산", "status": "COLLECTING"}, {"receiver": "박서준", "address": "대전", "status": "PAID"}]


def statuses(verdict):
    return {c["name"]: c["status"] for c in verdict["checks"]}


def received_orders(**status):
    return [{"status": s, "parcels": [{"destination": {"name": name}}]} for name, s in status.items()]


def test_registered_call_passes_and_stub_environment_compares_only_the_district():
    verdict = judge.judge(NEW, RECORD)
    got = statuses(verdict)
    assert verdict["passed"] and verdict["summary"] == "통과 11 · 실패 0 · 제외 2"
    assert got["보내는 분 번호"] == got["받는 분 번호"] == got["물품"] == got["물품 가액"] == got["대본 진행"] == "pass"
    assert got["보내는 곳 지역"] == got["받는 곳 지역"] == "pass"            # 강남구 · 해운대구
    assert got["보내는 곳 상세주소"] == got["받는 곳 상세주소"] == "skip"    # 주소DB가 없으면 상세가 갈리지 않는다
    assert "보내는 곳 주소" not in got


def test_wrong_value_and_missing_registration_fail():
    record = copy.deepcopy(RECORD)
    draft = next(iter(record["received"]["drafts"].values()))
    draft["parcel"]["destination"]["phoneNumber"] = "01023456788"   # 한 자리 틀림
    draft["parcel"]["mediumBoxCount"], draft["parcel"]["smallBoxCount"] = 0, 1  # 다른 크기로 들어감
    draft["status"] = "EDITING"                                     # 접수 확인까지 못 감
    next(iter(record["received"]["analyses"].values()))["registeredParcelCount"] = 0
    verdict = judge.judge(NEW, record)
    assert not verdict["passed"]
    assert [k for k, v in statuses(verdict).items() if v == "fail"] == ["접수된 택배 수", "접수 확인된 초안 수", "받는 분 번호", "물품"]
    assert statuses(verdict)["받는 분 이름"] == "pass"   # 접수가 안 됐어도 마지막 초안의 값은 본다


def test_address_is_judged_in_full_when_environment_has_real_address_data():
    record = copy.deepcopy(RECORD) | {"address": "real"}
    assert statuses(judge.judge(NEW, record))["받는 곳 상세주소"] == "fail"   # 이 통화는 상세주소가 "원 헌드레드 투 동…"으로 들어갔다
    origin = next(iter(record["received"]["drafts"].values()))["parcel"]["origin"]
    origin["roadAddress"], origin["detailAddress"] = "서울시 강남구 테헤란로 212", "멀티캠퍼스 1층"
    got = statuses(judge.judge(NEW, record))
    assert got["보내는 곳 주소"] == got["보내는 곳 상세주소"] == "pass"


def test_registered_customer_sender_defaults_to_the_registered_address():
    # 11/11 · 11/12 통화: 보내는 곳이 받는 곳 주소로 덮였는데, 정답에 발송 주소를 안 적었거나 주소 칸을 다 빼서 통과시켰다
    registered = NEW | {"customer": {"name": "김민수", "address": "서울 강남구 테헤란로 212", "detail": "멀티캠퍼스 1층"},
                        "expect": {"outcome": "registered", "parcel": {"receiver_name": "이지은"}}}
    assert judge.judge(registered, RECORD)["passed"]
    record = copy.deepcopy(RECORD)
    parcel = next(iter(record["received"]["drafts"].values()))["parcel"]
    parcel["origin"]["roadAddress"] = parcel["destination"]["roadAddress"]
    verdict = judge.judge(registered, record)
    assert not verdict["passed"] and statuses(verdict)["보내는 곳 지역"] == "fail"


def test_call_that_stopped_midway_fails_even_if_the_expected_outcome_holds():
    # 11/12 중도 취소 통화: 72초에 멈춰 '그만둘게요'를 말하지도 못했는데 '접수 없음'이라 통과시켰다
    quit_call = {"id": "H9", "expect": {"outcome": "none"},
                 "lines": [{"text": "받는 사람은 박서진이에요."}, {"text": "010-7777-8888이요."}, {"text": "그냥 안 할게요."},
                           {"text": "네.", "optional": True}]}
    verdict = judge.judge(quit_call, {"received": {}, "said": [1]})
    assert not verdict["passed"] and "[2, 3]" in verdict["checks"][0]["actual"]
    assert judge.judge(quit_call, {"received": {}, "said": [1, 2, 3]})["passed"]              # 4번(예 · 아니오 답)은 없어도 된다
    assert statuses(judge.judge(quit_call, {"received": {}}))["대본 진행"] == "skip"           # 진행 기록이 없는 옛 기록
    assert not judge.judge(quit_call, RECORD | {"said": [1, 2, 3]})["passed"]                 # 접수가 생겼으면 실패
    with pytest.raises(ValueError):
        judge.judge({"id": "X", "expect": {"outcome": "nope"}}, RECORD)


def test_lookup_and_cancel_outcomes_watch_the_seeded_orders():
    lookup = {"id": "E1", "expect": {"outcome": "lookup"}, "orders": ORDERS}
    untouched = received_orders(이지은="COLLECTING", 박서준="PAID")
    found = {"received": {"analyses": {"1": {"orderLookupCount": 1}}, "orders": untouched}}
    assert judge.judge(lookup, found)["passed"]
    assert statuses(judge.judge(lookup, {"received": {"orders": untouched}}))["조회 실행"] == "fail"
    cancel = {"id": "F1", "expect": {"outcome": "cancelled", "receiver": "이지은"}, "orders": ORDERS}
    assert judge.judge(cancel, {"received": {"orders": received_orders(이지은="CANCELLED", 박서준="PAID")}})["passed"]
    assert statuses(judge.judge(cancel, {"received": {"orders": untouched}}))["기존 주문 상태"] == "fail"               # 취소 안 됨
    wrong = {"received": {"orders": received_orders(이지은="COLLECTING", 박서준="CANCELLED")}}
    assert not judge.judge(cancel, wrong)["passed"] and not judge.judge(lookup, wrong)["passed"]                          # 엉뚱한 주문을 취소


def test_faq_answers_are_counted_from_the_call_analysis():
    faq = NEW | {"expect": NEW["expect"] | {"faq_answers": 1}}
    assert statuses(judge.judge(faq, RECORD))["FAQ 답변"] == "fail"               # 그 통화에는 FAQ 답변이 없었다
    record = copy.deepcopy(RECORD)
    next(iter(record["received"]["analyses"].values()))["faqAnswerCount"] = 2
    assert statuses(judge.judge(faq, record))["FAQ 답변"] == "pass" and "FAQ 답변" not in statuses(judge.judge(NEW, record))


def events(*rows):
    out = {}
    for order, row in enumerate(rows, 1):
        kind, payload = ("UTTERANCE", {"speaker": row[0], "utteranceText": row[1]}) if row[0] in ("AI", "CUSTOMER") \
            else ("AI_ACTION", {"action": row[0], "summaryText": row[1]})
        out[str(order)] = {"eventOrder": order, "kind": kind, "payload": payload}
    return {"received": {"events": {"1": out}}}


TALK = events(("CUSTOMER_LOOKUP", "미등록"), ("AI", "안녕하세요."), ("AI", " 디바콜입니다."), ("CUSTOMER", "택배 접수하려고요"),
              ("AI", "받는 분 연락처는 공일공, 일이삼사오, 육칠팔구로 기록했습니다."), ("FIELD_SAVED", "receiver_phone"))
ITEMS = ["첫 인사가 정해진 문구다", "받는 분 번호를 그대로 읽는다", "접수 전에 접수됐다고 하지 않는다"]


def test_dialogue_joins_fragments_and_keeps_server_actions():
    assert judge.dialogue(TALK) == [("서버", "CUSTOMER_LOOKUP: 미등록"), ("AI", "안녕하세요. 디바콜입니다."), ("고객", "택배 접수하려고요"),
                                    ("AI", "받는 분 연락처는 공일공, 일이삼사오, 육칠팔구로 기록했습니다."), ("서버", "FIELD_SAVED: receiver_phone")]
    assert judge.dialogue({"received": {}}) == []
    assert judge.dialogue({"received": {}, "customer": {"lines": [[1.0, "AI", "안녕하세요."]]}}) == [("AI", "안녕하세요.")]


def answer(*verdicts):
    return {"items": [{"no": no, "verdict": v, "quote": q, "why": "사유"} for no, (v, q) in enumerate(verdicts, 1)]}


def test_broken_needs_a_verbatim_ai_quote_and_missing_answers_are_left_out():
    talk = judge.dialogue(TALK)
    got = judge.check_behaviour(answer(("kept", ""), ("broken", "공일공, 일이삼사오,  육칠팔구로 기록했습니다"), ("unclear", "")), ITEMS, talk)
    assert [c["status"] for c in got] == ["pass", "fail", "skip"] and got[1]["actual"].startswith("어김: 공일공")
    invented = judge.check_behaviour(answer(("broken", "접수됐습니다"), ("broken", "택배 접수하려고요"), ("broken", "네")), ITEMS, talk)
    assert [c["status"] for c in invented] == ["skip", "skip", "skip"]   # 통화에 없는 말 · 고객의 말 · 너무 짧은 인용
    assert [c["status"] for c in judge.check_behaviour({"items": [{"no": 2, "verdict": "kept", "quote": "", "why": ""}]}, ITEMS, talk)] \
        == ["skip", "pass", "skip"]
    assert [c["status"] for c in judge.check_behaviour("글자", ITEMS, talk)] == ["skip"] * 3


class FakeClient:
    def __init__(self, replies):
        self.replies, self.sent = list(replies), []
        self.responses = SimpleNamespace(create=self.create)

    async def create(self, **kwargs):
        self.sent.append(kwargs)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return SimpleNamespace(output_text=json.dumps(reply, ensure_ascii=False))


def test_behaviour_keeps_only_what_two_of_three_rounds_agree_on():
    scenario = NEW | {"checks": ITEMS}
    phone = "공일공, 일이삼사오, 육칠팔구로 기록했습니다"
    client = FakeClient([answer(("kept", ""), ("broken", phone), ("kept", "")),
                         answer(("kept", ""), ("broken", phone), ("broken", phone)),
                         RuntimeError("모델 장애")])
    got = asyncio.run(judge.behaviour(client, scenario, TALK))
    assert [c["status"] for c in got] == ["pass", "fail", "skip"] and got[2]["note"] == "판마다 판정이 갈림"
    assert len(client.sent) == judge.VOTES and "[확인 항목]\n1. 첫 인사가 정해진 문구다" in client.sent[0]["input"]
    assert asyncio.run(judge.behaviour(FakeClient([]), NEW, TALK)) == []          # 확인 항목이 없으면 모델을 부르지 않는다
    verdict = asyncio.run(judge.judge_call(FakeClient([answer(("kept", ""), ("broken", phone), ("kept", ""))] * 3), scenario,
                                           RECORD | TALK["received"] and {**RECORD, "received": RECORD["received"] | TALK["received"]}))
    assert not verdict["passed"] and verdict["summary"] == "통과 13 · 실패 1 · 제외 2"


def test_addresses_match_when_only_the_city_name_is_shortened():
    # 주소DB가 있는 서버는 시 · 도를 정식 이름으로 저장한다(11/12 서버 첫 시험: 기대 '서울시 …' · 실제 '서울특별시 …'로 실패)
    assert judge.same_address("서울시 강남구 테헤란로 212", "서울특별시 강남구 테헤란로 212")
    assert judge.same_address("부산 해운대구 센텀중앙로 79", "부산광역시 해운대구 센텀중앙로 79")
    assert judge.same_address("대전 유성구 대학로 99", "대전광역시 유성구 대학로 99")
    assert judge.same_address("강원도 춘천시 중앙로 1", "강원특별자치도 춘천시 중앙로 1")
    assert judge.same_address("충북 청주시 상당구 상당로 82", "충청북도 청주시 상당구 상당로 82")
    assert not judge.same_address("서울시 강남구 테헤란로 212", "부산광역시 강남구 테헤란로 212")   # 다른 시 · 도
    assert not judge.same_address("서울 강남구 테헤란로 212", "서울특별시 강남구 테헤란로 213")      # 다른 번지
    assert not judge.same_address("대전 유성구 대학로 99", None)
