"""통화 분석: 끝난 통화의 저장된 기록(EVT-01 이벤트)을 코드가 차례로 나누고, 모델이 차례마다 정해진 칸을 채운다.
불만·되묻기처럼 결과에서 값을 뽑는 일은 extract.py가 코드로 한다(토큰 없음).

후처리 전용(11/05 결정, README.md): 끝난 통화를 별도 배치 · 전용 API 키로 나중에 돈다. 실시간 상담 경로(app/)에는 넣지 않는다.
AI 통화 처리(app/)와는 따로 돈다. app을 import하지 않고 표준 라이브러리와 OpenAI SDK만 쓴다.
모델 결과는 미신뢰 입력이라 check()가 입력에 있는 차례, 정해진 값, 행동과 맞는 문제만 남긴다.
같은 통화를 VOTES번 동시에 판정해 같은 차례·같은 문제가 NEED번 이상 나온 것만 남긴다(다수결, vote()).
"""

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import openai

from call_analysis import timing

log = logging.getLogger(__name__)

MODEL = "gpt-6-luna"
EFFORT = "medium"  # 11/06 정답 50건: low 대비 재현율 52%→77%(정밀도 비슷), 비용 약 3배(통화당 약 4원)
VOTES, NEED = 3, 2  # 세 번 판정해 두 번 이상 나온 문제만(30건 저장 결과로 정밀도 82%→89%, 재현율 그대로)
TIMEOUT_SEC = 120.0  # 한 판 기다리는 시간. 11/05 실서버: 발화 109개 통화의 한 판이 60초를 넘겨 버려짐 → 120 (백그라운드라 길어도 됨)
MAX_INPUT_CHARS = 40_000
MAX_WHY, MAX_SUMMARY, MAX_QUOTE = 200, 120, 80  # 백엔드 evidenceText 상한은 1000
PROMPT = Path(__file__).with_name("prompt.md")

# 칸 값. prompt.md에 같은 목록이 있다(테스트가 확인)
CUST = ("answer", "question", "request", "correct", "confirm", "ask_back", "wait", "complain", "end", "other")
AI = ("ask", "inform", "confirm", "process", "handoff", "refuse", "wait", "close", "other")
FIELDS = ("sender_name", "sender_phone", "sender_address", "receiver_name", "receiver_phone", "receiver_address",
          "item", "item_price", "pickup_at", "payment")
BASIS = ("faq", "tool", "order", "none", "na")
# 말 끊김 · 응답 지연은 모델이 고르지 않는다 — 대본 · 녹음 사실로 코드가 정한다(facts.py · extract.complaints, 11/06 사용자)
ISSUES = ("RECOGNITION_FAILURE", "INTENT_FAILURE", "UNGROUNDED_ANSWER", "CUSTOMER_CONFUSION", "FRUSTRATION")
PURPOSES = ("register", "lookup", "cancel", "inquiry", "handoff", "other")
GOALS = ("achieved", "partial", "failed", "none")
MOODS = ("positive", "neutral", "negative")

# 차례에 붙이는 AI 동작(EVT-01 AI_ACTION). 통화 결과 전송·업무 결과는 차례가 아니라 끝의 '업무 결과' 줄로
TOOLS = {"FAQ_SEARCH": "FAQ 검색", "PREVIOUS_ORDER_SEARCH": "택배 조회", "FIELD_SAVED": "정보 기록",
         "PIN_SEARCH": "주소록 찾기", "ORDER_CANCELLED": "택배 취소"}
