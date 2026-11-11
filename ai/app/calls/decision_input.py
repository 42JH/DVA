"""Decision 입력(decision-input-plan.md §3): 서버가 기다리는 질문 · 최근 AI 발화 · 끊어진 고객 발화.

열린 질문은 서버 상태로만 정한다(Live가 말한 문장에서 추측하지 않는다). 발화는 t_start·t_last·text·utterance_id만 본다.
"""

from app.domain.address_book import origin_confirmation, sender_change_available, sender_change_next
from app.domain.assess import assess
from app.domain.confirm import asks
from app.domain.state import ConversationState
from app.policy.model import Policy
from app.tools.outcome import state_summary

RECENT_AI_MAX = 400       # 되읽기 전문이 대개 150~250자
JOIN_WITHIN_SEC = 3.0     # AI 발화 없이 이 안에 이어진 고객 조각은 한 발화로 본다
QUESTION_LOOKBACK_SEC = 20.0
RULES = "\n".join((
    "판단 규칙:",
    "- 열린 질문은 서버가 고객의 답을 기다리는 질문이다. 그 답을 고르는 질문에서는 최근 AI 발화가 열린 질문을 실제로 물었고 "
    "고객이 그에 답했을 때만 답을 고르고, 그 밖에는 not_answer다.",
    "- 다른 말 없이 짧게만 한 동의·거절(네, 아니요, 맞아요)은 열린 질문의 답이다. 다른 질문의 동의로 보지 않는다.",
    "- 고객이 답과 함께 새 값(이름·번호·주소·물품)이나 고침을 말하면 단순 동의(yes)로 보지 않고 "
    "그 사실이 드러나는 선택지를 고른다.",
    "- 통화 종료, 상담원 연결, 조회, 취소, 문의처럼 고객이 직접 말한 요청은 열린 질문과 관계없이 그대로 고른다."))
_PICK = {"destination": "받는 곳 후보 선택", "order": "조회한 택배 선택", "parcel": "고칠 택배 선택"}
# 열린 질문 종류 → 그 답을 맡는 Decision 질문 이름
ANSWERED_BY = {"end": ("switch",), "readback": ("confirm",), "cancel": ("confirm",), "pick": ("pick",), "box": ("box",),
               "name_save": ("sender_name_scope",), "address_change": ("origin",), "origin": ("origin",),
               "greeting": ("task", "origin"), "callback": ("callback",), "more": ("more",)}


def open_question(state: ConversationState, policy: Policy, *, end_waiting: bool = False) -> tuple[str, str] | None:
    """(종류, 입력에 넣을 문구). 순서는 서버가 먼저 묻는 순서(observe_turn)와 같다. 값을 받는 중이면 None."""
    if end_waiting:
        return "end", "통화 종료 여부(yes=통화 종료)"
    if state.callback_offered and not state.callback_requested:
        return "callback", "담당자 연락 동의(yes=연락 받음)"
    pending, candidates, draft = state.pending, state.candidates, state.current
    if pending and pending.kind == "cancel":
        return "cancel", "취소 대상 확인(yes=취소 진행)"
    if candidates and candidates.kind != "destination":
        return "pick", f"{_PICK[candidates.kind]}: {', '.join(candidates.labels)}"
    if state.intent is None:
        if state.origin_offered and state.customer.origin_place:
            return "greeting", "첫 인사: 택배 접수 시작과 안내한 발송 주소 사용 여부(yes=접수 시작, 안내한 주소에서 발송)"
        return "greeting", "첫 인사: 택배 접수 시작 여부(yes=접수 시작)"
    if state.intent != "order":
        return None
    sender_next = sender_change_next(state)
    if sender_next == "ask_name_save":
        return "name_save", "등록 이름도 바꿀지(yes=등록 이름 변경, no=이번 택배만)"
    if sender_next == "ask_address_change":
        return "address_change", "발송 주소도 바꿀지(yes=새 주소로 바꿈, no=등록 주소 그대로)"
    if sender_next:
        return None
    if origin_confirmation(state):
        return "origin", "등록된 발송 주소 사용 여부(yes=등록 주소 사용, no=다른 주소에서 발송)"
    if candidates:
        return "pick", f"{_PICK[candidates.kind]}: {', '.join(candidates.labels)}"
    if draft and draft.box_proposal and not pending:
        return "box", f"박스 후보 확인: {draft.box_proposal.label}(yes=이 크기·개수로 기록)"
    stage = assess(state, policy).stage
    if pending and pending.kind == "parcel" or stage == "readback" and not state.awaiting_fix:
        return "readback", "되읽은 접수 내용 확인(yes=이대로 접수, change=내용 고침)"
    if stage == "more_parcels":
        return "more", "추가로 보낼 택배 여부(yes=더 있음)"
    return None


