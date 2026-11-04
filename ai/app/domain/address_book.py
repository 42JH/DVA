"""되읽기 때 주소 저장 제안(업무 규칙 g, BE 계약 backend/docs/ai-call-follow-up.md "고객 기본 주소와 개인 PIN 저장").

BE: 주문 저장은 고객 기본 주소·PIN을 자동 갱신하지 않는다. AI가 고객 동의를 받은 경우에만 저장한다.
- 보내는 곳: 등록 고객이고 확정 주소(지번·우편번호 포함)가 고객 기본 주소와 다르면 기본 주소로 저장 제안
- 받는 곳: 주소록·이전 주문에서 고른 곳이 아니고 확정 주소면 주소록 추가 제안
shortcut: 주소록에서 고른 받는 곳을 고친 경우는 새 PIN으로 추가한다(PIN 번호를 지금 들고 있지 않음) — 기존 PIN 수정이 필요하면 PIN 번호를 Place에 싣는다.
"""

from app.domain.state import ConversationState, FieldStatus, Source


def save_offer(state: ConversationState) -> dict:
    c, cur = state.customer, state.current
    if not c.customer_seq or cur is None:
        return {}
    out = {}
    sa = cur["sender_address"]
    if sa.valid and cur.sender_geo and sa.value != c.default_address:
        out["sender"] = True
    ra = cur["receiver_address"]
    if ra.valid and cur.receiver_geo and ra.source not in (Source.PIN, Source.HISTORY, Source.COMPANY):
        out["receiver"] = True
    return out


def prefill_sender(state: ConversationState, full: bool) -> list[str]:
    """기존 고객의 보내는 분을 등록 정보로 채운다(Source.PROFILE). full = 출발지 후보에서 보낸다고 함(주소·상세까지),
    아니면 성함만. 고객이 이미 말한 항목은 덮지 않는다. 채운 항목 이름."""
    c = state.customer
    place = c.origin_place
    values = {"sender_name": c.name}
    if full and place:
        values |= {"sender_address": place.address, "sender_address_detail": place.address_detail or ""}
    done = []
    for name, value in values.items():
        if value is None:
            continue
        f = state.field_of(name)
        if f.status == FieldStatus.EMPTY:
            state.record(name, value, Source.PROFILE)
            done.append(name)
    if "sender_address" in done:
        state.current.sender_geo = place.geo
    return done