# AI 서버의 통화 후 FAQ 검토(업무 결과, 11/05 배포분부터): 근거가 있는지는 모델이 짐작하지 않고 이 기록으로 정한다.
# FAQ_ANSWERED = 그 AI 발화(answerUtteranceOrder)는 FAQ 근거로 답함 · QUESTION_UNANSWERED = 답하지 않고 거절(근거 부족) 또는 검색 장애
# → 둘 다 붙은 차례는 '근거 없는 답변'이 아니다. FAQ_SEARCH는 후보를 찾았다는 뜻일 뿐 답에 썼다는 뜻이 아니다
REVIEWS = {"FAQ_ANSWERED": "FAQ 검토", "QUESTION_UNANSWERED": "답 못한 질문"}
KB_DOWN = "장애"  # QUESTION_UNANSWERED 사유 "지식 검색 장애로 답변하지 못함" — 서버 장애라 그 차례 문제는 세지 않음
LABELS = TOOLS | REVIEWS
SEARCHES = ("FAQ_SEARCH", "PREVIOUS_ORDER_SEARCH")  # 검색 · 조회 동작(실패하면 장애 구간)
# 검색·조회가 시스템 문제로 실패한 표시. 이전 서버(11/03까지)는 "실패: 오류 문장", 새 서버는 "실패·재질문: 코드 또는 상태"
OLD_DOWN = ("매뉴얼 검색 미연결", "매뉴얼 검색 실패", "처리 시간 초과", "내부 오류")
# ponytail: 새 서버 app/tools의 코드 이름(44a92bc)에서 시스템 오류만 골랐다. 새 코드가 생기면 여기에 더한다
NEW_DOWN = ("TIMEOUT", "UNAVAILABLE", "TRANSPORT", "INTERNAL", "RESPONSE_INVALID", "unavailable", "unknown")
# 전화번호 자릿수 확인 (11/05 실서버): AI가 '자릿수 틀림'(PHONE_INVALID_DIGITS)으로 다시 물은 차례에서 고객이 말한 숫자를 코드로 센다.
# 모델은 '하나둘셋넷' 같은 말로 된 숫자를 잘 못 세서, 고객이 정말 잘못 부른 번호도 정보 인식 오류로 잡았음. 기준은 AI 서버 normalize_phone과 같음
PHONE_REJECT = "PHONE_INVALID_DIGITS"
NATIVE = {"다섯": "5", "여섯": "6", "일곱": "7", "여덟": "8", "아홉": "9", "하나": "1", "둘": "2", "셋": "3", "넷": "4"}
SINO = {"공": "0", "영": "0", "일": "1", "이": "2", "삼": "3", "사": "4", "오": "5", "육": "6", "륙": "6", "칠": "7", "팔": "8", "구": "9"}
TAILS = ("입니다", "이에요", "이고요", "이요", "예요", "에요", "고요", "이고", "이랑", "랑", "요", "에", "고")
# 문장이 끝난 말인지(AI 말 끝). 문장 중간에 끊긴 AI 말 뒤에 고객 말이 오면 고객이 끼어든 것
SENTENCE_END = re.compile(r"(다|요|까|죠|네|세요|군요|[.?!~])\W*$")
DIGITS = re.compile(r"\d[\d\s-]+\d")  # 세 자리 넘게 이어진 숫자(번호·금액)는 사유·요약에 남기지 않는다


def _codes(values) -> dict:
    return {"type": "array", "items": {"type": "string", "enum": list(values)}}


SCHEMA = {"type": "object", "additionalProperties": False, "required": ["turns", "call"], "properties": {
    "turns": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["t", "cust", "given", "ai", "asked", "basis", "issue", "why", "quote"],
        "properties": {"t": {"type": "integer"}, "cust": _codes(CUST), "given": _codes(FIELDS), "ai": _codes(AI),
                       "asked": _codes(FIELDS), "basis": {"type": "string", "enum": list(BASIS)},
                       "issue": {"type": "string", "enum": ["none", *ISSUES]}, "why": {"type": "string"},
                       "quote": {"type": "string"}}}},
    "call": {"type": "object", "additionalProperties": False, "required": ["purposes", "goal", "mood", "summary"],
             "properties": {"purposes": _codes(PURPOSES), "goal": {"type": "string", "enum": list(GOALS)},
                            "mood": {"type": "string", "enum": list(MOODS)}, "summary": {"type": "string"}}}}}


@dataclass
class Utterance:
    order: int  # 백엔드 utteranceOrder
    customer: bool
    text: str
    at: float  # 통화 시작부터 초(발화 첫 조각을 받은 시각)
    offset: int | None  # 스크립트 offsetSeconds(불만 offsetSeconds의 기준)
    pause: float | None = None  # 녹음에서 잰 이 발화 앞 침묵(초, timing.SHOW_PAUSE 이상만)
    pause_guessed: bool = False  # 녹음이 잡음으로 못 재서 대본 시각으로 어림한 침묵
    cut: bool = False  # AI 말이 문장 중간에서 끝나고 고객이 바로 말함 = 고객이 끼어들어 AI 말이 끊김(말 끊김 판정의 근거)


