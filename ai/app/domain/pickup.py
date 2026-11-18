"""수거 요청 시각(업무 규칙 a, BE 계약 backend/docs/ai-call-follow-up.md "확정한 수거 시각 정책").

- 기본: 지금 + 최소 준비 시간(1시간, 10분 단위 올림). 영업 시작 전이면 그날 시작 시각, 영업 끝을 넘으면 다음 날 기본 시각
  (`today_unavailable` — "금일 수거는 어렵고 익일 수거 가능").
- 고객 조정: 지금 + 준비 시간 이후, 영업 시간 안(끝 시각 정각 허용), 현재부터 max_days_ahead일 이내.
- BE는 시간대 포함 ISO 8601만 확인하고 보존한다(결제가 늦으면 BE가 결제 + 1시간을 09~17시로 맞춤). 주말·공휴일 구분 없음.
"""

from dataclasses import dataclass
from datetime import datetime, time, timedelta

from app.domain.rules import KST


@dataclass(frozen=True)
class PickupRule:
    min_lead_minutes: int
    open: time
    close: time
    max_days_ahead: int
    next_day_default: time


def rule_of(p) -> PickupRule:
    """정책 [pickup](문자열 "HH:MM") → 규칙."""
    t = lambda s: time.fromisoformat(s)  # noqa: E731
    return PickupRule(p.min_lead_minutes, t(p.open), t(p.close), p.max_days_ahead, t(p.next_day_default))


def default_pickup(now: datetime, r: PickupRule) -> tuple[str, bool]:
    """(한국 시간 ISO 8601, 오늘 수거 불가로 다음 날로 넘겼는지)."""
    at = now.astimezone(KST) + timedelta(minutes=r.min_lead_minutes)
    if at.second or at.microsecond:
        at += timedelta(minutes=1)
    at = at.replace(second=0, microsecond=0)
    if at.minute % 10:
        at += timedelta(minutes=10 - at.minute % 10)
    moved = False
    if at.time() < r.open:
        at = at.replace(hour=r.open.hour, minute=r.open.minute)
    elif at.time() > r.close:
        at = (at + timedelta(days=1)).replace(hour=r.next_day_default.hour, minute=r.next_day_default.minute)
        moved = True
    return at.isoformat(timespec="seconds"), moved


def check_pickup(iso: str, now: datetime, r: PickupRule) -> str | None:
    """고객이 고른 시각의 거절 사유 코드. 괜찮으면 None. iso는 parse_pickup을 통과한 값."""
    at = datetime.fromisoformat(iso).astimezone(KST)
    now = now.astimezone(KST)
    if at < now + timedelta(minutes=r.min_lead_minutes):
        return "PICKUP_TOO_SOON"
    if not (r.open <= at.time() <= r.close):
        return "PICKUP_OUT_OF_HOURS"
    if at > now + timedelta(days=r.max_days_ahead):
        return "PICKUP_TOO_FAR"
    return None


def describe(r: PickupRule) -> str:
    """거절 때 고객에게 안내할 허용 범위(사실)."""
    return (f"{r.open:%H:%M}~{r.close:%H:%M} 사이, 지금부터 최소 {r.min_lead_minutes}분 이후, "
            f"현재 시각부터 최대 {r.max_days_ahead}일({r.max_days_ahead * 24}시간) 이내")
