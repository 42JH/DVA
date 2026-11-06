"""통화 결과 결정(conversation-state.md §7). BE 본문 생성은 app/integrations/backend/mapping.py(계약 격리).

COMPLETE 필수(spec/ai-integration-current.md §3): 고객, 결제 방식(고른 값 — 기본 billing 금지), 택배 ≥1, 택배마다 주소
필수·geo(지번·동명·우편번호), 물품, 물품 가액, 양의 배송비. 수거 시각은 보내지 않는다(BE가 결제 완료 + 1시간으로 정함).
하나라도 없으면 INCOMPLETE(아는 값만). 무의미 통화는 보내지 않는다.
배송비는 요금표(fare_of = config [fare], app/domain/fare.py)가 정한다. 모르면 COMPLETE가 되지 않는다.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from app.domain.assess import assess
from app.domain.state import ConversationState, draft_snapshot
from app.domain.store import item_issues_pending, snapshot_for_submit
from app.policy.model import Policy

ADDRESS_REQUIRED = ("sender_name", "sender_phone", "sender_address", "receiver_name", "receiver_phone",
                    "receiver_address")


@dataclass(frozen=True)
class Outcome:
    kind: Literal["COMPLETE", "INCOMPLETE", "CANCELLED"] | None   # None = 보내지 않음
    parcels: tuple[dict, ...] = ()
    fares: tuple[int | None, ...] = ()
    payment: str | None = None
    pickup_at: str | None = None        # 수거 요청 시각(되읽기 때 기본값·고객 조정, BE가 보존 — ai-call-follow-up.md)
    reasons: tuple[str, ...] = ()       # COMPLETE가 아닌 이유(관측·운영자 보완용)
    customer_name: str | None = None    # 미등록 고객 이름 = 보내는 분 성함(MVP: 고객 = 보내는 분, 원본 규칙)


def _parcel_gaps(p: dict) -> list[str]:
    gaps = [f"MISSING_{f.upper()}" for f in ADDRESS_REQUIRED if not p.get(f)]
    if p.get("sender_address_detail") is None or p.get("receiver_address_detail") is None:
        gaps.append("MISSING_ADDRESS_DETAIL")
    if not (p.get("items") and p["items"].any()):
        gaps.append("MISSING_ITEMS")
    if p.get("item_price") is None:
        gaps.append("MISSING_ITEM_PRICE")
    if p.get("sender_geo") is None or p.get("receiver_geo") is None:
        gaps.append("ADDRESS_GEO_MISSING")
    return gaps


def decide_outcome(state: ConversationState, policy: Policy, now: datetime,
                   fare_of: Callable[[dict], int | None]) -> Outcome:
    has_current = state.current is not None and not state.current.empty()
    if state.intent is None and not state.parcels and not has_current:
        return Outcome(None)  # 무의미 통화: 등록·전송하지 않는다(empty-ai-order-results.md)
    a = assess(state, policy)
    payment = state.payment.value if state.payment.valid else a.payment_auto
    pickup = state.pickup_at.value if state.pickup_at.valid else None
    submit = snapshot_for_submit(state)
    current = (draft_snapshot(state.current),) if has_current and not state.current.item_issues else ()
    name = state.customer.name or next((p.get("sender_name") for p in (*submit, *current) if p.get("sender_name")), None)

    if state.order_cancelled:
        return Outcome("CANCELLED", tuple(submit) + current, payment=payment, customer_name=name)
    if not submit:  # 담은 택배 없음: 받던 값만(없으면 빈 결과 → BE NO_ORDER)
        # 받던 값도 없으면 결제 방식·수거 시각도 넣지 않는다 — BE는 paymentMethodType 하나만 있어도 주문 정보로 보고
        # COLLECTING 주문을 만든다(empty-ai-order-results.md, 운영 통화 3a0b9c7f orderSeq 59)
        reason = "ITEM_VALIDATION_PENDING" if item_issues_pending(state) else "NO_CONFIRMED_PARCEL"
        return Outcome("INCOMPLETE", current, payment=payment if current else None, reasons=(reason,),
                       customer_name=name)

    fares = tuple(fare_of(p) for p in submit)
    reasons = [g for p in submit for g in _parcel_gaps(p)]
    if item_issues_pending(state):
        reasons.append("ITEM_VALIDATION_PENDING")
    if any(f is None or f <= 0 for f in fares):
        reasons.append("FARE_UNKNOWN")
    if not payment:
        reasons.append("PAYMENT_UNKNOWN")
    if state.customer.customer_seq is None and not name:
        reasons.append("CUSTOMER_UNKNOWN")
    if state.agent_transferred:
        reasons.append("AGENT_TRANSFER")
    kind = "INCOMPLETE" if reasons else "COMPLETE"
    return Outcome(kind, tuple(submit), fares, payment, pickup, tuple(dict.fromkeys(reasons)), name)
