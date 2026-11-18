"""AI 발화 값 대조(측정용, 대화는 바꾸지 않음)."""

import re

from app.address.numbers import korean_to_int
from app.domain.state import ConversationState, Place

# --- 값 대조(측정용, 대화는 바꾸지 않음) ---
# AI가 말한 전화번호·호수가 서버가 아는 값(진행 중 택배·후보·담은 택배·확인 대기·고른 조회 주문)에 없으면 기록한다.
# Live가 기억으로 답하거나 잘못 읽은 비율을 재려는 것. shortcut: "공일공에 일이삼사"처럼 숫자 사이에 조사가 끼면 놓친다 —
# 실통화 전사를 보고 구분자를 늘린다. 고객이 방금 말해 아직 기록 전인 값을 따라 말한 경우도 불일치로 잡힌다.

_DIGIT = {**{str(i): str(i) for i in range(10)}, "영": "0", "공": "0", "일": "1", "이": "2", "삼": "3", "사": "4",
          "오": "5", "육": "6", "륙": "6", "칠": "7", "팔": "8", "구": "9"}
_DIGIT_RUN = re.compile(r"[0-9영공일이삼사오육륙칠팔구][0-9영공일이삼사오육륙칠팔구\s\-,.]*")
_HO = re.compile(r"([0-9영공일이삼사오육륙칠팔구십백천]+)\s*호(?!선)")


def _digits(run: str) -> str:
    return "".join(_DIGIT[c] for c in run if c in _DIGIT)


def _phones(text: str) -> list[str]:
    """10자리 이상 이어 읽은 0으로 시작하는 숫자열(한 자리씩 읽은 한글 포함)."""
    out = []
    for m in _DIGIT_RUN.finditer(text):
        d = _digits(m[0])
        if "0" in d and len(d[d.index("0"):]) >= 10:
            out.append(d[d.index("0"):])
    return out


def _ho_numbers(text: str) -> set[int]:
    out = set()
    for m in _HO.finditer(text):
        if len(m[1]) == 1 and not m[1].isdigit():  # "삼호동"·"오호"처럼 한 글자 한글은 호수로 보지 않는다
            continue
        try:
            out.add(korean_to_int(m[1]))
        except (KeyError, ValueError):
            continue
    return out


def _known_texts(state: ConversationState) -> list[str]:
    def walk(v):
        if isinstance(v, str):
            yield v
        elif isinstance(v, dict):
            for x in v.values():
                yield from walk(x)
        elif isinstance(v, (list, tuple)):
            for x in v:
                yield from walk(x)
        elif isinstance(v, Place):
            yield from (v.phone or "", v.address or "", v.address_detail or "")
    drafts = ([state.current] if state.current else []) + [p.draft for p in state.parcels]
    out = [f.value for d in drafts for f in d.fields.values() if isinstance(f.value, str)]
    out += list(walk(state.candidates.items if state.candidates else ()))
    out += list(walk(state.pending.snapshot if state.pending else {}))
    out += list(walk(state.selected_order or {}))
    out.append(state.customer.caller_phone or "")
    return out


def unverified_values(text: str, state: ConversationState) -> dict:
    """AI 발화의 전화번호·호수 중 서버 값에 없는 것: {"phone": [가린 번호], "ho": 개수}. 없으면 빈 dict.
    호수 값은 로그에 남기지 않는다(상세주소)."""
    known = _known_texts(state)
    known_digits = [_digits(k) for k in known if k]
    known_ho = set().union(*(_ho_numbers(k) for k in known)) if known else set()
    out: dict = {}
    phones = [p for p in _phones(text) if not any(len(k) >= 10 and k in p for k in known_digits)]
    if phones:
        out["phone"] = [p[:3] + "*" * (len(p) - 7) + p[-4:] for p in phones]
    if ho := _ho_numbers(text) - known_ho:
        out["ho"] = len(ho)
    return out