def collecting(state: ConversationState, policy: Policy) -> str | None:
    """지금 받는 항목(missing 첫 항목) 이름. 접수 값을 받는 중이 아니면 None."""
    if state.intent != "order":
        return None
    return next(iter(state_summary(state, policy)["missing"]), None)


def question_flags(state: ConversationState, policy: Policy, kind: str | None) -> dict:
    """열린 질문에 맞춘 질문 목록(decision_questions 인수): 열린 질문 + switch, 첫 인사와 발송 확인에만 보내는 분 변경."""
    sender_stage = kind in ("greeting", "origin", "address_change")
    item = collecting(state, policy)
    return {"pending": kind in ("readback", "cancel"), "callback": kind == "callback",
            "origin": kind in ("origin", "address_change") or kind == "greeting" and state.origin_offered,
            "sender_change": sender_stage and sender_change_available(state),
            "sender_name_scope": bool(state.customer.customer_seq) and (
                sender_stage or kind == "name_save" or item == "sender_name")}


def recent_ai(ai: list, customers: list, first, cut: tuple[int, int] | None = None) -> str:
    """first(이어 붙인 고객 발화의 첫 조각) 앞, 그 전 고객 발화 뒤에 AI가 한 말 전체.
    그 안에 질문이 없으면(맞장구만) 가장 최근 질문까지 거슬러 붙인다. cut = 고객이 끼어든 (AI 발화 id, 그때까지의 글자 수)."""
    earlier = [c for c in customers if c.t_start < first.t_start]
    since = earlier[-1].t_last if earlier else 0.0
    before = [a for a in ai if a.t_start < first.t_start]
    chunks = [a for a in before if a.t_last > since]
    if not any(asks(a.text) for a in chunks):
        chunks = [a for a in before if a.t_last <= since and first.t_start - a.t_last <= QUESTION_LOOKBACK_SEC
                  and asks(a.text)][-1:] + chunks
    text = " ".join(a.text[:cut[1]].strip() if cut and cut[0] == a.utterance_id else a.text.strip() for a in chunks)
    if len(text) > RECENT_AI_MAX:  # 앞쪽을 자르고 마지막 문장(질문)을 남긴다
        text = "…" + text[-RECENT_AI_MAX:]
    return text


def joined(ai: list, customers: list, utt, applied: int = 0) -> list:
    """utt와 한 발화로 볼 고객 조각들(시간순, utt 포함): 사이에 AI 발화가 없고 JOIN_WITHIN_SEC 안에 이어졌으며
    앞 조각의 판정이 아직 적용되지 않은 것(같은 답이 두 번 적용되지 않게)."""
    parts = [utt]
    for prev in reversed([c for c in customers if c.t_start < utt.t_start][-3:]):
        head = parts[0]
        if (prev.utterance_id <= applied or head.t_start - prev.t_last > JOIN_WITHIN_SEC
                or any(prev.t_last < a.t_last and a.t_start < head.t_start for a in ai)):
            break
        parts.insert(0, prev)
    return parts


def render(state: ConversationState, policy: Policy, ai_text: str, customer_text: str, *,
           end_waiting: bool = False, open_line: bool = True) -> tuple[str, str | None]:
    """(Decision 입력, 열린 질문 종류). open_line=False면 열린 질문 줄과 판단 규칙을 뺀다(설정으로 되돌릴 때)."""
    lines, kind = [], None
    if open_line:
        opened = open_question(state, policy, end_waiting=end_waiting)
        kind = opened[0] if opened else None
        lines += [RULES, "", f"열린 질문: {opened[1] if opened else '없음'}"]
        if not opened and (item := collecting(state, policy)) and item in policy.fields:
            lines.append(f"지금 받는 항목: {policy.fields[item].label}")
    lines += [f"최근 AI 발화: {ai_text.strip() or '(없음)'}", f"고객 발화: {customer_text.strip()}"]
    return "\n".join(lines), kind
