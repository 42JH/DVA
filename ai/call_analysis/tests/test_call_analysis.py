"""통화 분석(call_analysis): 가짜 모델로 차례 나누기·검사·뽑기 규칙을 확인한다. 실제 OpenAI를 부르지 않는다."""

import asyncio
import json
import re

import openai
from types import SimpleNamespace

from call_analysis import analyze, extract, facts


def ev(kind, sec, **payload):
    return {"kind": kind, "occurredAt": f"2026-11-02T10:{sec // 60:02d}:{sec % 60:02d}+09:00",
            "offsetSeconds": sec, "payload": payload}


def say(sec, order, who, text):
    return ev("UTTERANCE", sec, utteranceOrder=order, speaker=who, utteranceText=text)


def act(sec, action, text):
    return ev("AI_ACTION", sec, action=action, summaryText=text)


def raw(t, issue="none", why="", quote="", **fields):
    """모델이 낸 차례 한 줄. quote = 근거 인용(대본에 있어야 문제가 남음)."""
    return {"t": t, "cust": [], "given": [], "ai": [], "asked": [], "issue": issue, "why": why,
            "quote": quote, "complain_quote": "", "complain_target": "none", "complain_level": "none",
            "unground_source": ""} | fields


def test_ungrounded_needs_contradicting_source():
    """근거 없는 답변: 반대 근거 구절(8자 이상)이 FAQ · 업무 규칙 · 대본에 글자 그대로 있어야 남는다(11/10, 참고 표시)."""
    rec = analyze.from_events([say(1, 1, "CUSTOMER", "몇 시까지 접수돼요?"), say(2, 2, "AGENT", "오후 여섯 시까지 접수돼요.")])
    src = analyze._sources(rec, [{"question": "접수 시간은?", "answer": "평일 오전 9시부터 오후 5시까지 접수됩니다."}])

    def keep(source, ai=("inform",)):
        r = raw(1, "UNGROUNDED_ANSWER", "FAQ와 다른 접수 시간", "오후 여섯 시까지", ai=list(ai), unground_source=source)
        return analyze.check({"turns": [r]}, rec, src)["turns"][0]["issue"]

    assert keep("오전 9시부터 오후 5시까지 접수됩니다") == "UNGROUNDED_ANSWER"
    assert keep("접수는 오후 5시까지만 가능합니다") is None  # 원문에 없는 구절
    assert keep("5시까지") is None  # 너무 짧음
    assert keep("오전 9시부터 오후 5시까지 접수됩니다", ai=()) is None  # 안내가 아닌 차례


def row(t, issue=None, why="", **fields):
    """검사를 거친 차례 한 줄(문제 없음은 None)."""
    return raw(t, issue, why, **fields)


CALL = [act(0, "CUSTOMER_LOOKUP", "등록 고객"),
        say(1, 1, "AGENT", "안녕하세요, 디바콜입니다."),
        say(5, 2, "CUSTOMER", "택배 접수할게요"),
        say(7, 3, "AGENT", "보내시는 분 성함을 말씀해 주세요."),
        say(10, 4, "CUSTOMER", "홍길동이요"),
        act(11, "FIELD_SAVED", "기록: 보내는 분"),
        say(12, 5, "AGENT", "보내시는 분 성함을 말씀해 주세요."),
        say(15, 6, "CUSTOMER", "방금 말했잖아요"),
        say(16, 7, "CUSTOMER", "  "),  # 빈 말풍선은 건너뛴다
        say(17, 8, "AGENT", "죄송합니다."),
        ev("BUSINESS_RESULT", 30, action="ORDER_CREATED", summaryText="택배 접수 주문 저장")]


class FakeClient:
    """client.responses.create 자리. 부를 때마다 정해 둔 답(글 또는 오류)을 차례로 돌려주고, 다 쓰면 마지막 것을 되풀이한다."""

    def __init__(self, *replies):
        self.replies, self.requests = list(replies) or [""], []
        self.responses = self

    async def create(self, **request):
        self.requests.append(request)
        reply = self.replies[min(len(self.requests), len(self.replies)) - 1]
        if isinstance(reply, Exception):
            raise reply
        usage = SimpleNamespace(input_tokens=900, output_tokens=300, input_tokens_details=SimpleNamespace(cached_tokens=0),
                                output_tokens_details=SimpleNamespace(reasoning_tokens=200))
        return SimpleNamespace(output_text=reply, usage=usage)