@dataclass
class Turn:
    """차례: 고객 발화 하나와 다음 고객 발화 전까지의 AI 발화. 첫 고객 발화 앞의 AI 인사는 차례 1."""
    no: int
    utterances: list[Utterance] = field(default_factory=list)
    actions: list[tuple[float, str, str]] = field(default_factory=list)  # (시각, 동작 코드, 결과 요약)
    down: bool = False  # 장애 구간: 검색·조회가 시스템 문제로 실패함. 이 차례의 문제는 세지 않는다


@dataclass
class Record:
    turns: list[Turn]
    results: list[str]  # 업무 결과 요약(주문 저장·취소·상담원 연결 요청·통화 결과 전송)
    session_id: str = ""  # 로그용
    speech: list[tuple[float, float]] | None = None  # 녹음 말소리 구간(timing.speech_segments). 없으면 응답 지연을 정하지 않음


def _digits(token: str) -> str | None:
    """말 한 덩어리 → 숫자. 전부 숫자 말(공일공 · 하나둘 · 010)이어야 하고, 아니면 None."""
    for tail in TAILS:
        if token.endswith(tail) and len(token) > len(tail):
            token = token[: -len(tail)]
            break
    out = ""
    while token:
        if token[0].isdigit():
            out, token = out + token[0], token[1:]
        elif word := next((w for w in NATIVE if token.startswith(w)), None):
            out, token = out + NATIVE[word], token[len(word):]
        elif token[0] in SINO:
            out, token = out + SINO[token[0]], token[1:]
        else:
            return None
    return out


def spoken_phone_ok(text: str) -> bool | None:
    """고객이 말한 번호가 자릿수 기준에 맞는지. True = 맞음(AI가 틀리게 거절) · False = 분명히 틀림(고객이 잘못 부름)
    · None = 모름(숫자 8자리 이하라 앞 발화에 이어질 수 있음, '천사'처럼 자리 말이 섞임, 숫자 없음)."""
    if any(w in text for w in ("십", "백", "천", "만")):
        return None
    digits = "".join(d for tok in re.split(r"[\s,.·-]+", text) if tok and (d := _digits(tok)) is not None)
    if len(digits) < 9:
        return None
    if re.fullmatch(r"1[568]\d{6}", digits):
        return True
    if digits.startswith("010"):
        return len(digits) == 11
    return digits.startswith("0") and 9 <= len(digits) <= 11


def _down(action: str, text: str) -> bool:
    if action == "QUESTION_UNANSWERED":
        return KB_DOWN in text
    if action not in SEARCHES:
        return False
    if text == "주문 조회 실패" or text.removeprefix("실패: ") in OLD_DOWN:
        return True
    code = text.removeprefix("실패·재질문: ")
    return code != text and any(mark in code for mark in NEW_DOWN)


