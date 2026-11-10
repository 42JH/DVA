"""값 검증 규칙(순수). 전화번호는 한글 숫자 정규화 뒤 BE 계약대로 0으로 시작하는 정확히 11자리,
수거 시각은 P1(현재 + 1시간 이후, decisions.md)."""

import re
from datetime import datetime, timedelta, timezone

from app.policy.model import Phone, load_policy

KST = timezone(timedelta(hours=9))

_KOREAN_DIGITS = {"공": "0", "영": "0", "빵": "0", "일": "1", "이": "2", "삼": "3", "사": "4",
                  "오": "5", "육": "6", "륙": "6", "칠": "7", "팔": "8", "구": "9"}
# 고유어 숫자("공일공삼 하나하나오오…", 2026-11-01 23:09 통화). 한 글자 숫자보다 먼저 바꾼다("일곱"의 "일")
_NATIVE_DIGITS = {"하나": "1", "다섯": "5", "여섯": "6", "일곱": "7", "여덟": "8", "아홉": "9",
                  "둘": "2", "셋": "3", "넷": "4"}


def normalize_phone(raw: str, rule: Phone | None = None) -> str | None:
    """한글 숫자·기호를 숫자만으로 바꾸고 자릿수를 검사한다. 틀리면 None(저장하지 않는다)."""
    rule = rule if rule is not None else load_policy().phone
    for word, digit in _NATIVE_DIGITS.items():
        raw = raw.replace(word, digit)
    s = "".join(_KOREAN_DIGITS.get(ch, ch) for ch in raw).strip()
    if s.startswith("+82"):
        s = "0" + s[3:].lstrip(" -")
    digits = re.sub(r"\D", "", s)
    # BE는 정확히 11자리만 받는다. 예전의 9~10자리 국내번호 허용은 모델이 한 자리 빠뜨린 휴대전화 정정
    # ("010 1234 4155" → "0112344155")을 유선번호로 통과시켰다(2026-11-05 통화, S15P31D109-170)
    return digits if len(digits) == rule.digits and digits.startswith("0") else None


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