def reply(issue3="none", issue4="none"):
    """CALL의 차례 1~4를 다 채운 모델 답. 차례 3·4의 문제만 바꿔 가며 쓴다."""
    return json.dumps({"turns": [raw(1), raw(2), raw(3, issue3, "이름을 다시 물음", "성함을 말씀해 주세요"),
                                 raw(4, issue4, "짜증 냄", "방금 말했잖아요", cust=["complain"], complain_quote="방금 말했잖아요",
                                     complain_target="ai_service", complain_level="mild")],
                       "call": {"purposes": ["register"], "goal": "achieved", "mood": "neutral", "summary": "택배 1건 접수"}})


def test_turns_and_model_input():
    rec = analyze.from_events(CALL)
    assert [[u.order for u in t.utterances] for t in rec.turns] == [[1], [2, 3], [4, 5], [6, 8]]
    assert rec.turns[2].actions == [(11.0, "FIELD_SAVED", "기록: 보내는 분")] and rec.results == ["택배 접수 주문 저장"]
    text = analyze.describe(rec)
    assert ("차례 3\n  고객: 홍길동이요\n  · AI 동작 정보 기록: 기록: 보내는 분\n"
            "  AI: 보내시는 분 성함을 말씀해 주세요.\n차례 4") in text
    assert text.endswith("\n\n업무 결과: 택배 접수 주문 저장")


def test_outage_marks_old_and_new_server_failures():
    def down(action, text):
        return analyze.from_events([say(1, 1, "CUSTOMER", "질문"), act(2, action, text)]).turns[0].down

    assert down("FAQ_SEARCH", "실패: 매뉴얼 검색 실패")  # 이전 서버
    assert down("PREVIOUS_ORDER_SEARCH", "주문 조회 실패")
    assert down("FAQ_SEARCH", "실패·재질문: KB_TIMEOUT")  # 새 서버
    assert down("PREVIOUS_ORDER_SEARCH", "실패·재질문: unavailable")
    assert not down("PREVIOUS_ORDER_SEARCH", "실패·재질문: needs_input")  # 업무상 다시 묻기
    assert not down("FIELD_SAVED", "실패: 처리 시간 초과")  # 기록 실패는 장애 구간이 아니다
    assert not down("FAQ_SEARCH", "FAQ 근거 없음")


def test_check_keeps_valid_turns_and_cleans_text():
    rec = analyze.from_events(CALL)
    rec.turns[1].down = True
    got = analyze.check({"turns": [
        raw(2, "INTENT_FAILURE", "장애 구간"),
        raw(3, "RECOGNITION_FAILURE", "이름을 010-1234-5678 다시\x00 물음", "성함을 말씀해", cust=["answer", "bogus"],
            given=["sender_name"]),
        raw(3, "FRUSTRATION", "같은 차례 두 번째", cust=["complain"]),
        raw(9), raw(True), "junk"],
        "call": {"purposes": ["register", "x"], "goal": "maybe", "mood": "negative",
                 "summary": "접수 1건 010 1234 5678"}}, rec)
    assert [t["t"] for t in got["turns"]] == [2, 3] and got["missing"] == 2
    t2, t3 = got["turns"]
    assert t2["issue"] is None and t2["why"] == ""
    assert t3["cust"] == ["answer"] and t3["given"] == ["sender_name"]
    assert (t3["issue"], t3["why"]) == ("RECOGNITION_FAILURE", "이름을 *** 다시 물음")
    assert got["call"] == {"purposes": ["register"], "goal": None, "mood": "negative", "summary": "접수 1건 ***"}
    assert analyze.check("not a dict", rec)["missing"] == 4


def test_issue_must_match_actions():
    rec = analyze.from_events([say(1, 1, "CUSTOMER", "질문"), say(2, 2, "AGENT", "답"),
                               say(3, 3, "CUSTOMER", "조회요"), act(4, "PREVIOUS_ORDER_SEARCH", "택배 1건 찾음"),
                               say(5, 4, "AGENT", "못 찾았어요")])

    def issue(name, t=1, **fields):
        return analyze.check({"turns": [raw(t, name, "사유", "못 찾았어요", **fields)]}, rec)["turns"][0]["issue"]

    assert issue("UNGROUNDED_ANSWER", cust=["question"], ai=["inform"]) is None  # 반대 근거 구절이 없으면 버림
    assert issue("CUSTOMER_CONFUSION", cust=["ask_back"]) == "CUSTOMER_CONFUSION"
    assert issue("CUSTOMER_CONFUSION", cust=["question"]) is None
    assert issue("FRUSTRATION", cust=["complain"]) is None  # 고객 불만은 AI 잘못(issue)이 아님 — complain 칸으로만 (11/10)
    assert issue("RECOGNITION_FAILURE") == "RECOGNITION_FAILURE"
    assert issue("MADE_UP") is None


