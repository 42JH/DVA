"""전화번호와 수거 시각의 입력 검증 규칙."""

import re
import unicodedata
from datetime import datetime, timedelta, timezone

from app.policy.model import Phone, load_policy

KST = timezone(timedelta(hours=9))

_KOREAN_DIGITS = {"공": "0", "영": "0", "빵": "0", "일": "1", "이": "2", "삼": "3", "사": "4",
                  "오": "5", "육": "6", "륙": "6", "칠": "7", "팔": "8", "구": "9"}
# 고유어 숫자("공일공삼 하나하나오오…", 2026-11-01 23:09 통화). 한 글자 숫자보다 먼저 바꾼다("일곱"의 "일")
_NATIVE_DIGITS = {"하나": "1", "다섯": "5", "여섯": "6", "일곱": "7", "여덟": "8", "아홉": "9",
                  "둘": "2", "셋": "3", "넷": "4"}
_NATIVE_PATTERN = re.compile("|".join(r"\s*".join(word) for word in _NATIVE_DIGITS))
_PHONE_ENDING = re.compile(r"(?:입니다|예요|에요|요)$")
_AMBIGUOUS_PHONE_ENDING = re.compile(r"이(?:요|에요)$")
_LAST_FOUR = re.compile(r"^(?:끝|마지막|뒤)\s*(?:네|넷|사|4)\s*자리(?:만|는|가)?\s*[:：]?\s*")
_PHONE_SEPARATORS = re.compile(r"[\s(),.에\-‐‑–—]+")


def normalize_phone(raw: str, rule: Phone | None = None) -> str | None:
    """형식에 맞는 해석이 하나일 때만 전체 번호를 반환한다."""
    phone, _, _ = resolve_phone(raw, rule if rule is not None else load_policy().phone)
    return phone


def resolve_phone(raw: str, rule: Phone, previous: str | None = None) -> tuple[str | None, str | None, bool]:
    """(번호, 오류 코드, 끝 네 자리 재질문 가능 여부). 부분 정정은 기존 번호가 필요하다."""
    raw = _phone_text(raw)
    scope = _LAST_FOUR.match(raw)
    prefix = ""
    if scope:
        if not previous or len(previous) <= 4 or not rule.accepts_recipient(previous):
            return None, "PHONE_INVALID_DIGITS", False
        prefix = previous[:-4]
        raw = raw[scope.end():]
    ending = _PHONE_ENDING.search(raw)
    number = raw[:ending.start()].rstrip() if ending else raw
    # '사팔팔이요'는 '4882 + 요'와 '488 + 이요'가 같은 글자로 적힌다.
    readings = (number, number[:-1]) if _AMBIGUOUS_PHONE_ENDING.search(raw) else (number,)
    candidates = set()
    for reading in readings:
        digits = _phone_digits(reading, international=not scope)
        if digits and (not scope or len(digits) == 4) and rule.accepts_recipient(prefix + digits):
            candidates.add(prefix + digits)
    if len(candidates) == 1:
        return candidates.pop(), None, False
    return None, "PHONE_AMBIGUOUS" if candidates else "PHONE_INVALID_DIGITS", bool(prefix)


def restore_phone_ending(raw: str, transcript: str) -> str:
    """같은 발화에서 말끝만 다르면 두 해석이 남은 전사를 검증기에 넘긴다."""
    heard = _phone_text(transcript)
    ending = _AMBIGUOUS_PHONE_ENDING.search(heard)
    if ending:
        digits = _phone_digits(_phone_text(raw), international=True)
        before_ending = _phone_digits(heard[:ending.start()], international=True)
        if before_ending and digits in (before_ending, before_ending + "2"):
            return heard
    return raw


def _phone_text(raw: str) -> str:
    return unicodedata.normalize("NFKC", raw).strip().rstrip(".!?").rstrip()


def _phone_digits(raw: str, *, international: bool) -> str | None:
    raw = _NATIVE_PATTERN.sub(lambda match: _NATIVE_DIGITS["".join(match[0].split())], raw)
    digits = _PHONE_SEPARATORS.sub("", "".join(_KOREAN_DIGITS.get(ch, ch) for ch in raw))
    if international and digits.startswith("+82"):
        digits = "0" + digits[3:]
    return digits if re.fullmatch(r"[0-9]+", digits) else None


def parse_pickup(raw: str, now: datetime, min_lead_minutes: int) -> tuple[str | None, str | None]:
    """(한국 시간 ISO 8601, None) 또는 (None, 사유 코드). 모델이 만든 시각은 미신뢰 입력: 시간대 필수."""
    try:
        at = datetime.fromisoformat(raw.strip())
    except ValueError:
        return None, "PICKUP_INVALID_FORMAT"
    if at.tzinfo is None:
        return None, "PICKUP_INVALID_FORMAT"
    if at <= now:
        return None, "PICKUP_IN_PAST"
    if at < now + timedelta(minutes=min_lead_minutes):
        return None, "PICKUP_TOO_SOON"
    return at.astimezone(KST).isoformat(timespec="seconds"), None
