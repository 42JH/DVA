"""도메인 결과(Outcome) → BE 통화 결과 본문. BE 필드 이름은 backend_client.api.result_body 한 곳에만 있다(overview.md §7).

도메인 스냅샷(app/domain/state.py draft_snapshot 모양) → backend_client.order.Order → result_body.
"""

from app.domain.outcome import Outcome
from app.domain.state import Geo, Items, ResumeCandidate
from backend_client.api import detail_order, result_body, resume_body
from backend_client.order import Geo as BackendGeo
from backend_client.order import Order

_TEXT = ("sender_name", "sender_phone", "sender_address", "sender_address_detail",
         "receiver_name", "receiver_phone", "receiver_address", "receiver_address_detail")


def _geo(g: Geo | None) -> BackendGeo | None:
    return BackendGeo(jibun_address=g.jibun_address, dong_name=g.dong_name, postal_code=g.postal_code) if g else None


def to_order(snapshot: dict) -> Order:
    items: Items | None = snapshot.get("items")
    values = {f: snapshot.get(f) for f in _TEXT}
    if items:
        values |= {"document_count": items.document_count or None, "small_box_count": items.small_box_count or None,
                   "medium_box_count": items.medium_box_count or None, "big_box_count": items.big_box_count or None,
                   "other_item": items.other_item}
    return Order(**values, item_price=snapshot.get("item_price"), client_comment=snapshot.get("client_comment"),
                 sender_geo=_geo(snapshot.get("sender_geo")), receiver_geo=_geo(snapshot.get("receiver_geo")))


def submit_body(outcome: Outcome, call: dict, customer_seq: int | None, customer_name: str | None,
                caller: str) -> dict:
    """call = {providerCallId, callerPhoneNumber, incomingAt}. outcome.kind가 None이면 부르지 않는다.
    customer_name이 없으면 outcome.customer_name(보내는 분 성함). 기존 고객은 customerSeq만(둘을 함께 보내지 않는다)."""
    if outcome.kind is None:
        raise ValueError("보내지 않는 통화(무의미)")
    fares = list(outcome.fares) if outcome.fares and len(outcome.fares) == len(outcome.parcels) else None
    customer_name = customer_name or outcome.customer_name
    return result_body(outcome.kind, call, customer_seq, customer_name, caller, outcome.payment, outcome.pickup_at,
                       [to_order(p) for p in outcome.parcels], fares)


def from_order(order: Order) -> dict:
    """BE 택배(Order) → 도메인 스냅샷(draft_snapshot 모양). 없는 값은 넣지 않는다."""
    out = {f: getattr(order, f) for f in _TEXT if getattr(order, f) is not None}
    counts = {f: getattr(order, f) or 0 for f in ("document_count", "small_box_count", "medium_box_count", "big_box_count")}
    items = Items(**counts, other_item=order.other_item)
    if items.any():
        out["items"] = items
    if order.item_price is not None:
        out["item_price"] = order.item_price
    for role in ("sender", "receiver"):
        g = getattr(order, f"{role}_geo")
        out[f"{role}_geo"] = Geo(g.jibun_address, g.dong_name, g.postal_code) if g else None
    out["client_comment"] = order.client_comment
    return out


def resume_candidate(detail: dict) -> ResumeCandidate | None:
    """미완료 주문 상세 → 이어받기 후보. 미취소 상세 중 가장 최근(번호가 가장 큰) 1건만 불러온다(사용자 결정 2026-11-06)."""
    if detail.get("status") != "COLLECTING":
        return None
    active = [p for p in detail.get("parcels") or [] if p.get("status") != "CANCELLED"]
    if not active:
        return None
    latest = max(active, key=lambda p: p["orderParcelSeq"])
    return ResumeCandidate(order_seq=detail["orderSeq"], version=detail["version"], created_at=detail["createdAt"],
                           parcel_seq=latest["orderParcelSeq"], parcel=from_order(detail_order(latest)),
                           other_fares=tuple(p.get("notifiedPrice") for p in active if p is not latest),
                           payment=detail.get("paymentMethodType"), pickup_at=detail.get("pickupRequestedAt"),
                           parcel_seqs=tuple(p["orderParcelSeq"] for p in detail.get("parcels") or []))


def resume_target(outcome: Outcome, cand: ResumeCandidate, call_session_seq: int) -> dict:
    """이어받은 통화의 결과 → 아웃박스에 남기는 목표 상태(재시작 뒤에도 이것만으로 PATCH·확정·취소를 다시 맞춘다).
    합계는 이 통화 택배 배송비 + 같은 주문의 다른 상세 배송비를 모두 알 때만 넣는다(BE가 확정 때 일치를 검사한다).
    확정(submit)은 COMPLETE이고 합계가 있을 때만. CANCELLED면 이어받은 상세만 취소한다."""
    out = {"orderSeq": cand.order_seq, "callSessionSeq": call_session_seq, "baseSeqs": list(cand.parcel_seqs),
           "target": {}, "submit": False, "cancel": None, "onlyParcel": not cand.other_fares}
    if outcome.kind == "CANCELLED":
        return out | {"cancel": cand.parcel_seq}
    fares = list(outcome.fares) if len(outcome.fares) == len(outcome.parcels) else [None] * len(outcome.parcels)
    parcels = [(to_order(p), f, p.get("order_parcel_seq")) for p, f in zip(outcome.parcels, fares)]
    every = fares + list(cand.other_fares)
    total = sum(every) if every and all(isinstance(f, int) and f > 0 for f in every) else None
    target = resume_body(parcels, outcome.payment, outcome.pickup_at, total)
    return out | {"target": target, "submit": outcome.kind == "COMPLETE" and "totalAmount" in target}