def test_customer_complaint_needs_customer_words_and_target():
    """고객 불만은 근거가 그 차례 고객 말에 있고 대상이 있을 때만 (11/10). AI 말을 근거로 대거나 지어낸 말이면 버림."""
    rec = analyze.from_events(CALL)

    def complain(quote, target="ai_service", level="mild"):
        t = analyze.check({"turns": [raw(4, cust=["complain"], complain_quote=quote, complain_target=target,
                                         complain_level=level)]}, rec)["turns"][0]
        return t["complain"], t["complain_target"], t["complain_level"]

    assert complain("방금 말했잖아요") == (True, "ai_service", "mild")
    assert complain("방금  말했잖아요!", level="explicit") == (True, "ai_service", "explicit")  # 띄어쓰기 · 문장부호 무시
    assert complain("죄송합니다") == (False, None, None)  # AI 말
    assert complain("왜 이래요 진짜") == (False, None, None)  # 대본에 없음
    assert complain("방금 말했잖아요", target="none") == (False, None, None)  # 대상 없음
    assert complain("방금 말했잖아요", level="bogus") == (True, "ai_service", "mild")  # 강도가 이상하면 가벼운 불편


def test_complaints_merge_runs_and_count_frustration_separately():
    """고객 불만은 AI 잘못과 따로 센다: 앞 차례 문제가 있어도 지우지 않고, 근거는 고객 말 · 대상 · 강도를 붙인다.
    이어진 불만은 한 건 — 강도는 센 쪽."""
    rec = analyze.from_events([say(i, i, "CUSTOMER" if i % 2 else "AGENT", f"말{i}요") for i in range(1, 15)])
    mild = {"complain": True, "complain_quote": "짜증 냄", "complain_target": "ai_service", "complain_level": "mild"}
    analysis = {"turns": [row(1, "RECOGNITION_FAILURE", "주소를 다시 받음"), row(2, "RECOGNITION_FAILURE", "또"),
                          row(3) | mild, row(4) | mild | {"complain_level": "explicit"}, row(5), row(6),
                          row(7) | mild | {"complain_quote": "", "complain_target": "price_policy"}]}
    assert extract.complaints(analysis, rec) == [
        {"type": "RECOGNITION_FAILURE", "evidenceText": "주소를 다시 받음", "offsetSeconds": 1,
         "utteranceOrders": [1, 2, 3, 4]},
        {"type": "FRUSTRATION", "evidenceText": "짜증 냄", "offsetSeconds": 5, "utteranceOrders": [5, 6, 7, 8],
         "target": "ai_service", "level": "explicit"},
        {"type": "FRUSTRATION", "evidenceText": "고객이 불만을 드러냄", "offsetSeconds": 13, "utteranceOrders": [13, 14],
         "target": "price_policy", "level": "mild"}]


def test_complaints_merge_same_issue_within_gap():
    """한 장면(번호를 세 번 못 받음)이 사이 차례를 두고 쪼개져도 한 건 — MERGE_GAP(2) 차례 안. 그보다 멀면 따로."""
    rec = analyze.from_events([say(i, i, "CUSTOMER" if i % 2 else "AGENT", f"말{i}요") for i in range(1, 17)])
    analysis = {"turns": [row(1, "RECOGNITION_FAILURE", "번호를 다시 받음"), row(2), row(3, "RECOGNITION_FAILURE", "또"),
                          row(4), row(5), row(6), row(7, "RECOGNITION_FAILURE", "다른 장면"), row(8)]}
    got = extract.complaints(analysis, rec)
    assert [c["utteranceOrders"] for c in got] == [[1, 2, 3, 4, 5, 6], [13, 14]]
    assert got[0]["evidenceText"] == "번호를 다시 받음"


def test_repeat_questions_and_values():
    rec = analyze.from_events(CALL)
    analysis = {"turns": [row(2, asked=["sender_name"]),
                          row(3, "RECOGNITION_FAILURE", given=["sender_name"], asked=["sender_name"]),
                          row(4, asked=["sender_name", "sender_phone"])], "call": {}}
    assert extract.repeat_questions(analysis, rec) == 2  # 차례 3·4에서 이미 준 이름을 다시 물음. 처음 묻는 번호는 아님
    got = extract.values(analysis, rec)
    assert got["hasComplaint"] is True and got["repeatQuestionCount"] == 2
    assert got["complaints"] == [{"type": "RECOGNITION_FAILURE", "evidenceText": "고객이 준 정보를 잘못 받음",
                                  "offsetSeconds": 10, "utteranceOrders": [4, 5]}]
    assert extract.values(None, rec) == {"hasComplaint": None, "complaints": [], "repeatQuestionCount": None}


