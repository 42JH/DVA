"""되읽기 때 고객 정보·주소 저장 대상(업무 규칙 g, BE 계약 backend/docs/ai-call-follow-up.md "고객 기본 주소와 개인 PIN 저장").

BE: 주문 저장은 고객 정보·PIN을 자동 갱신하지 않는다. AI가 택배를 담을 때 해당 저장 작업을 실행한다.
- 성함: 등록 고객이 이번 택배의 보내는 분 성함을 등록 이름에도 쓰는 데 동의했고 두 이름이 다르면 고객 이름 갱신
- 보내는 곳: 등록 고객이고 확정 주소(지번·우편번호 포함)가 고객 기본 주소와 다르면 기본 주소 갱신
- 받는 곳: 주소록·이전 주문에서 고른 곳이 아니고 확정 주소면 주소록 추가
shortcut: 주소록에서 고른 받는 곳을 고친 경우는 새 PIN으로 추가한다(PIN 번호를 지금 들고 있지 않음) — 기존 PIN 수정이 필요하면 PIN 번호를 Place에 싣는다.
"""

from app.domain.state import ConversationState, FieldStatus, Source


def sender_change_available(state: ConversationState) -> bool:
    """첫 인사 뒤 받는 분 정보를 받기 전까지 보내는 분 변경을 처리한다."""
    draft = state.current
    return (state.origin_mentioned_in_greeting and state.intent in (None, "order") and not state.parcels
            and not state.pending and (draft is None or not any(
                draft[name].valid for name in ("receiver_name", "receiver_phone", "receiver_address"))))


def begin_sender_name_change(state: ConversationState) -> None:
    sender_name = state.field_of("sender_name")
    draft = state.current
    if draft.sender_name_for_parcel:
        return
    draft.sender_name_for_parcel = True
    draft.ask_customer_name_save = True
    if sender_name.source in (Source.CALLER_ID, Source.PROFILE):
        state.clear("sender_name")
    if not draft.sender_address_change:
        # 인사에 동의한 뒤 성함 변경을 따로 말한 경우도 주소 변경 여부를 묻는다.
        state.origin_answer = None
        state.origin_applied = False


def request_sender_address_change(state: ConversationState) -> None:
    address = state.field_of("sender_address")
    state.current.sender_address_change = True
    state.origin_answer = False
    state.origin_applied = False
    if address.source in (Source.PROFILE, Source.HISTORY):
        state.clear("sender_address")
        state.clear("sender_address_detail")
        state.current.sender_geo = None


def sender_change_next(state: ConversationState) -> str | None:
    draft = state.current
    if state.intent != "order" or draft is None:
        return None
    if (draft.sender_name_for_parcel or draft.sender_name_scope_pending) and not draft["sender_name"].valid:
        return "sender_name"
    if draft.sender_address_change and (missing := missing_sender_address(state)):
        return missing[0]
    address = draft["sender_address"]
    if (draft.sender_name_for_parcel and state.origin_answer is None
            and (not address.valid or address.source in (Source.PROFILE, Source.HISTORY))):
        return "ask_address_change"
    if draft.ask_customer_name_save and draft["sender_name"].valid and draft["sender_name"].value != state.customer.name:
        return "ask_name_save"
    return None


def origin_confirmation(state: ConversationState) -> str | None:
    """아직 발송 주소를 고르지 않았다면 다음 응답에도 확인 질문을 남긴다.
    담은 택배가 있으면 묻지 않는다: 통화 중 등록된 고객은 등록 주소가 생겨도 이미 발송 주소를 말했다."""
    place, draft = state.customer.origin_place, state.current
    if (state.intent == "order" and state.origin_offered and not state.origin_applied
            and state.origin_answer is None and place and not state.parcels
            and not (draft and (draft.sender_name_for_parcel or draft["sender_address"].valid))):
        return "registered" if state.origin_mentioned_in_greeting else place.address
    return None


def missing_sender_address(state: ConversationState) -> tuple[str, ...]:
    if state.intent != "order" or state.current is None:
        return ()
    return tuple(name for name in ("sender_address", "sender_address_detail") if not state.current[name].valid)


def receiver_questions_deferred(state: ConversationState) -> bool:
    return bool(sender_change_next(state) or origin_confirmation(state) or missing_sender_address(state))


def save_offer(state: ConversationState) -> dict:
    c, cur = state.customer, state.current
    if not c.customer_seq or cur is None:
        return {}
    out = {}
    sn = cur["sender_name"]
    if cur.save_sender_name and sn.valid \
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