def from_events(events: list[dict], session_id: str = "", speech: list[tuple[float, float]] | None = None) -> Record:
    """EVT-01 이벤트(백엔드에 저장된 통화 기록)로 차례를 만든다. 시각 기준은 통화 시작(고객 확인 CUSTOMER_LOOKUP).
    speech = 녹음의 말소리 구간(timing.speech_segments) — 있으면 발화마다 앞 침묵을 붙인다."""
    def ts(e: dict) -> float:
        return datetime.fromisoformat(e["occurredAt"]).timestamp()

    start = next((ts(e) for e in events if (e.get("payload") or {}).get("action") == "CUSTOMER_LOOKUP"),
                 min((ts(e) for e in events), default=0.0))
    utterances, actions, results, answered = [], [], [], {}
    for e in events:
        p = e.get("payload") or {}
        action, text = p.get("action"), str(p.get("summaryText") or "")
        if e["kind"] == "UTTERANCE" and str(p.get("utteranceText") or "").strip():
            utterances.append(Utterance(p["utteranceOrder"], p.get("speaker") == "CUSTOMER",
                                        str(p["utteranceText"]).strip(), ts(e) - start, e.get("offsetSeconds")))
        elif e["kind"] == "AI_ACTION" and action in TOOLS or e["kind"] == "BUSINESS_RESULT" and action in REVIEWS:
            actions.append((ts(e) - start, action, text))
            if isinstance(p.get("answerUtteranceOrder"), int):
                answered[actions[-1]] = p["answerUtteranceOrder"]
        elif (e["kind"] == "BUSINESS_RESULT" or action == "ORDER_SUBMITTED") and text and text not in results:
            results.append(text)
    utterances.sort(key=lambda u: u.order)
    if speech is not None:
        for u, p in zip(utterances, timing.pauses([u.offset for u in utterances], speech,
                                                       [(u.customer, u.text) for u in utterances])):
            u.pause, u.pause_guessed = p if p else (None, False)
    for u, nxt in zip(utterances, utterances[1:]):
        u.cut = not u.customer and nxt.customer and not SENTENCE_END.search(u.text)
    turns: list[Turn] = []
    for u in utterances:
        if u.customer or not turns:
            turns.append(Turn(len(turns) + 1))
        turns[-1].utterances.append(u)
    for at, action, text in sorted(actions):
        order = answered.get((at, action, text))  # 답한 발화 번호가 있으면 시각보다 그걸로 차례를 찾는다
        turn = next((t for t in turns if any(u.order == order for u in t.utterances)), None) if order else None
        turn = turn or next((t for t in reversed(turns) if t.utterances[0].at <= at), turns[0] if turns else None)
        if turn:
            turn.actions.append((at, action, text))
            turn.down |= _down(action, text)
    return Record(turns, results, session_id, speech=speech)


def describe(rec: Record, only: set[int] | None = None, mark: set[int] | None = None) -> str:
    """모델 입력: 차례마다 발화와 그 사이 AI 동작(도구 결과 요약, 값 없음), 끝에 업무 결과.
    only = 이 차례들만(장면 확인용, 업무 결과 없음) · mark = 앞에 ▶를 붙일 차례."""
    lines = []
    for t in rec.turns:
        if only is not None and t.no not in only:
            continue
        rows = [(u.at, 0, f"  {'고객' if u.customer else 'AI'}: {u.text}" + (" (고객이 끼어들어 끊김)" if u.cut else ""))
                for u in t.utterances]
        rows += [(u.at, -1, f"  · 침묵 {'약 ' if u.pause_guessed else ''}{u.pause:.0f}초" + (" (대본 어림)" if u.pause_guessed else ""))
                 for u in t.utterances if u.pause]
        rows += [(at, 1, f"  · AI 동작 {LABELS[action]}: {text}") for at, action, text in t.actions]
        lines.append(("▶" if mark and t.no in mark else "") + f"차례 {t.no}" + (" (장애 구간)" if t.down else ""))
        lines += [r[2] for r in sorted(rows, key=lambda r: r[:2])]
    if only is None:
        lines += ["", "업무 결과: " + (" · ".join(rec.results) or "없음")]
    return "\n".join(lines)


# 장면 확인(2차): 1차 판정이 잡은 의도 인식 · 근거 없는 답변을 그 장면만 보여 주고 예/아니오로 다시 묻는다.
# 통화 전체를 보며 고르면 정상 응대(업무 밖 거절, 모른다고 함)까지 잡는 오탐이 많았다(11/06 시험 50통화 16건 중 대부분)
VERIFY = ("INTENT_FAILURE", "UNGROUNDED_ANSWER")
VERIFY_PROMPT = Path(__file__).with_name("verify.md")
VERIFY_CONTEXT = 3  # 장면 앞으로 보여 줄 차례 수
VERIFY_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["verdict", "why"],
                 "properties": {"verdict": {"type": "string", "enum": ["yes", "no"]}, "why": {"type": "string"}}}


def instructions(faqs: list[dict] | None = None, prompt: Path = PROMPT) -> str:
    """판정 지시문 = prompt.md + (있으면) FAQ 원문. FAQ는 통화마다 같아 앞부분 캐시가 걸린다.
    근거 없는 답변은 AI 안내를 이 원문과 대조해 정한다 — 모델이 FAQ 내용을 모르면 정상 안내도 근거 없다고 봤다(11/06)."""
    text = prompt.read_text(encoding="utf-8")
    if not faqs:
        return text
    def one(v) -> str:
        return " ".join(str(v or "").split())
    rows = [f"- Q: {one(f.get('question'))}\n  A: {one(f.get('answer'))}" for f in faqs]
    return f"{text}\n\n## FAQ 원문 (AI가 검색해 답할 수 있는 안내 자료 전체)\n\n" + "\n".join(rows)