def test_lookup_values_are_not_order_values():
    rec = analyze.from_events([say(1, 1, "CUSTOMER", "보낸 택배 조회요"), act(2, "PREVIOUS_ORDER_SEARCH", "택배 1건 찾음"),
                               say(3, 2, "AGENT", "1건 찾았어요"), say(5, 3, "CUSTOMER", "하나 더 접수할게요"),
                               say(7, 4, "AGENT", "받으시는 분 성함은요?")])
    analysis = {"turns": [row(1, given=["receiver_name"]), row(2, cust=["request"], asked=["receiver_name"])]}
    assert extract.repeat_questions(analysis, rec) == 0  # 조회에 쓴 이름을 새 접수에서 묻는 건 되묻기가 아니다


def test_run_one_vote_sends_the_request():
    rec = analyze.from_events(CALL)
    client = FakeClient(reply())
    got = asyncio.run(analyze.run(rec, client, "medium", votes=1))
    (request,) = client.requests
    assert request["reasoning"] == {"effort": "medium"} and request["store"] is False
    assert request["text"]["format"]["strict"] is True and request["input"] == analyze.describe(rec)
    assert got["missing"] == 0 and got["call"]["goal"] == "achieved" and got["usage"]["reasoning"] == 200


def test_run_majority_vote():
    rec = analyze.from_events(CALL)
    client = FakeClient(reply("RECOGNITION_FAILURE", "FRUSTRATION"), reply("RECOGNITION_FAILURE"), reply())
    got = asyncio.run(analyze.run(rec, client))
    assert len(client.requests) == 3 and client.requests[0]["reasoning"] == {"effort": analyze.EFFORT}
    # 두 판에서 나온 정보 인식 오류만 남고, 한 판만 잡은 불만 표현은 빠진다
    assert [(t["t"], t["issue"], t["why"]) for t in got["turns"] if t["issue"]] == [
        (3, "RECOGNITION_FAILURE", "이름을 다시 물음")]
    assert got["votes"] == 3 and got["usage"]["input"] == 2700


def test_single_vote_scene_needs_confirmation(monkeypatch):
    """세 판 중 한 판만 잡은 정보 인식 오류는 장면 재확인이 yes일 때만 살린다(no · 확인 실패면 버림). 켰을 때만(DISPUTE)."""
    monkeypatch.setattr(analyze, "DISPUTE", ("RECOGNITION_FAILURE",))
    rec = analyze.from_events(CALL)
    flagged = lambda got: [(t["t"], t["issue"]) for t in got["turns"] if t["issue"]]
    yes = json.dumps({"verdict": "yes", "why": "이름을 다시 물음"})
    client = FakeClient(reply("RECOGNITION_FAILURE"), reply(), reply(), yes)
    got = asyncio.run(analyze.run(rec, client))
    assert len(client.requests) == 4 and flagged(got) == [(3, "RECOGNITION_FAILURE")]
    for last in (json.dumps({"verdict": "no", "why": "확인"}), asyncio.TimeoutError()):
        got = asyncio.run(analyze.run(rec, FakeClient(reply("RECOGNITION_FAILURE"), reply(), reply(), last)))
        assert flagged(got) == [] and got["dropped"]["dispute_RECOGNITION_FAILURE"] == 1


def test_single_vote_marks_stay_out_of_verdict_but_show_in_loose():
    """한 판만 잡은 정보 인식 오류 · 고객 불만: 판정에는 없고 점검용 분석(loose)에만 나온다."""
    rec = analyze.from_events(CALL)
    quiet = reply().replace('"complain"', '"other"')  # 불만 표시가 없는 판
    got = asyncio.run(analyze.run(rec, FakeClient(reply("RECOGNITION_FAILURE"), quiet, quiet)))
    assert not any(t["issue"] or t["complain"] for t in got["turns"])
    wide = analyze.loose(got)
    assert [(t["t"], t["issue"]) for t in wide["turns"] if t["issue"]] == [(3, "RECOGNITION_FAILURE")]
    assert [(t["t"], t["complain_target"], t["complain_quote"]) for t in wide["turns"] if t["complain"]] == [
        (4, "ai_service", "방금 말했잖아요")]
    assert not any(t["issue"] or t["complain"] for t in got["turns"])  # loose가 원래 판정을 바꾸지 않음


