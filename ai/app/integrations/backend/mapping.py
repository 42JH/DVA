"""도메인 결과(Outcome) → BE 통화 결과 본문. BE 필드 이름은 backend_client.api.result_body 한 곳에만 있다(overview.md §7).

도메인 스냅샷(app/domain/state.py draft_snapshot 모양) → backend_client.order.Order → result_body.
"""

from app.domain.outcome import Outcome
from app.domain.state import Geo, Items
from backend_client.api import result_body
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
