"""미완료 주문 이어받기(사용자 결정 2026-11-06). 순수 함수 — 잠금 안에서 부른다.

- 기한: 주문 createdAt부터 window_sec 이내일 때만 제안한다(묻는 시점 기준). 이어받은 뒤 확정은 기한이 지나도 마무리한다.
- 가장 최근 상세 1건만 받는 중인 택배로 불러온다. 값은 이전 통화 값(Source.HISTORY)이라 되읽기·확인을 다시 받는다.
"""

from datetime import datetime

from app.domain.state import PARCEL_FIELDS, ConversationState, FieldStatus, ParcelDraft, ResumeCandidate, Source


def within_window(cand: ResumeCandidate, now: datetime, window_sec: float) -> bool:
    """now는 시간대가 있는 시각. createdAt을 못 읽으면 제안하지 않는다(근거 없는 이어받기 금지)."""
    try:
        created = datetime.fromisoformat(cand.created_at.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return False
    if created.tzinfo is None:
        return False
    return 0 <= (now - created).total_seconds() <= window_sec


def can_offer(state: ConversationState, now: datetime, window_sec: float) -> bool:
    """접수 업무이고, 아직 묻지 않았고, 고객이 이번 통화에서 택배 정보를 말하기 전이며, 기한 안일 때."""
    if state.resume is None or state.resume_offered or state.intent != "order":
        return False
    if state.parcels or (state.current is not None and any(
            f.status != FieldStatus.EMPTY and f.source == Source.CUSTOMER for f in state.current.fields.values())):
        return False
    return within_window(state.resume, now, window_sec)


def load_resumed(state: ConversationState, version: int, *, client_parcel_id: str | None = None) -> None:
    """연결(PATCH) 성공 뒤: 후보 상세를 받는 중인 택배로 불러온다. 고객이 말한 값이 없을 때만 부른다(can_offer)."""
    cand = state.resume
    draft = ParcelDraft(order_parcel_seq=cand.parcel_seq, client_parcel_id=client_parcel_id)
    state.current, state.editing = draft, None
    v = state.bump()
    # 지번·동명·우편번호가 없는 주소는 확정할 수 없으므로 그 쪽 주소·상세를 다시 받는다
    skip = {f"{r}_{k}" for r in ("sender", "receiver") if cand.parcel.get(f"{r}_geo") is None
            for k in ("address", "address_detail")}
    for name in PARCEL_FIELDS:
        value = cand.parcel.get(name)
        if value is None or name in skip:
            continue
        f = draft[name]
        f.value, f.status, f.source, f.version = value, FieldStatus.VALID, Source.HISTORY, v
    draft.sender_geo, draft.receiver_geo = cand.parcel.get("sender_geo"), cand.parcel.get("receiver_geo")
    draft.client_comment = cand.parcel.get("client_comment")
    if cand.payment and cand.payment in state.customer.payment_methods and not state.payment.valid:
        state.record("payment", cand.payment, Source.HISTORY)
    state.resume_version = version if client_parcel_id is None else None
    state.origin_applied = True  # 보내는 분은 이어받은 상세 값(출발지 질문을 따로 하지 않는다)
    state.bump()