def test_vote_matches_runs_of_turns():
    def run(*rows):
        return {"turns": [row(n) for n in (1, 2, 3, 4)] if not rows else list(rows), "call": {}}

    first = run(row(1), row(2, "RECOGNITION_FAILURE", "주소를 다시 받음"), row(3, "RECOGNITION_FAILURE", "또"), row(4))
    second = run(row(1), row(2), row(3, "RECOGNITION_FAILURE", "다시"), row(4, "FRUSTRATION", "짜증"))
    got = analyze.vote([first, second, run()], 2)
    # 판마다 표시한 차례가 달라도(2~3차례 / 3차례) 겹치면 같은 건. 한 판만 잡은 불만 표현은 빠진다
    assert [(t["t"], t["issue"], t["why"]) for t in got["turns"] if t["issue"]] == [
        (2, "RECOGNITION_FAILURE", "주소를 다시 받음"), (3, "RECOGNITION_FAILURE", "또")]
    apart = run(row(1), row(2), row(3), row(4, "RECOGNITION_FAILURE", "다른 곳"))
    assert [t["t"] for t in analyze.vote([first, apart, run()], 2)["turns"] if t["issue"]] == []  # 안 겹치면 다른 건


def test_vote_call_fields_by_majority():
    """통화 칸도 다수결: 감정 · 결과는 가장 많은 값, 용건은 두 판 이상이 고른 것만."""
    def run(mood, goal, purposes):
        return {"turns": [], "call": {"mood": mood, "goal": goal, "purposes": purposes, "summary": "s"}}
    got = analyze.vote([run("neutral", "achieved", ["register", "inquiry"]), run("negative", "failed", ["register"]),
                        run("negative", "achieved", ["register", "cancel"])], 2)["call"]
    assert (got["mood"], got["goal"], got["purposes"]) == ("negative", "achieved", ["register"])


def test_evaluate_scores_call_fields():
    from call_analysis.evaluate import score_calls
    text = ("통화 1  발화 9  불만 없음  되묻기 0  3판  1초  용건 register,inquiry  결과 achieved  감정 negative\n"
            "통화 2  발화 9  불만 없음  되묻기 0  3판  1초  용건 -  결과 none  감정 neutral")
    gold = {"1": {"purposes": ["register"], "goal": "achieved", "mood": "neutral"},
            "2": {"purposes": [], "goal": "none", "mood": "negative"}}
    c = score_calls(gold, text)
    assert c["n"] == 2 and c["mood"] == 0 and c["goal"] == 1
    assert c["negative"] == (0, 1, 1) and c["purposes"]["register"] == (1, 1, 1) and c["purposes"]["inquiry"] == (0, 1, 0)


def test_run_failure_is_unanalyzed():
    rec = analyze.from_events(CALL)
    ok = reply("RECOGNITION_FAILURE")
    two = asyncio.run(analyze.run(rec, FakeClient(ok, asyncio.TimeoutError(), ok)))  # 두 판이면 다수결이 된다
    assert two["votes"] == 2 and [t["t"] for t in two["turns"] if t["issue"]] == [3]
    assert asyncio.run(analyze.run(rec, FakeClient(ok, asyncio.TimeoutError(), "not json"))) is None  # 한 판뿐
    assert asyncio.run(analyze.run(rec, FakeClient("not json"))) is None
    empty = analyze.from_events([])
    got = asyncio.run(analyze.run(empty, FakeClient()))
    assert extract.values(got, empty) == {"hasComplaint": False, "complaints": [], "repeatQuestionCount": 0}


def test_prompt_names_every_code():
    text = analyze.PROMPT.read_text(encoding="utf-8")
    codes = (*analyze.CUST, *analyze.AI, *analyze.FIELDS, *analyze.ISSUES, *analyze.PURPOSES,
             *analyze.GOALS, *analyze.MOODS)
    assert [c for c in codes if not re.search(rf"\b{c}\b", text)] == []


def test_spoken_phone_ok_counts_korean_digit_words():
    """실서버 발화(11/05): 고객이 말한 번호를 코드로 센다 — 모델이 '하나둘셋넷'을 잘 못 셈."""
    f = analyze.spoken_phone_ok
    assert f("공일공, 하나둘셋넷, 여섯일구여덟아홉") is False  # 12자리 — 고객이 잘못 부름
    assert f("공일공 일일이삼사 사일오오입니다") is False
    assert f("공일공 사구구이 사하나구삼이요") is True  # 11자리 — AI가 맞는 번호를 거절
    assert f("010-1234-5678이요") is True
    assert f("공일공 사구구이 천사입니다") is None  # 자리 말(천) — 셀 수 없음
    assert f("공공공공 공공공공이요") is None  # 8자리 — 앞 발화의 '공일공'에 이어질 수 있음
    assert f("서울 가상로 이십이") is None


