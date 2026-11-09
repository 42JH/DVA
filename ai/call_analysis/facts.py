"""코드로 확정하는 불만(토큰 없음, 판마다 같음) — 대본 · 녹음 · AI 서버 기록에 사실로 남는 것만. 모델은 뜻을 해석해야 하는 것만 판단한다.

- 응답 지연: AI가 말할 차례의 침묵이 녹음으로 10초 이상, 또는 3초 이상이고 고객이 기다림을 드러냄("여보세요", "왜 멈췄어" …)
- 정보 인식 오류: ① 고객이 부른 번호와 AI 복창 번호가 다름 ② 인사에서 부른 이름 · 등록 출발지를 고객이 바꾸지 않았는데 다시 물음
(말 끊김은 analyze.Utterance.cut — AI 말이 문장 중간에 잘리고 고객이 바로 말함)
11/06 정답 100통화(연습 50 · 시험 50)로 맞춘 규칙. 응답 지연: 정답 28건 중 26건, 오탐 0 · 정보 인식 사실: 11건, 오탐 0.
"""

import re

from call_analysis import timing
from call_analysis.analyze import Record, _digits

WAIT_AI = re.compile(r"잠시만|확인해 ?(볼|보겠|드릴)|기다려|확인 중|확인하고 있|진행하겠|알아볼게|찾아볼게|정리해 드릴")
WAIT_CUST = re.compile(r"여보세요|멈췄|대답|들으셨|들리세요|언제까지|얼마나 걸|렉|끊긴|계세요|왜 말이 없|됐나요|됐어요\?|접수됐")
AI_HANDOFF = re.compile(r"(\?|까요|나요|가요|세요|주세요|주시겠어요|있으신가요)\W*$")  # AI 말이 질문 · 요청으로 끝나면 다음은 고객 차례
SLOW_LONG, SLOW_SHORT = 10.0, 3.0

ASK_SENDER_NAME = re.compile(r"보내(시는|는) 분 성함")
ASK_ORIGIN = re.compile(r"(보내(시)?는 곳|발송) ?주소")
ASK_VERB = re.compile(r"알려|말씀|부탁|여쭤|어떻게 되")
GREET_NAME = re.compile(r"[가-힣]{2,4} ?(고객)?님")
GREET_ORIGIN = re.compile(r"에서 보내시는")
CHANGED = re.compile(r"바꾸|바꿀|다른|변경|아니|새로")


def slow_turns(rec: Record) -> list[tuple[int, int]]:
    """응답 지연 [(앞 발화 번호, 뒤 발화 번호)]. 녹음 말소리 구간(rec.speech)이 없으면 정하지 않는다."""
    if rec.speech is None:
        return []
    us = [u for t in rec.turns for u in t.utterances]
    hits, ai_said, run = [], "", [0.0]  # ai_said = 마지막 고객 말 뒤 AI가 한 말, run = 마지막 AI 말 뒤 고객 말들 앞 침묵
    for a, b in zip(us, us[1:]):
        if not a.customer:
            ai_said += " " + a.text
        if a.offset is None or b.offset is None or b.offset < a.offset:
            continue
        audio = timing.longest_silence(rec.speech, a.offset, b.offset + 1)
        est = timing.text_gap((a.offset, a.customer, a.text), (b.offset, b.customer, b.text))
        waiting = bool(WAIT_AI.search(ai_said)) and (bool(WAIT_AI.search(a.text[-15:])) or not AI_HANDOFF.search(a.text))
        ai_turn = a.customer or not b.customer or waiting
        if b.customer:
            run = (run if a.customer else []) + [max(audio, est)]
        if ai_turn and (audio >= SLOW_LONG
                        or b.customer and WAIT_CUST.search(b.text) and max(run) >= SLOW_SHORT):
            hits.append((a.order, b.order))
        if b.customer:
            ai_said = ""
    return hits


def _phone(text: str) -> str | None:
    """말 속의 마지막 번호(0으로 시작하는 9자리 이상)."""
    runs, cur = [], ""
    for tok in re.split(r"[\s,.·\-]+", text):
        d = _digits(tok) if tok else None
        if d:
            cur += d
        elif cur:
            runs.append(cur)
            cur = ""
    runs.append(cur)
    runs = [r for r in runs if len(r) >= 9 and r.startswith("0")]
    return runs[-1] if runs else None


def info_errors(rec: Record) -> list[tuple[int, int, str]]:
    """정보 인식 오류 [(발화 번호, 끝 발화 번호, 사유)]."""
    us = [u for t in rec.turns for u in t.utterances]
    out = []
    for i, u in enumerate(us):  # ① 번호 복창 불일치. '천사'처럼 자리 말이 섞이면 세지 않음
        said = _phone(u.text) if u.customer and not any(w in u.text for w in "십백천만") else None
        if not said:
            continue
        for v in us[i + 1:i + 4]:
            if v.customer:
                break
            back = _phone(v.text)
            if back and not (back.startswith(said) or said.startswith(back)):  # 한쪽이 앞부분이면 덜 읽힌 것
                out.append((u.order, v.order, "고객이 부른 번호와 다르게 복창함"))
                break
    first = us[0] if us and not us[0].customer else None
    reply = " ".join(x.text for x in rec.turns[1].utterances if x.customer) if len(rec.turns) > 1 else ""
    for ask, known, why in ((ASK_SENDER_NAME, first and GREET_NAME.search(first.text), "인사에서 부른 이름을 다시 물음"),
                            (ASK_ORIGIN, first and GREET_ORIGIN.search(first.text), "인사에서 말한 등록 출발지를 다시 물음")):
        if not known:
            continue
        for k, u in enumerate(us[1:], 1):  # ② 고객이 인사에 대한 첫 대답이나 바로 앞에서 바꾸겠다고 하지 않았는데 다시 물음
            before = reply + " " + " ".join(x.text for x in us[max(0, k - 2):k] if x.customer)
            if (not u.customer and ask.search(u.text) and ASK_VERB.search(u.text) and "성함은" not in u.text
                    and not CHANGED.search(before)):
                out.append((u.order, u.order, why))
                break
    return out
