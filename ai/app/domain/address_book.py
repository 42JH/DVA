"""되읽기 때 고객 정보·주소 저장 대상(업무 규칙 g, BE 계약 backend/docs/ai-call-follow-up.md "고객 기본 주소와 개인 PIN 저장").

BE: 주문 저장은 고객 정보·PIN을 자동 갱신하지 않는다. AI가 택배를 담을 때 묻지 않고 저장한다(사용자 결정 2026-11-06).
- 성함: 등록 고객이고 보내는 분 성함이 등록 이름과 다르면 고객 이름 갱신. 이번 택배용 성함은 제외
- 보내는 곳: 등록 고객이고 확정 주소(지번·우편번호 포함)가 고객 기본 주소와 다르면 기본 주소 갱신
- 받는 곳: 주소록·이전 주문에서 고른 곳이 아니고 확정 주소면 주소록 추가
shortcut: 주소록에서 고른 받는 곳을 고친 경우는 새 PIN으로 추가한다(PIN 번호를 지금 들고 있지 않음) — 기존 PIN 수정이 필요하면 PIN 번호를 Place에 싣는다.
"""

from app.domain.state import ConversationState, FieldStatus, Source


def sender_change_next(state: ConversationState) -> str | None:
    draft = state.current
    if state.intent != "order" or draft is None:
        return None
    if draft.sender_name_for_parcel and not draft["sender_name"].valid:
        return "sender_name"
    if draft.sender_address_change and not draft["sender_address"].valid:
        return "sender_address"
    if draft.sender_name_for_parcel and state.origin_answer is None and not draft["sender_address"].valid:
        return "ask_address_change"
    if draft.ask_customer_name_save and draft["sender_name"].value != state.customer.name:
        return "ask_name_save"
    return None


def save_offer(state: ConversationState) -> dict:
    c, cur = state.customer, state.current
    if not c.customer_seq or cur is None:
        return {}
    out = {}
    sn = cur["sender_name"]
    if (not cur.sender_name_for_parcel or cur.save_sender_name) and sn.valid \
            and (sn.value or "").strip() and sn.value.strip() != (c.name or "").strip():
        out["name"] = True
    sa = cur["sender_address"]
    # 상세주소는 되읽기 전에 반드시 채워진다(없다고 하면 ""). 상세만 바뀐 경우(101호→102호)도 저장 제안
    if sa.valid and cur.sender_geo and \
            (sa.value, cur["sender_address_detail"].value or "") != (c.default_address, c.default_address_detail or ""):
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
    values = {} if state.current and state.current.sender_name_for_parcel else {"sender_name": c.name}
    if full and place:
        address = state.field_of("sender_address")
        if address.status == FieldStatus.EMPTY or (address.valid and address.value == place.address):
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