def test_check_uses_spoken_digits_for_phone_rejects():
    """'자릿수 틀림'으로 다시 물은 차례: 분명히 틀린 번호면 정보 인식 오류를 지우고, 분명히 맞는 번호면 모델이 놓쳐도 잡는다."""
    def call(spoken):
        return analyze.from_events([act(0, "CUSTOMER_LOOKUP", "등록 고객"), say(1, 1, "AGENT", "받는 분 연락처를 알려주세요."),
                                    say(5, 2, "CUSTOMER", spoken), act(7, "FIELD_SAVED", "실패·재질문: PHONE_INVALID_DIGITS"),
                                    say(8, 3, "AGENT", "번호 자릿수가 맞지 않아요. 다시 불러 주시겠어요?")])
    wrong = call("공일공 일일이삼사 사일오오입니다")
    assert analyze.check({"turns": [raw(1), raw(2, "RECOGNITION_FAILURE", "번호를 다시 물음")]}, wrong)["turns"][1]["issue"] is None
    right = call("공일공 사구구이 사하나구삼이요")
    got = analyze.check({"turns": [raw(1), raw(2)]}, right)["turns"][1]
    assert got["issue"] == "RECOGNITION_FAILURE" and got["why"] == "맞는 번호를 자릿수가 틀렸다며 다시 물음"


def test_evaluate_scores_overlap_and_skips_check():
    from call_analysis.evaluate import parse_run, score
    gold = {"calls": [1, 2], "labels": [
        {"seq": 1, "from": 5, "to": 8, "verdict": "issue", "type": "A"},
        {"seq": 1, "from": 20, "to": 21, "verdict": "none", "type": None},
        {"seq": 2, "from": 3, "to": 4, "verdict": "check", "type": "A"},
        {"seq": 2, "from": 9, "to": 9, "verdict": "issue", "type": "B"}]}
    judged, found = parse_run("통화 1  발화 30  A@[7, 8, 9] · A@[21]  되묻기 0  3판  1초\n"
                              "통화 2  발화 10  A@[4]  되묻기 0  3판  1초\n통화 3  발화 5  불만 없음  되묻기 0  3판  1초")
    r = score(gold, judged, found)["types"]
    assert r["A"] == {"tp": 1, "fp": 1, "fn": 0, "precision": 0.5, "recall": 1.0}
    assert r["B"]["fn"] == 1 and r["ALL"]["recall"] == 0.5
    # 줄 끝 '한판 …'(다수결에 못 미친 표시)은 loose일 때만 판정에 넣는다
    line = "통화 2  발화 10  불만 없음  되묻기 0  3판  1초  용건 -  결과 none  감정 neutral  버림 {}  한판 B@[9] · A:ai_service:mild@[1]"
    assert parse_run(line)[1] == [] and parse_run(line, loose=True)[1] == [(2, "B", 9, 9), (2, "A", 1, 1)]
    scoped = score({**gold, "types": ["B"]}, judged, found)["types"]  # 한 유형만 매긴 정답: A 판정은 셈 밖
    assert "A" not in scoped and scoped["B"]["fn"] == 1


def test_faq_review_grounds_answers_and_marks_kb_outage():
    """AI 서버의 FAQ 검토: 근거 있음(답한 발화 번호로 차례를 찾음)·근거 없어 거절한 차례는 '근거 없는 답변'이 아니고, 검색 장애는 장애 구간."""
    rec = analyze.from_events([
        say(1, 1, "AGENT", "안녕하세요"), say(5, 2, "CUSTOMER", "보관함 되나요"), act(6, "FAQ_SEARCH", "FAQ 검색 후보 3건 반환"),
        say(8, 3, "AGENT", "네, 가능합니다"), say(10, 4, "CUSTOMER", "요금은요"), say(12, 5, "AGENT", "모릅니다"),
        say(14, 6, "CUSTOMER", "포장은요"), say(16, 7, "AGENT", "확인이 어렵습니다"),
        ev("BUSINESS_RESULT", 40, action="FAQ_ANSWERED", summaryText="FAQ 답변 근거 있음", answerUtteranceOrder=3),
        ev("BUSINESS_RESULT", 11, action="QUESTION_UNANSWERED", summaryText="FAQ 답변 근거 없음"),
        ev("BUSINESS_RESULT", 15, action="QUESTION_UNANSWERED", summaryText="지식 검색 장애로 답변하지 못함")])
    assert [a for _, a, _ in rec.turns[1].actions] == ["FAQ_SEARCH", "FAQ_ANSWERED"]  # 시각(40초)이 아니라 발화 3번으로
    assert [a for _, a, _ in rec.turns[2].actions] == ["QUESTION_UNANSWERED"] and rec.turns[3].down
    assert rec.results == [] and "· AI 동작 FAQ 검토: FAQ 답변 근거 있음" in analyze.describe(rec)
    q = dict(cust=["question"], ai=["inform"])
    out = analyze.check({"turns": [raw(n, "UNGROUNDED_ANSWER", "근거 없이 답함", **q) for n in (2, 3, 4)]}, rec)
    assert [t["issue"] for t in out["turns"]] == [None, None, None]


