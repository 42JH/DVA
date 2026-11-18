"""발신번호·인증 헤더·시각 처리. SIP 헤더와 PBX 본문의 발신번호는 미신뢰 값이다(인증 근거로 쓰지 않는다)."""

import hmac
import re
from datetime import datetime, timezone
from typing import Any

MAX_CALLER_DIGITS = 15


def caller_from_headers(headers: list[Any]) -> str | None:
    """SIP From 헤더에서 발신번호를 뽑는다. 숫자만, +82 → 0, 길이 제한."""
    for h in headers:
        if h.name.lower() in ("from", "f"):
            m = re.search(r"sips?:([^@;>]+)", h.value)
            if not m:
                return None
            return normalize_caller(m.group(1))
    return None


def normalize_caller(value: str) -> str | None:
    """미신뢰 전화번호: 숫자만, +82 → 0, 길이 제한. 자릿수 검사는 하지 않는다(통화를 찾는 데만 쓴다)."""
    value = value.strip()
    if value.startswith("+82"):
        value = "0" + value[3:]
    return re.sub(r"\D", "", value)[:MAX_CALLER_DIGITS] or None


def mask_phone(phone: str | None) -> str:
    if not phone:
        return "알 수 없음"
    return phone[:3] + "*" * max(len(phone) - 7, 0) + phone[-4:] if len(phone) > 7 else "*" * len(phone)


def iso_utc(ts: int | float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def token_ok(secret: str, authorization: str | None) -> bool:
    """Authorization: Bearer <secret>. 상수 시간 비교."""
    scheme, _, token = (authorization or "").partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(token.strip().encode(), secret.encode())
