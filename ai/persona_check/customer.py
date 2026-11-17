"""시험 통화의 가짜 고객: 대본(정해진 발화 목록)에서 지금 할 말을 고른다.

AI 파트 시나리오는 고객 발화를 순서대로 적어 둔다. 그대로 순서대로 틀면 AI가 예상과 다른 것을 물을 때 어긋나고,
LLM이 자유롭게 말하면 판마다 말이 달라진다. 그래서 말은 대본 문장 그대로, 고르는 것만 모델이 한다.
고른 결과는 정해진 칸(SCHEMA)이라 통화마다 같은 음성을 다시 쓸 수 있다(문장별 TTS를 한 번만 만든다).

실시간 통화 코드(app/)와 무관하다. 표준 라이브러리만 쓰고, 모델 호출은 넘겨받은 client로 한다.
"""

import asyncio
import json
import re
from pathlib import Path

MODEL, EFFORT = "gpt-6-luna", "low"
PROMPT = Path(__file__).with_name("customer.md")
ACTIONS = ("say", "short", "free", "wait", "end")
# 대본에 없는 짧은 답 · 오래 조용할 때 부르는 말
SHORT = {"yes": "네", "no": "아니요, 없어요", "unknown": "잘 모르겠어요", "hello": "여보세요?"}
MAX_FREE = 40  # 대본 밖 말은 짧게만
TIMEOUT_SEC = 30.0  # 고르는 동안에도 음성 세션은 돈다 — 멈춘 호출을 오래 기다리지 않는다

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["action", "index", "short", "text", "why"],
          "properties": {"action": {"type": "string", "enum": list(ACTIONS)},
                         "index": {"type": "integer"},                                   # say: 대본 번호(1부터)
                         "short": {"type": "string", "enum": ["", *SHORT]},              # short: 답 종류
                         "text": {"type": "string"},                                     # free: 말할 문장
                         "why": {"type": "string"}}}


def describe(script: list[str], history: list[tuple[str, str]], said: set[int], facts: str = "") -> str:
    lines = [f"{i}. {'(말함) ' if i in said else ''}{text}" for i, text in enumerate(script, 1)]
    talk = [f"{who}: {text}" for who, text in history] or ["(아직 대화 없음)"]
    known = f"[고객 정보]\n{facts}\n\n" if facts else ""
    return known + "[대본]\n" + "\n".join(lines) + "\n\n[지금까지 통화]\n" + "\n".join(talk)


def check(raw, script: list[str]) -> dict:
    """모델 답을 실행할 수 있는 행동으로. 틀린 번호 · 빈 말은 wait(아무 말 안 함)로 떨어뜨린다 — 대본에 없는 말을 지어내지 않게."""
    action = raw.get("action") if isinstance(raw, dict) else None
    why = str((raw or {}).get("why") or "")[:120] if isinstance(raw, dict) else ""
    if action == "say" and type(raw.get("index")) is int and 1 <= raw["index"] <= len(script):
        return {"action": "say", "index": raw["index"], "text": script[raw["index"] - 1], "why": why}
    if action == "short" and raw.get("short") in SHORT:
        return {"action": "short", "short": raw["short"], "text": SHORT[raw["short"]], "why": why}
    if action == "free" and str(raw.get("text") or "").strip():
        return {"action": "free", "text": " ".join(str(raw["text"]).split())[:MAX_FREE], "why": why}
    if action == "end":
        return {"action": "end", "text": "", "why": why}
    return {"action": "wait", "text": "", "why": why}


async def choose(client, script: list[str], history: list[tuple[str, str]], said: set[int], facts: str = "") -> dict:
    """고객이 지금 할 행동. history = [(AI|고객, 말)], said = 이미 말한 대본 번호, facts = 고객이 아는 자기 정보(등록 이름 · 주소)."""
    resp = await asyncio.wait_for(client.responses.create(
        model=MODEL, instructions=PROMPT.read_text("utf-8"), input=describe(script, history, said, facts),
        reasoning={"effort": EFFORT},
        text={"format": {"type": "json_schema", "name": "customer_turn", "strict": True, "schema": SCHEMA}}), TIMEOUT_SEC)
    return check(json.loads(resp.output_text), script)


# --- 소리 내어 읽을 글: TTS는 숫자를 영어나 엉뚱한 한국어로 읽는다("102동 1503호" → "원 헌드레드 투 동…", 11/11 통화) ---
DIGITS = "영일이삼사오육칠팔구"
PHONE = re.compile(r"0\d{1,2}-\d{3,4}-\d{4}|\d{9,}")
NUMBER = re.compile(r"\d+")


def read_number(n: int) -> str:
    """한자어 읽기(212 → 이백십이, 1503 → 천오백삼, 50000 → 오만, 200000000 → 이억)."""
    if n == 0:
        return "영"
    out, groups = "", []
    while n:
        n, group = divmod(n, 10000)
        groups.append(group)
    for group, unit in reversed(list(zip(groups, ("", "만", "억", "조", "경"), strict=False))):
        part = ""
        for power, name in ((1000, "천"), (100, "백"), (10, "십"), (1, "")):
            d = group // power % 10
            if d:
                part += ("" if d == 1 and name else DIGITS[d]) + name
        if part:
            out += ("" if part == "일" and unit == "만" else part) + unit
    return out


def spoken(text: str) -> str:
    """고객 문장을 TTS가 읽을 글로: 전화번호는 한 자리씩("공일공 이삼사오 육칠팔구"), 나머지 숫자는 한자어로, 번지의 "-"는 "다시"."""
    def phone(m):
        return " ".join("".join("공" if c == "0" else DIGITS[int(c)] for c in group) for group in re.split(r"-", m.group()))
    text = PHONE.sub(phone, text)
    text = re.sub(r"(\d)-(\d)", r"\1 다시 \2", text)
    text = re.sub(r"(\d+)(?=[만억조])", lambda m: read_number(int(m.group())), text)  # "5만" → "오만"(띄우면 "오"를 군말로 듣는다)
    return NUMBER.sub(lambda m: read_number(int(m.group())) + " ", text).replace("  ", " ").replace(" ,", ",").strip()