async def call_model(client, text: str, effort: str, faqs: list[dict] | None = None) -> tuple[dict, dict | None]:
    resp = await client.responses.create(
        model=MODEL, instructions=instructions(faqs), input=text, reasoning={"effort": effort},
        text={"format": {"type": "json_schema", "name": "call_analysis", "strict": True, "schema": SCHEMA}},
        store=False)
    return json.loads(resp.output_text), _usage(resp)


def _usage(resp) -> dict | None:
    """토큰 수(입력·캐시된 입력·출력·추론). 통화당 비용과 느린 원인(추론량)을 보려고 남긴다."""
    u = getattr(resp, "usage", None)
    if u is None:
        return None
    given, made = getattr(u, "input_tokens_details", None), getattr(u, "output_tokens_details", None)
    return {"input": getattr(u, "input_tokens", None), "cached": getattr(given, "cached_tokens", None),
            "output": getattr(u, "output_tokens", None), "reasoning": getattr(made, "reasoning_tokens", None)}


def _pick(values, allowed: tuple) -> list[str]:
    out = []
    for v in values if isinstance(values, list) else []:
        if v in allowed and v not in out:
            out.append(v)
    return out


def _clean(text, limit: int) -> str:
    """화면·로그로 나가는 글: 제어 문자(백엔드가 NUL이면 분석 전체를 거절)는 빼고, 번호·금액은 가린다."""
    text = "".join(c if c.isprintable() else " " for c in str(text or ""))
    return DIGITS.sub("***", " ".join(text.split()))[:limit]


def _quoted(quote: str, rec: Record, no: int) -> bool:
    """근거 인용이 그 차례나 바로 앞뒤 차례 발화에 글자 그대로 있는지(띄어쓰기 · 문장부호는 무시, 네 글자 이상)."""
    def norm(s: str) -> str:
        return re.sub(r"[\W_]+", "", s)
    q = norm(quote)
    return len(q) >= 4 and any(q in norm(u.text) for t in rec.turns if abs(t.no - no) <= 1 for u in t.utterances)