def test_issue_needs_real_quote():
    """대본에 없는 근거 인용은 버린다(모델이 지어낸 문제)."""
    rec = analyze.from_events(CALL)
    def kept(t, quote):
        return analyze.check({"turns": [raw(t, "RECOGNITION_FAILURE", "사유", quote)]}, rec)["turns"][0]["issue"]
    assert kept(3, "성함을 말씀해 주세요") == "RECOGNITION_FAILURE"
    assert kept(3, "방금말했잖아요!") == "RECOGNITION_FAILURE"  # 띄어쓰기 · 문장부호는 무시, 바로 뒤 차례 발화도 됨
    assert kept(3, "주소를 세 번 물었어요") is None  # 대본에 없는 말
    assert kept(3, "") is None and kept(3, "네") is None  # 인용 없음 · 너무 짧음
    assert kept(1, "방금 말했잖아요") is None  # 두 차례 넘게 떨어진 발화



def test_recording_pauses_and_slow_response_by_code():
    """녹음 말소리 구간으로 발화 앞 침묵을 붙이고, 응답 지연은 코드가 AI 차례 침묵 + 고객 반응으로 정한다(모델 판정 아님)."""
    speech = [(0.5, 2.5), (4.0, 7.2), (7.5, 10.2), (10.5, 12.5), (15.5, 18.5)]  # 12.5~15.5초 침묵
    rec = analyze.from_events(CALL, speech=speech)
    assert [u.pause for t in rec.turns for u in t.utterances] == [None, None, None, None, None, 3.0, None]
    assert "  · 침묵 3초\n  고객: 방금 말했잖아요" in analyze.describe(rec)
    assert facts.slow_turns(rec) == []  # AI가 물은 뒤의 침묵(고객 차례) · 기다림 말 없음
    waited = analyze.from_events([say(1, 1, "AGENT", "잠시만요, 확인해 볼게요."), say(20, 2, "CUSTOMER", "여보세요")],
                                 speech=[(0.5, 2.5), (19.0, 20.0)])
    assert facts.slow_turns(waited) == [(1, 2)]  # 16.5초 침묵 뒤 '여보세요'
    assert facts.slow_turns(analyze.from_events([say(1, 1, "AGENT", "잠시만요."), say(20, 2, "CUSTOMER", "여보세요")])) == []  # 녹음 없음
    assert [c["type"] for c in extract.complaints({"turns": [row(1), row(2)]}, waited)] == ["SLOW_RESPONSE"]


def test_info_errors_by_code():
    """번호 복창 불일치 · 인사에서 부른 이름을 다시 물음은 코드가 정보 인식 오류로 정한다."""
    rec = analyze.from_events([say(1, 1, "AGENT", "안녕하세요, 홍길동님, 가상로 7-3에서 보내시는 택배 접수 도와드릴까요?"),
                               say(3, 2, "CUSTOMER", "네"), say(4, 3, "AGENT", "보내시는 분 성함을 알려주세요."),
                               say(8, 4, "CUSTOMER", "공일공 구구팔팔 하나하나삼삼이요"),
                               say(10, 5, "AGENT", "공일공, 구구팔팔, 일이삼삼 맞으신가요?")])
    assert facts.info_errors(rec) == [(4, 5, "고객이 부른 번호와 다르게 복창함"), (3, 3, "인사에서 부른 이름을 다시 물음")]
    changed = analyze.from_events([say(1, 1, "AGENT", "안녕하세요, 홍길동님, 택배 접수 도와드릴까요?"),
                                   say(3, 2, "CUSTOMER", "아니요, 다른 분 이름으로 보낼게요"),
                                   say(4, 3, "AGENT", "보내시는 분 성함을 알려주세요.")])
    assert facts.info_errors(changed) == []  # 고객이 바꾼다고 함