def check(raw, rec: Record) -> dict:
    """모델 결과 검사: 입력에 있는 차례만 한 번씩, 정해진 값만 남긴다. 행동과 맞지 않는 문제와 장애 구간의 문제는 버린다.
    근거 없는 답변은 고객이 그 차례에 질문했거나(검색 없이 답함) 그 차례에 검색·조회가 있었을 때만(결과와 다르게 말함) 남긴다.
    둘 다 없는 차례의 안내는 AI가 접수하며 먼저 꺼낸 말이고, 그 근거(통화 시작 때 받은 고객 정보, 서버의 수거 시각 검사)는
    저장된 기록에 없어 모델이 볼 수 없다."""
    raw = raw if isinstance(raw, dict) else {}
    by_no = {t.no: t for t in rec.turns}
    turns: dict[int, dict] = {}
    for r in raw.get("turns") if isinstance(raw.get("turns"), list) else []:
        no = r.get("t") if isinstance(r, dict) else None
        if type(no) is not int or no not in by_no or no in turns:
            continue
        cust, ai = _pick(r.get("cust"), CUST), _pick(r.get("ai"), AI)
        basis = r.get("basis") if r.get("basis") in BASIS else "na"
        issue = r.get("issue") if r.get("issue") in ISSUES else None
        # 근거 없는 답변은 말한 내용으로 판단(11/06 사용자): 고객이 묻지 않은 안내("결제는 기사님께")도 FAQ와 다르면 해당
        fits = {"UNGROUNDED_ANSWER": "inform" in ai and basis == "none",
                "CUSTOMER_CONFUSION": "ask_back" in cust, "FRUSTRATION": "complain" in cust}
        # 장애 구간(검색 · 조회 서버 장애)이라도 지우지 않는다 — 답을 못 한 것 자체는 모델이 문제로 보지 않고(prompt.md),
        # 장애와 상관없는 AI 잘못(통화를 끊음, 틀린 안내, 값 잘못 받음)은 남긴다(11/06 장애 장면 15곳 검수)
        if not fits.get(issue, True):
            issue = None
        if issue == "UNGROUNDED_ANSWER" and any(a in REVIEWS for _, a, _ in by_no[no].actions):
            issue = None  # FAQ 근거로 답했거나 답하지 않고 거절한 차례 (AI 서버 검토 기록)
        # 대본에 없는 근거 인용은 버린다(모델이 지어낸 문제)
        quote = " ".join(str(r.get("quote") or "").split())
        if issue and not _quoted(quote, rec, no):
            issue = None
        # 번호 자릿수 거절: 고객 말을 코드로 세서 — 분명히 틀린 번호면 AI 잘못 아님, 분명히 맞는 번호면 AI 잘못(모델이 놓쳐도)
        if not by_no[no].down and any(PHONE_REJECT in txt for _, _, txt in by_no[no].actions):
            ok = spoken_phone_ok(" ".join(u.text for u in by_no[no].utterances if u.customer))
            if ok is False and issue == "RECOGNITION_FAILURE":
                issue = None
            elif ok is True and issue is None:
                issue, r = "RECOGNITION_FAILURE", r | {"why": "맞는 번호를 자릿수가 틀렸다며 다시 물음"}
        turns[no] = {"t": no, "complain": "complain" in cust and not by_no[no].down, "cust": cust, "given": _pick(r.get("given"), FIELDS), "ai": ai,
                     "asked": _pick(r.get("asked"), FIELDS), "basis": basis, "issue": issue,
                     "why": _clean(r.get("why"), MAX_WHY) if issue else ""}
        if "quote" in r:
            turns[no]["quote"] = _clean(quote, MAX_QUOTE) if issue else ""
    c = raw.get("call") if isinstance(raw.get("call"), dict) else {}
    call = {"purposes": _pick(c.get("purposes"), PURPOSES), "goal": c.get("goal") if c.get("goal") in GOALS else None,
            "mood": c.get("mood") if c.get("mood") in MOODS else None, "summary": _clean(c.get("summary"), MAX_SUMMARY)}
    return {"turns": [turns[n] for n in sorted(turns)], "call": call, "missing": len(by_no) - len(turns)}


def _spans(a: dict) -> list[tuple[str, set[int], list[dict]]]:
    """같은 문제가 이어진 차례 묶음 [(유형, 차례 번호들, 차례들)]. 불만 한 건이 묶음 하나다."""
    spans: list[tuple[str, set[int], list[dict]]] = []
    for t in a["turns"]:
        if not t["issue"]:
            continue
        if spans and spans[-1][0] == t["issue"] and spans[-1][2][-1]["t"] == t["t"] - 1:
            spans[-1][1].add(t["t"])
            spans[-1][2].append(t)
        else:
            spans.append((t["issue"], {t["t"]}, [t]))
    return spans


def vote(analyses: list[dict], need: int) -> dict:
    """다수결: 유형이 같고 차례가 겹치는 문제 묶음이 need판 이상에서 나온 것만 남긴다(먼저 나온 판의 차례·사유).
    한 건이 여러 차례에 걸치면 판마다 표시한 차례가 조금씩 달라서, 차례 하나씩이 아니라 묶음끼리 맞춘다.
    문제 말고 다른 칸과 통화 칸은 그 차례가 있는 첫 판 것을 쓴다."""
    turns: dict[int, dict] = {}
    for a in analyses:
        for t in a["turns"]:
            turns.setdefault(t["t"], dict(t) | {"issue": None, "why": ""})
    for n, t in turns.items():  # 고객 불만 표현(complain)도 판마다 갈리므로 다수결
        t["complain"] = sum(any(x["t"] == n and x.get("complain") for x in a["turns"]) for a in analyses) >= need
    runs = [_spans(a) for a in analyses]
    kept: list[tuple[str, set[int]]] = []
    for spans in runs:
        for kind, nos, ts in spans:
            seen = sum(any(k == kind and nos & n for k, n, _ in other) for other in runs)
            if seen < need or any(k == kind and nos & n for k, n in kept):
                continue
            kept.append((kind, nos))
            for t in ts:
                if not turns[t["t"]]["issue"]:  # 한 차례에는 먼저 남긴 문제 하나만
                    turns[t["t"]].update(issue=kind, why=t["why"])
    return {"turns": [turns[n] for n in sorted(turns)], "call": analyses[0]["call"]}


async def _judge(rec: Record, client, text: str, effort: str, faqs: list[dict] | None = None) -> dict | None:
    """한 판: 모델 호출 + 검사. 실패·시간 초과면 None."""
    try:
        raw, usage = await asyncio.wait_for(call_model(client, text, effort, faqs), TIMEOUT_SEC)
    except (asyncio.TimeoutError, json.JSONDecodeError, openai.OpenAIError) as e:
        log.warning("통화 분석 한 판 실패 %s: %s", rec.session_id, type(e).__name__)
        return None
    return check(raw, rec) | {"usage": usage}


async def _confirm(rec: Record, client, kind: str, nos: set[int], effort: str, faqs: list[dict] | None):
    """장면 하나 확인 → (남길지, 토큰). 실패하면 1차 판정을 그대로 둔다(확인 못 했다고 지우지 않음)."""
    shown = set(range(min(nos) - VERIFY_CONTEXT, max(nos) + 2))
    text = f"유형: {kind}\n\n" + describe(rec, only=shown, mark=nos)
    try:
        resp = await asyncio.wait_for(client.responses.create(
            model=MODEL, instructions=instructions(faqs if kind == "UNGROUNDED_ANSWER" else None, VERIFY_PROMPT),
            input=text, reasoning={"effort": effort},
            text={"format": {"type": "json_schema", "name": "confirm", "strict": True, "schema": VERIFY_SCHEMA}},
            store=False), TIMEOUT_SEC)
        return json.loads(resp.output_text).get("verdict") != "no", _usage(resp)
    except (asyncio.TimeoutError, json.JSONDecodeError, openai.OpenAIError, AttributeError) as e:
        log.warning("장면 확인 실패 %s: %s", rec.session_id, type(e).__name__)
        return True, None


async def run(rec: Record, client, effort: str = EFFORT, votes: int = VOTES, faqs: list[dict] | None = None) -> dict | None:
    """통화 하나 분석: votes판을 동시에 판정해 다수결. 말이 없는 통화는 빈 분석.
    입력이 너무 길거나, 성공한 판이 다수결에 필요한 수보다 적으면 None(미분석)."""
    if not rec.turns:
        return {"turns": [], "call": {"purposes": [], "goal": None, "mood": None, "summary": ""}, "missing": 0,
                "ms": 0, "usage": None, "votes": 0}
    text = describe(rec)
    if len(text) > MAX_INPUT_CHARS:
        log.warning("통화 분석 안 함 %s 글자=%d", rec.session_id, len(text))
        return None
    t0, need = time.monotonic(), min(NEED, votes)
    done = [a for a in await asyncio.gather(*(_judge(rec, client, text, effort, faqs) for _ in range(votes))) if a]
    if len(done) < need:
        log.warning("통화 분석 실패 %s 성공 %d/%d판", rec.session_id, len(done), votes)
        return None
    used = [a["usage"] for a in done if a["usage"]]
    out = vote(done, need)
    scenes = [(kind, nos) for kind, nos, _ in _spans(out) if kind in VERIFY]
    checked = await asyncio.gather(*(_confirm(rec, client, kind, nos, effort, faqs) for kind, nos in scenes))
    for (kind, nos), (keep, u) in zip(scenes, checked):
        used += [u] if u else []
        if not keep:
            for t in out["turns"]:
                if t["t"] in nos and t["issue"] == kind:
                    t.update(issue=None, why="")
    usage = {k: sum(u[k] or 0 for u in used) for k in ("input", "cached", "output", "reasoning")} if used else None
    out.update(missing=len(rec.turns) - len(out["turns"]), ms=round((time.monotonic() - t0) * 1000), usage=usage,
               votes=len(done))
    log.info("통화 분석 %s 차례=%d 빠짐=%d 판=%d 문제=%s %dms 토큰=%s", rec.session_id, len(rec.turns), out["missing"],
             len(done), [t["issue"] for t in out["turns"] if t["issue"]], out["ms"], usage)
    return out