def test_cut_in_marks_interruption_evidence():
    """AI 말이 문장 중간에서 끝나고 고객이 바로 말하면 '끼어들어 끊김'으로 표시하고, 그 차례를 판정 없이 말 끊김으로 센다."""
    rec = analyze.from_events([say(1, 1, "AGENT", "접수 내용 확인할게요. 보내는 분 홍길동님, 보내는 곳"),
                               say(3, 2, "CUSTOMER", "확인 안 해 주셔도 돼요"), say(4, 3, "AGENT", "네, 알겠습니다."),
                               say(6, 4, "CUSTOMER", "네")])
    assert [u.cut for t in rec.turns for u in t.utterances] == [True, False, False, False]
    assert "보내는 곳 (고객이 끼어들어 끊김)" in analyze.describe(rec)
    analysis = {"turns": [row(1), row(2), row(3)]}
    assert [c for c in extract.complaints(analysis, rec) if c["type"] == "INTERRUPTION"] == [
        {"type": "INTERRUPTION", "evidenceText": "고객이 끼어들어 AI 말이 중간에 끊김", "offsetSeconds": 1, "utteranceOrders": [1]}]

def test_instructions_carry_faq_text():
    """판정 지시문 = prompt.md + AI 업무 규칙(주석 뺌) + (있으면) FAQ 원문 — 근거 없는 답변 대조용."""
    base = analyze.instructions()
    assert base.startswith(analyze.PROMPT.read_text(encoding="utf-8")) and "## AI 업무 규칙" in base and "<!--" not in base
    assert "수거 시각은 먼저 묻지 않" in base  # 되읽기 때 수거 시각 안내는 규칙 (11/10)
    assert analyze.instructions(rules=False) == analyze.PROMPT.read_text(encoding="utf-8")
    text = analyze.instructions([{"question": "제주도 보내면 얼마예요?", "answer": "제주는 3,000원 추가됩니다."}])
    assert text.endswith("- Q: 제주도 보내면 얼마예요?\n  A: 제주는 3,000원 추가됩니다.") and "## FAQ 원문" in text


def test_scene_confirmation_drops_rejected_intent():
    """1차 판정의 의도 인식 · 근거 없는 답변은 장면만 보여 주고 다시 묻는다. '아니오'면 지우고, 확인이 실패하면 둔다."""
    rec = analyze.from_events(CALL)
    first = reply("INTENT_FAILURE")
    client = FakeClient(first, first, first, json.dumps({"verdict": "no", "why": "정상 응대"}))
    got = asyncio.run(analyze.run(rec, client))
    assert [t["issue"] for t in got["turns"] if t["issue"]] == [] and len(client.requests) == 4
    assert "▶차례 3" in client.requests[3]["input"] and "업무 결과" not in client.requests[3]["input"]
    kept = asyncio.run(analyze.run(rec, FakeClient(first, first, first, openai.APIError("x", None, body=None))))
    assert [t["issue"] for t in kept["turns"] if t["issue"]] == ["INTENT_FAILURE"]


def test_outage_turn_keeps_real_ai_errors_and_customer_complaints():
    """장애 구간이라도 AI 잘못(근거 인용이 있는 문제)은 남기고, 고객이 말한 불만도 센다(11/10 — 고객 말이 기준)."""
    rec = analyze.from_events(CALL)
    rec.turns[3].down = True
    got = analyze.check({"turns": [raw(4, "INTENT_FAILURE", "질문 중에 끝인사", "죄송합니다", cust=["complain"],
                                       complain_quote="방금 말했잖아요", complain_target="ai_service", complain_level="mild")]}, rec)
    assert got["turns"][0]["issue"] == "INTENT_FAILURE" and got["turns"][0]["complain"] is True


def test_re_ask_rule_is_per_sentence_and_respects_earlier_change():
    """11/10 실서버 오탐: 고객이 이름을 바꾼 뒤 "보내는 분 성함 ○○님으로 변경해 두었습니다. 받는 분 성함 알려주시겠어요?"를
    '인사에서 부른 이름을 다시 물음'으로 잡음 → 묻는 문장 안에 '보내는 분 성함'이 있어야 하고, 앞서 이름을 바꾸겠다고 했으면 아님."""
    greet = say(1, 1, "AGENT", "안녕하세요, 홍길동님, 서울 가상로에서 보내시는 택배 접수 도와드릴까요?")
    rec = analyze.from_events([greet, say(5, 2, "CUSTOMER", "네"), say(9, 3, "CUSTOMER", "이름 바꿀 수 있나요"),
                               say(10, 4, "AGENT", "네, 바꿔드릴게요."), say(14, 5, "CUSTOMER", "김철수요"),
                               say(16, 6, "AGENT", "네, 보내는 분 성함 김철수님으로 변경해 두었습니다. 받는 분 성함 알려주시겠어요?")])
    assert facts.info_errors(rec) == []
    again = analyze.from_events([greet, say(5, 2, "CUSTOMER", "네"), say(9, 3, "AGENT", "보내시는 분 성함을 알려주세요.")])
    assert facts.info_errors(again) == [(3, 3, "인사에서 부른 이름을 다시 물음")]



