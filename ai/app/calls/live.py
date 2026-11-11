"""S5: 통화 중 흐름 — 함수 호출 라우터 · 발화 끝 Decision · 확인 관문 · 서버 결과 전달(N1'/N2/N3) · 결과 문구 검사.

CallService.handlers에 붙는 동기 핸들러(상태 갱신 + 작업 생성만)와, 잠금 밖에서 I/O 하는 작업으로 나뉜다(concurrency.md §3).
설계: delegation.md v3.1 §3(발화 끝 Decision)·§4(경로·복합 발화 R1~R6)·§6(전달 등급), conversation-state.md §5(관문).
"""

import asyncio
from datetime import time as dtime
import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass, field, replace

from app.address.matcher import sido_aliases
from app.address.parse import clean_text, parse, split_gil, unlink_gil
from app.calls.session import CallSession, Phase
from app.domain.rules import KST
from app.domain.address_book import (begin_sender_name_change, origin_confirmation, prefill_sender,
                                     receiver_questions_deferred, request_sender_address_change, save_offer, sender_change_available,
                                     sender_change_next)
from app.domain.assess import assess, readback_facts
from app.domain.candidates import (DESTINATION_CHANGE_FIELDS, DESTINATION_CLARIFICATIONS, apply_destination_change, apply_pick,
                                   destination_changes, offer, reject_candidates)
from app.domain.claims import truth, unverified_claims, unverified_values
from app.domain.confirm import (ConfirmAnswer, Utterance, asks, asks_parcel_confirmation, check_gate, commit_parcel,
                                explicitly_requests_parcel, issue_cancel_confirmation, issue_parcel_confirmation,
                                release, take_cancel)
from app.domain.state import BOX_SIZE_NAMES, BoxProposal, CandidateSet, ConversationState, ParcelDraft
from app.domain.store import hold_unclassified_items, item_issues_pending
from app.observability.trace import span
from app.policy.render import decision_questions
from app.tools import MODEL_TOOLS, run_tool
from app.tools.cancel import cancel_parcel
from app.tools.lookup import lookup_order_facts, resume_destination, status_text
from app.tools.outcome import DESTINATION_CHANGE_QUESTIONS, state_summary
from app.tools.record import RecordArgs, record_fields

log = logging.getLogger(__name__)
BUSINESS = ("order", "lookup", "cancel", "inquiry", "agent")
TOOL_INTENT = {"record_fields": "order", "find_destination": "order", "lookup_orders": "lookup",
               "search_manual": "inquiry"}
# 도구 → 대시보드 processType(ai-dashboard-ai-integration.md §4). 받는 곳 후보 찾기는 주소 조회로 센다
TOOL_LATENCY = {"record_fields": "INFORMATION_INPUT", "find_destination": "ADDRESS_LOOKUP",
                "search_manual": "FAQ_LOOKUP", "lookup_orders": "ORDER_LOOKUP"}
GREETING_ORDER = re.compile(
    r"(?:택배)?접수(?:를)?(?:도와드릴까요|도와드려도될까요|해드릴까요|하시겠어요|하실까요|할까요|하시는건가요)$"
)
SHORT_YES = re.compile(r"(?:아|어|음)?(?:네|예|응|맞아요|맞습니다|그렇습니다)+")
DESTINATION_OTHER_ADDRESS = re.compile(r"(?:다른|새|새로운)주소|(?:주소|받는곳)(?:가|는)?(?:다르|달라)|주소만(?:바꾸|바꿀|바꿔|변경)")
DESTINATION_OTHER_PERSON = re.compile(r"(?:다른|새|새로운)(?:사람|받는분|수신인)|(?:받는분|수신인)(?:이|은)?(?:다르|달라|새로)|(?:받는분|수신인)만(?:바꾸|바꿀|바꿔|변경)")
DESTINATION_OTHER_TASK = re.compile(r"보내는분|발송(?:지|주소)|출발(?:지|주소)|취소|조회|상담원|끊어")
GREETING_OTHER_ORIGIN = re.compile(r"(?:네|예|아니요)?(?:오늘은|이번에는)?다른(?:주소|곳)에서"
                                  r"(?:보낼게요|보내려고요|보냅니다|발송할게요|발송하려고요)")
REGISTERED_ORIGIN_QUESTION = re.compile(
    r"(?:등록된|기존|저장된)발송주소(?:로|에서)(?:그대로)?(?:보내실까요|보내시나요|발송하실까요|발송하시나요)$"
)
RECEIVER_NAME_QUESTION = re.compile(r"(?:받는|받으시는|받으실)\s*(?:분|사람)|수취인|수령인")
SENDER_NAME_REFERENCE = re.compile(r"(?:보내는|보내시는|보내실)\s*(?:분|사람|성함|이름)|발송인|송하인|발신자")


@dataclass
class Spoken:
    utterance_id: int
    text: str
    start_ms: int
    end_ms: int
    t_start: float
    t_last: float
    ready_parcel_id: str | None = None
    readback_id: str | None = None
    sender_name_scope: str | None = None
    scope_decided: asyncio.Event | None = None
    buffered_destination_address: bool = False

    def utterance(self) -> Utterance:
        return Utterance(self.utterance_id, self.start_ms or 0, self.end_ms or 0, self.t_start, self.text, self.readback_id)


@dataclass
class Runtime:
    """통화별 S5 상태(세션에 붙는다). 업무 값은 state에만 있다."""
    cust: Spoken | None = None
    customer_turns: list[Spoken] = field(default_factory=list)
    seq: int = 0
    ai: list[Spoken] = field(default_factory=list)   # 최근 AI 발화(직전 AI 발화·G3)
    endpoint: asyncio.TimerHandle | None = None
    ai_end: asyncio.TimerHandle | None = None
    latest_applied: int = 0                           # 적용한 가장 최근 고객 발화 id(DECISION_STALE)
    delegations: dict[str, dict] = field(default_factory=dict)  # delegation_id → {offset_ms, inflight, outputs, completed}
    commit: asyncio.TimerHandle | None = None
    commit_pid: str | None = None
    ready_notice: str | None = None                    # 다음 AI 발화에 한해 접수를 안내할 수 있는 택배 ID
    readback_id: str | None = None                     # 현재 말할 서버 확인 내용의 pending ID
    n3: int = 0
    sent_hashes: set[str] = field(default_factory=set)
    intent_started: bool = False
    unanswered: int = 0                               # 매뉴얼 검색이 연속으로 답을 못 한 횟수(3회 → 상담원 권유, 답하면 0)
    cust_end_t: float = 0.0                           # 관제: 마지막 고객 발화 끝(→ AI 말 시작)
    await_speech: tuple[str, float] | None = None     # 관제: (구간 이름, 시작) — 다음 AI 발화 시작까지
    confirm_t: float = 0.0                            # 관제: 확인 "네" 발화 끝(→ 담기)
    # 서버 질문(후보·확인·출발지·박스·콜백)에 답하는 발화의 Decision 반영 대기. 같은 턴의 Backend 도구 호출이 기다린다
    deciding: asyncio.Event | None = None

    def cancel(self) -> None:
        for h in (self.endpoint, self.ai_end, self.commit):
            if h is not None:
                h.cancel()
        self.endpoint = self.ai_end = self.commit = None


class LiveFlow:
    def __init__(self, service):
        self.svc = service
        self.cfg = service.d.cfg
        self.policy = service.d.policy
        h = service.handlers
        base_in, base_out = h["session.input_transcript.delta"], h["session.output_transcript.delta"]
        h["session.input_transcript.delta"] = lambda s, ev: (base_in(s, ev), self.on_input(s, ev))
        h["session.output_transcript.delta"] = lambda s, ev: (base_out(s, ev), self.on_output(s, ev))
        base_started = h["session.started"]
        h["session.started"] = lambda s, ev: (base_started(s, ev), self.on_started(s))
        h["session.delegation.created"] = self.on_delegation
        h["response.event"] = self.on_response

    @staticmethod
    def rt(s: CallSession) -> Runtime:
        if s.rt is None:
            s.rt = Runtime()
        return s.rt

    def on_started(self, s: CallSession) -> None:
        """상담원이 먼저 인사한다: 지시문만으로는 고객이 "여보세요"를 할 때까지 기다리는 일이 많았다(2026-11-03 통화 6건 중 4건).
        세션이 열리면 N2(말할 거리)로 첫 인사를 시킨다. AI가 이미 말하기 시작했거나 고객이 먼저 말했으면 보내지 않는다."""
        if s.last_output_t == 0 and self.rt(s).cust is None:
            s.spawn(self.notify(s, "N2", {"call_started": True}), "greet")

    # ------------------------------------------------------------------ 전사 → 발화 끝
    def on_input(self, s: CallSession, ev: dict) -> None:
        rt, now = self.rt(s), time.time()
        if rt.cust is None:
            rt.ready_notice = None
            rt.readback_id = None
            rt.seq += 1
            rt.cust = Spoken(rt.seq, "", ev.get("start_ms") or 0, ev.get("end_ms") or 0, now, now)
            rt.customer_turns.append(rt.cust)
            del rt.customer_turns[:-12]
        rt.cust.text += ev.get("delta", "")
        rt.cust.end_ms, rt.cust.t_last = ev.get("end_ms") or rt.cust.end_ms, now
        _transcript(s, "customer", rt.cust)
        if rt.commit is not None:  # 확정 지연 중 새 발화 → 확정 취소, 새 Decision을 기다린다(§5.2)
            rt.commit.cancel()
            rt.commit = rt.commit_pid = None
            s.note("확정 취소", "새 발화")
        if rt.endpoint:
            rt.endpoint.cancel()
        rt.endpoint = asyncio.get_running_loop().call_later(self.cfg.utterance_gap_ms / 1000, self._customer_done, s)

    def on_output(self, s: CallSession, ev: dict) -> None:
        rt, now = self.rt(s), time.time()
        last = rt.ai[-1] if rt.ai else None
        pending = s.state.pending
        readback_id = rt.readback_id if pending and pending.id == rt.readback_id else None
        customer_cut_in = last and last.readback_id and rt.customer_turns and rt.customer_turns[-1].t_start > last.t_start
        if last and now - last.t_last <= self.cfg.utterance_gap_ms / 1000 \
                and not customer_cut_in and (readback_id is None or last.readback_id == readback_id):
            last.text += ev.get("delta", "")
            last.end_ms, last.t_last = ev.get("end_ms") or last.end_ms, now
        else:
            rt.seq += 1
            rt.ai.append(Spoken(rt.seq, ev.get("delta", ""), ev.get("start_ms") or 0, ev.get("end_ms") or 0,
                                now, now, ready_parcel_id=rt.ready_notice, readback_id=readback_id))
            rt.ready_notice = None
            del rt.ai[:-20]
            if rt.cust_end_t:  # 새 AI 발화 시작 = 고객 말 끝 뒤 첫 반응
                s.timing("고객 말 끝→AI 말 시작", (now - rt.cust_end_t) * 1000)
                s.wait_ms += max(0.0, now - rt.cust_end_t) * 1000  # 대시보드 대기 합계(구간이 순서대로라 겹치지 않음)
                rt.cust_end_t = 0.0
            if rt.await_speech:
                s.timing(rt.await_speech[0], (now - rt.await_speech[1]) * 1000)
                rt.await_speech = None
        _transcript(s, "agent", rt.ai[-1])
        if rt.ai_end:
            rt.ai_end.cancel()
        rt.ai_end = asyncio.get_running_loop().call_later(self.cfg.utterance_gap_ms / 1000, self._ai_done, s)

    def _customer_done(self, s: CallSession) -> None:
        rt = self.rt(s)
        utt, rt.cust, rt.endpoint = rt.cust, None, None
        if utt:
            rt.cust_end_t = utt.t_last
        if utt and utt.text.strip() and s.phase == Phase.ACTIVE:
            prev = next((a for a in reversed(rt.ai) if a.t_start < utt.t_start), None)
            gate = asyncio.Event() if self._awaiting_answer(s) else None
            candidates = s.state.candidates
            utt.buffered_destination_address = bool(candidates and "receiver_address" in candidates.destination_buffer)
            if s.state.customer.customer_seq and s.state.intent in (None, "order"):
                utt.scope_decided = gate or asyncio.Event()
            # 위임은 OpenAI 쪽에서 Live가 시작해 서버가 늦출 수 없다. 대신 이 턴의 도구 호출이 반영을 기다린다(최근 발화 기준)
            rt.deciding = gate
            s.spawn(self._judge_customer(s, utt, prev, gate), "decision")

    def _awaiting_answer(self, s: CallSession) -> bool:
        """서버가 고객 답으로 상태를 바꿀 질문을 열어 두었는가(Decision의 pick·confirm·origin·box·callback)."""
        st = s.state
        return bool(st.candidates or st.pending or (st.callback_offered and not st.callback_requested)
                    or (st.origin_offered and st.origin_answer is None and not st.origin_applied)
                    or sender_change_available(st) and not (st.current and st.current.sender_name_for_parcel)
                    or (st.current and st.current.ask_customer_name_save)
                    or (st.current and st.current.box_proposal and st.intent == "order")
                    or assess(st, self.policy).stage == "readback")

    async def _decided(self, s: CallSession, gate: asyncio.Event | None = None) -> None:
        """서버 질문에 답한 턴이면 Decision 반영까지 기다린다. Backend가 반영 전 상태로 다음 질문을 정하지 않게
        (운영 통화: 후보 선택으로 연락처가 채워졌는데 Backend가 연락처를 다시 물음)."""
        rt = self.rt(s)
        gate = gate if gate is not None else rt.deciding
        if gate is not None and not gate.is_set():
            t0 = time.monotonic()
            timeout = self.cfg.decision_budget_sec + 0.5
            if rt.customer_turns and rt.customer_turns[-1].buffered_destination_address:
                timeout += s.tools.tool_budget_sec
            try:
                await asyncio.wait_for(gate.wait(), timeout)
            except TimeoutError:
                pass
            s.timing("도구→Decision 반영 대기", (time.monotonic() - t0) * 1000)

    async def _judge_customer(self, s: CallSession, utt: Spoken, prev: Spoken | None,
                              gate: asyncio.Event | None = None) -> None:
        try:
            await self._judge_customer_inner(s, utt, prev)
        finally:
            if gate is not None:
                gate.set()
            if utt.scope_decided is not None:
                utt.scope_decided.set()

    async def _judge_customer_inner(self, s: CallSession, utt: Spoken, prev: Spoken | None) -> None:
        judge_first = s.state.intent != "order"
        if judge_first:  # 첫 발화가 "농약을 보내려고요"일 수도 있다
            await self.judge(s, utt, prev)
        async with s.lock:
            review = {} if s.state.order_submitted or s.closed else hold_unclassified_items(
                s.state, self.policy.parcel_items, utt.utterance_id, utt.text)
            if review.get("code") == "ITEM_PARCEL_UNCLEAR":
                review.update(self._edit(s, use_lookup=False))
            if review:
                self._sync_intake(s)
        if review:
            s.note("물품 확인", review["code"])
            if self._delegation_in(s, utt):
                await self.notify(s, "N1'", {"item_review": review})
            else:
                s.spawn(self.notify(s, "N2", {"item_review": review}, again=True), "item_review")
        if not judge_first:
            await self.judge(s, utt, prev)

    def _ai_done(self, s: CallSession) -> None:
        """AI 발화 끝: 결과 문구 검사(LLM 없음, delegation.md §6.2-5)·말한 번호·호수 대조(기록만)."""
        rt = self.rt(s)
        rt.ai_end = None
        if not rt.ai:
            return
        spoken = rt.ai[-1]
        if rt.readback_id and spoken.readback_id == rt.readback_id and asks_parcel_confirmation(spoken.text):
            rt.readback_id = None
        if wrong := unverified_values(spoken.text, s.state):  # 측정만: 기억으로 답했거나 잘못 읽은 번호·호수
            s.note("값 대조", "서버 값에 없는 번호·호수", wrong)
            log.warning("값 대조 불일치 %s %s", s.call_id, wrong)
        pid = spoken.ready_parcel_id
        ready_receipt = pid is not None and self.svc.intake.confirmed_status(s, pid) == "ready"
        if claims := unverified_claims(spoken.text, s.state, self.policy, ready_receipt=ready_receipt):
            s.note("결과 문구", ",".join(claims))
            facts = truth(s.state)
            if s.tools.draft_intake:
                facts.pop("submit_when", None)
            s.spawn(self.notify(s, "N3", {"unverified": claims, "truth": facts}), "n3")

    # ------------------------------------------------------------------ 발화 끝 Decision
    async def judge(self, s: CallSession, utt: Spoken, prev: Spoken | None) -> None:
        async with s.lock:
            rt = self.rt(s)
            stage = assess(s.state, self.policy).stage
            heard_question = prev and utt.start_ms >= prev.end_ms - self.policy.confirm.answer_after_readback_tolerance_ms
            greeting = (_greeting_offer(s.state, prev.text)
                        if stage == "intent" and heard_question and rt.customer_turns == [utt] else None)
            origin_question = bool(heard_question and _asked_pending_origin(s.state, prev.text))
            if greeting in ("registered_origin", "origin_mentioned"):
                s.state.origin_mentioned_in_greeting = True
            pending = s.state.pending
            candidates = s.state.candidates
            pick = candidates.labels if candidates and not (
                candidates.kind == "destination" and receiver_questions_deferred(s.state)) else ()
            pending_id = pending.id if pending else None
            callback = s.state.callback_offered and not s.state.callback_requested
            current = s.state.current
            sender_change = sender_change_available(s.state) and (
                not (current and current.sender_name_for_parcel) or sender_change_next(s.state) == "sender_name")
            origin = s.state.origin_offered and (sender_change or
                                                  s.state.origin_answer is None and not s.state.origin_applied)
            name_scope = bool(s.state.customer.customer_seq and stage in ("intent", "sender", "receiver", "address",
                                                                           "item", "readback"))
            box = current.box_proposal if current and s.state.intent == "order" and not pending else None
            cancel_current = s.tools.draft_intake and current is not None and not current.empty()
        reply = re.sub(r"[\s,.!?…~]+", "", utt.text) if greeting or origin_question else ""
        other_origin = GREETING_OTHER_ORIGIN.fullmatch(reply)
        if greeting and (other_origin or SHORT_YES.fullmatch(reply)):
            answers = {"task": ("order", 1.0)}
            if other_origin or greeting == "registered_origin":
                answers["origin"] = ("no" if other_origin else "yes", 1.0)
            if other_origin and sender_change:
                answers["sender_change"] = ("address", 1.0)
            s.note("Decision", "첫 인사 동의", {"origin": greeting})
            await self.apply(s, utt, prev, answers, pending_id, greeting=True)
            return
        if origin_question and SHORT_YES.fullmatch(reply):
            s.note("Decision", "발송 주소 확인 동의")
            await self.apply(s, utt, prev, {"origin": ("yes", 1.0)}, pending_id)
            return
        # readback 단계는 확인 대기가 풀려 있어도 confirm을 듣는다(Live가 스스로 확인 질문을 하면 '네'가 갈 곳이 없음, 운영 통화 56c133c8)
        questions = decision_questions(self.policy, stage, pending=pending is not None or stage == "readback",
                                       pick_labels=pick, callback=callback, origin=origin,
                                       destination_candidates=candidates if pick else None,
                                       sender_change=sender_change, sender_name_scope=name_scope,
                                       cancel_current=cancel_current,
                                       box_label=box.label if box else None)
        if not questions:
            return  # 선택형 판단이 없는 단계: 부르지 않는다
        s.stats["Decision 호출"] += 1
        text = f"직전 AI 발화: {prev.text.strip() if prev else '(없음)'}\n고객 발화: {utt.text.strip()}"
        started = time.monotonic()
        call = asyncio.ensure_future(self.svc.d.client.decisions.create(
            model="gpt-6-luna", input=text, questions=questions))
        try:
            with span("decision", utterance=utt.utterance_id):
                d = await asyncio.wait_for(asyncio.shield(call), self.cfg.decision_budget_sec)
        except TimeoutError:
            s.stats["Decision 판단 없음"] += 1
            s.note("Decision", f"DECISION_TIMEOUT >{self.cfg.decision_budget_sec * 1000:.0f}ms 입력 {len(text)}자",
                   {"stage": stage, "pending": pending_id, "input": text, "questions": [q["name"] for q in questions]})
            # 늦은 답은 쓰지 않고 실제 응답 시간만 남긴다(예산 조정 근거). 추가 호출 없음
            call.add_done_callback(lambda f: f.cancelled() or f.exception() or s.note(
                "Decision 늦은 응답", f"{(time.monotonic() - started) * 1000:.0f}ms") or s.timing(
                "Decision(시간 초과분)", (time.monotonic() - started) * 1000))
            if greeting:
                await self._clarify_greeting(s, utt)
            return
        except Exception as e:
            s.note("Decision", f"DECISION_UNAVAILABLE {type(e).__name__}",
                   {"stage": stage, "pending": pending_id, "input": text, "questions": [q["name"] for q in questions],
                    "error": str(e)[:500]})
            if greeting:
                await self._clarify_greeting(s, utt)
            return
        ms = round((time.monotonic() - started) * 1000)
        s.decision_ms.append(ms)
        s.timing("Decision", ms)
        answers = {a.name: _answer(a) for a in d.answers if a.type == "choice"}
        if greeting in ("order", "origin_mentioned") and answers.get("origin", (None,))[0] == "yes":
            answers.pop("origin")  # 인사에서 등록 주소를 대조하지 못했으면 사용 여부는 별도로 묻는다.
        s.note("Decision", ", ".join(f"{k}={v[0]}({v[1]:.2f})" for k, v in answers.items()) + f" {ms}ms",
               {"stage": stage, "pending": pending_id, "input": text, "ms": ms,
                "answers": {k: {"choice": v[0], "confidence": round(v[1], 3), "probabilities": v[2]}
                            for k, v in answers.items()}})
        await self.apply(s, utt, prev, answers, pending_id, box=box, candidates=candidates,
                         candidate_draft=current, greeting=bool(greeting))

    async def _clarify_greeting(self, s: CallSession, utt: Spoken) -> None:
        async with s.lock:
            if s.phase != Phase.ACTIVE or s.state.intent is not None or self.rt(s).customer_turns != [utt]:
                return
        s.spawn(self.notify(s, "N2", {"greeting_confirmation": "ask_intent"}), "clarify_greeting")

    async def apply(self, s: CallSession, utt: Spoken, prev: Spoken | None, answers: dict, pending_id: str | None,
                    *, box: BoxProposal | None = None, candidates: CandidateSet | None = None,
                    candidate_draft: ParcelDraft | None = None, greeting: bool = False):
        rt, st, th = self.rt(s), s.state, self.cfg.decision_min_confidence
        followups = []
        async with s.lock:
            if s.closed or utt.utterance_id < rt.latest_applied:
                s.note("Decision", "DECISION_STALE")
                return
            if greeting and (rt.customer_turns != [utt] or st.intent is not None):
                return
            rt.latest_applied = utt.utterance_id
            switch = answers.get("switch")
            if switch and switch[1] >= th and switch[0] in ("agent", "end", "cancel_current"):
                # 연결·종료·현재 택배 취소 요청이 섞인 "네"는 접수 확인으로 처리하지 않는다.
                answers = {"switch": switch}
            destination_reply = (self._apply_destination_reply(s, utt, prev, candidates, answers.get("pick"), switch)
                                 if st.current is candidate_draft else None)
            if destination_reply is not None:
                for name in ("pick", "confirm", "origin", "sender_change", "sender_name_scope"):
                    answers.pop(name, None)
                followups.append(("destination_change", (utt, candidate_draft, destination_reply)))
            if (box and st.intent == "order" and not st.pending and st.current and st.current.box_proposal is box
                    and (answer := answers.get("box")) and answer[1] >= th and answer[0] in ("yes", "no")
                    and (not switch or switch[1] < th or switch[0] == "none")
                    and prev and prev.t_start >= box.issued_t and asks(prev.text)
                    and BOX_SIZE_NAMES[box.size] in prev.text and "박스" in prev.text
                    and utt.start_ms >= prev.end_ms - self.policy.confirm.answer_after_readback_tolerance_ms):
                followups.append(("box_answer", (box, answer[0], utt)))
            task = answers.get("task")
            origin_answer = answers.get("origin")
            change = answers.get("sender_change")
            next_sender = sender_change_next(st)
            draft = st.current
            expecting_receiver_name = (st.intent == "order" and draft and draft["sender_name"].valid
                                       and not draft["receiver_name"].valid and not next_sender
                                       and not origin_confirmation(st))
            receiver_name_answer = (prev and _asked_receiver_name(prev.text, bool(expecting_receiver_name))
                                    and not SENDER_NAME_REFERENCE.search(utt.text))
            if receiver_name_answer and change and change[0] in ("name", "both"):
                change = None  # 받는 분 질문의 답으로 이미 기록된 보내는 분 성함을 비우지 않는다.
            origin_change = False
            sender_change = (sender_change_available(st)
                             and (st.intent == "order" or task and task[0] == "order" and task[1] >= th)
                             and (not switch or switch[1] < th or switch[0] in ("none", "edit_parcel"))
                             and change and change[1] >= th and change[0] in ("name", "address", "both"))
            if sender_change:
                if change[0] in ("name", "both"):
                    begin_sender_name_change(st)
                if change[0] in ("address", "both"):
                    request_sender_address_change(st)
                    origin_answer = None
                elif origin_answer and origin_answer[0] == "no":
                    origin_answer = None  # 이름만 바꾼다는 답을 발송 주소 변경으로 해석하지 않는다.
                if st.intent == "order":
                    followups.append(("sender_change", utt))
            scope = answers.get("sender_name_scope")
            scope_choice = scope[0] if scope and scope[1] >= th else None
            if scope_choice in ("once", "save") and not receiver_name_answer:
                utt.sender_name_scope = scope_choice
            scope_waits_for_name = (scope_choice in ("once_pending", "save_pending") and st.customer.customer_seq
                                    and not receiver_name_answer
                                    and (not switch or switch[1] < th or switch[0] == "none")
                                    and (st.intent == "order" or task and task[0] == "order" and task[1] >= th))
            if scope_waits_for_name:
                st.clear("sender_name")
                st.current.sender_name_scope_pending = scope_choice.removesuffix("_pending")
                st.current.ask_customer_name_save = st.current.save_sender_name = False
            scope_resolved = (not receiver_name_answer and st.current and st.current.ask_customer_name_save and (
                next_sender == "ask_name_save" and scope_choice in ("confirm_once", "confirm_save")
                or not st.current["sender_name"].valid and utt.sender_name_scope is not None))
            if scope_resolved:
                st.current.ask_customer_name_save = False
                st.current.save_sender_name = scope_choice in ("save", "confirm_save")
                if st.pending and st.pending.kind == "parcel":
                    st.address_offer = save_offer(st) or None
            if (og := origin_answer) and og[1] >= th and og[0] in ("yes", "no") \
                    and (st.origin_offered or greeting and og[0] == "no") \
                    and next_sender != "sender_name" \
                    and st.origin_answer is None:
                origin_change = og[0] == "no" and (st.intent == "order" or bool(
                    task and task[0] == "order" and task[1] >= th))
                if origin_change:
                    request_sender_address_change(st)
                else:
                    st.origin_answer = og[0] == "yes"
                s.note("출발지", og[0])
                if st.intent == "order" and not sender_change:
                    followups.append(("origin", utt))
            if ((scope_resolved or scope_waits_for_name) and st.intent == "order"
                    and not sender_change and ("origin", utt) not in followups):
                followups.append(("sender_name_scope", utt))
            if next_sender or scope_waits_for_name:
                answers.pop("confirm", None)  # 보내는 분 관련 답은 접수 완료 동의가 아니다.
            if "confirm" in answers and pending_id:
                confirmation = answers["confirm"]
                explicit = confirmation[0] == "proceed" or (
                    confirmation[0] == "yes" and explicitly_requests_parcel(utt.text))
                if not explicit or not switch or switch[1] < th or switch[0] == "none":
                    followups.append(self._on_confirm(s, utt, prev, confirmation, pending_id))
            elif (c := answers.get("confirm")) and c[0] in ("yes", "proceed") and c[1] >= self.policy.confirm.yes_min:
                # 확인 대기 없이 온 '네'(Live가 서버 되읽기 없이 물음): 확정하지 않고 서버 되읽기로 다시 묻는다
                st.awaiting_fix = False
                if pid := self._reissue(s):
                    followups.append(("ask_confirm", pid))
            elif c and c[0] in ("no", "change") and c[1] >= th:
                st.awaiting_fix = True  # 고친 값이 올 때까지 되읽기를 다시 열지 않는다
            picked_lookup = False
            active_candidates = st.candidates
            if ((p := answers.get("pick")) and p[1] >= th
                    and active_candidates and (candidates is None or active_candidates is candidates)
                    and (active_candidates.kind != "destination" or active_candidates is candidates
                         and st.current is candidate_draft and not receiver_questions_deferred(st))):
                kind = active_candidates.kind
                if p[0] == "none":
                    reject_candidates(st)
                elif p[0] != "not_answer" and apply_pick(st, p[0]):
                    self._sync_intake(s)
                    picked_lookup = (kind == "order" and st.intent == "lookup"
                                     and (not switch or switch[1] < th or switch[0] in ("none", "lookup")))
                    if picked_lookup:
                        followups.append(("lookup_picked", lookup_order_facts(st.selected_order)))
                    else:
                        followups.append(("picked", p[0]))
            if task and task[1] >= th and task[0] in BUSINESS + ("end",):
                followups.append(("greeting_order", utt) if greeting and task[0] == "order" else ("intent", task[0]))
            elif greeting:
                followups.append(("clarify_greeting", utt))
            if (w := answers.get("switch")) and w[1] >= th and w[0] != "none" and not sender_change \
                    and not ((origin_change or destination_reply is not None) and w[0] == "edit_parcel") \
                    and not (picked_lookup and w[0] == "lookup"):
                followups.append(("intent", w[0]))
            if (m := answers.get("more")) and m[1] >= th and m[0] == "no_more" and st.parcels:
                followups.append(("no_more", None))
            if (cb := answers.get("callback")) and cb[1] >= th and cb[0] in ("yes", "no") and st.callback_offered:
                st.callback_offered = False
                st.callback_requested = cb[0] == "yes"
                followups.append(("callback", cb[0]))
        for f in followups:
            if f:
                await self._follow(s, *f)

    def _apply_destination_reply(self, s: CallSession, utt: Spoken, prev: Spoken | None,
                                 candidates: CandidateSet | None, answer, switch) -> dict[str, str] | None:
        st, th = s.state, self.cfg.decision_min_confidence
        if (not candidates or st.candidates is not candidates or st.intent != "order" or st.order_submitted
                or receiver_questions_deferred(st) or not prev or not asks(prev.text)
                or self.rt(s).customer_turns[-1:] != [utt]
                or switch and switch[1] >= th and switch[0] not in ("none", "edit_parcel")):
            return None
        changes = destination_changes(candidates)
        if not changes:
            return None
        heard_question = utt.start_ms >= prev.end_ms - self.policy.confirm.answer_after_readback_tolerance_ms
        explicit = _explicit_destination_reply(candidates, prev.text, utt.text) if heard_question else None
        pick = explicit or (answer[0] if answer and answer[1] >= th else None)
        if pick is None and heard_question and answer and answer[0] in changes and _asked_destination(candidates, prev.text):
            pick = ("clarify_candidate" if len(candidates.labels) > 1 else
                    "clarify_recipient" if changes[answer[0]][1] == "address" else "clarify_address")
        if change := changes.get(pick):
            index, scope = change
            buffered = {field: candidates.destination_buffer[field] for field in DESTINATION_CHANGE_FIELDS[scope]
                        if field in candidates.destination_buffer}
            apply_destination_change(st, index, scope)
            self._sync_intake(s)
            if explicit:
                s.note("Decision", "받는 곳 변경 명시 답변", {"pick": pick})
            return buffered
        if pick == "none" and candidates.destination_clarification:
            reject_candidates(st)
            return candidates.destination_buffer
        clarification = DESTINATION_CLARIFICATIONS.get(pick)
        if clarification and (clarification == "candidate") == (len(candidates.labels) > 1):
            st.candidates = replace(candidates, destination_clarification=clarification)
            st.bump()
            return {}
        return None

    def _on_confirm(self, s: CallSession, utt: Spoken, prev: Spoken | None, ans: tuple, pending_id: str):
        """잠금 안. yes → 관문(G1~G5) → G6(같은 발화 위임 보류) → 확정 지연 / no·change → 즉시 해제."""
        choice, _, probs = ans
        st, rt = s.state, self.rt(s)
        if rt.customer_turns and rt.customer_turns[-1].utterance_id > utt.utterance_id:
            return None
        if choice in ("no", "change") and probs.get(choice, 0) >= self.cfg.decision_min_confidence:
            release(st, pending_id)
            return ("released", choice)
        if choice not in ("yes", "proceed"):
            return None
        gate = check_gate(st, self.policy, pending_id, ConfirmAnswer(choice, probs), utt.utterance(),
                          prev.utterance() if prev else None, latest_applied_utterance=None, closed=s.closed)
        if not gate.ok:
            s.note("확인 관문", gate.code)
            if gate.code in ("CONFIRM_UNCLEAR", "CONFIRM_BEFORE_READBACK_END"):
                if delegations := self._delegations_for(s, utt):
                    return ("ask_confirm_after_delegation", (pending_id, utt.utterance_id, delegations))
                return ("ask_confirm", pending_id)
            return None
        if delegations := self._delegations_for(s, utt):  # G6: 같은 발화의 위임이 끝난 뒤 다시 본다
            s.note("확인 관문", "COMMIT_HELD_FOR_DELEGATION")
            rt.confirm_t = utt.t_last
            return ("hold", (pending_id, utt.utterance_id, delegations))
        rt.confirm_t = utt.t_last
        self._arm_commit(s, pending_id)
        return None

    def _reissue(self, s: CallSession) -> str | None:
        """잠금 안. readback 단계인데 확인 대기가 없으면(no·change로 푼 뒤 값이 다시 갖춰짐) 현재 값으로 다시 연다.
        고친 값을 기다리는 중(awaiting_fix)이면 열지 않는다(거절 직후 같은 내용을 되읽지 않게)."""
        st = s.state
        if s.closed or st.pending or st.awaiting_fix or not st.pickup_at.valid or sender_change_next(st) \
                or st.candidates and st.candidates.kind == "destination" \
                or assess(st, self.policy).stage != "readback":
            return None
        p = issue_parcel_confirmation(st, self.policy, s.tools.clock())
        if p:
            s.note("확인 대기 재발급", p.id)
        return p.id if p else None

    async def _reopen_readback(self, s: CallSession, d: dict) -> None:
        """위임이 끝났는데 확인 대기가 없으면 서버 되읽기로 다시 연다(운영 통화 56c133c8: 없으면 Live가 스스로 확인 질문을
        하고 '네'를 받을 곳이 없어 무음). 재질문 결과(needs)가 난 위임에는 얹지 않는다."""
        if d.get("needs"):
            return
        async with s.lock:
            pid = self._reissue(s)
        if pid:
            await self._follow(s, "ask_confirm", pid)

    def _arm_commit(self, s: CallSession, pending_id: str) -> None:
        rt = self.rt(s)
        if rt.commit:
            rt.commit.cancel()
        rt.commit_pid = pending_id
        rt.commit = asyncio.get_running_loop().call_later(
            self.cfg.commit_delay_ms / 1000, lambda: s.spawn(self.commit(s, pending_id), "commit"))

    async def commit(self, s: CallSession, pending_id: str) -> None:
        rt = self.rt(s)
        rt.commit = rt.commit_pid = None
        draft_save = None
        draft_cancel = None
        is_draft_cancel = False
        async with s.lock:
            if s.closed or not s.state.pending or s.state.pending.id != pending_id:
                return
            kind = s.state.pending.kind
            if kind == "parcel":
                pid = commit_parcel(s.state, self.policy, pending_id)
                if pid and rt.confirm_t:
                    s.timing("확인 '네'→담기", (time.time() - rt.confirm_t) * 1000)
                    rt.confirm_t = 0.0
                if pid and s.state.address_offer:
                    s.state.address_offer = s.state.address_offer | {"parcel": pid}
                facts = {"parcel_added": pid, "parcels": len(s.state.parcels)} if pid else None
                if pid:
                    s.state.selected_order = None
                    draft_save = self._sync_intake(s)
                target = None
            else:
                target = take_cancel(s.state, self.policy, pending_id)
                is_draft_cancel = bool(target and ("draft_seq" in target or "client_parcel_id" in target))
                if is_draft_cancel:
                    draft_cancel = self.svc.intake.cancel(s, target)
                    s.state.intent = "order"
                facts = None
        if kind == "parcel":
            self._maybe_save_addresses(s)
            if facts:
                if draft_save is not None:
                    await asyncio.wait({draft_save}, timeout=1.5)
                if s.tools.draft_intake:
                    facts["draft_intake"] = self.svc.intake.confirmed_status(s, facts["parcel_added"])
                s.note("담기", facts["parcel_added"])
                await self.notify(s, "N2", facts | {"summary": state_summary(s.state, self.policy)})
            return
        if target:  # 취소: 서버 전용 실행, 결과는 N2
            t0 = time.monotonic()
            if is_draft_cancel:
                cancelled = True
                if draft_cancel is not None:
                    await self.svc.intake.flush(s.call_id)
                    result = self.svc.intake.step_result(s, draft_cancel)
                    cancelled = result is not None and result.get("status") == "CANCELLED"
                async with s.lock:
                    s.state.cancel_done = cancelled
                s.measure("ORDER_CANCEL", (time.monotonic() - t0) * 1000)
                s.note("취소", "done" if cancelled else "unknown")
                await self.notify(s, "N2", {"cancel": {"status": "ok" if cancelled else "unavailable",
                                                       "facts": {"outcome": "done" if cancelled else "unknown"}},
                                             "summary": state_summary(s.state, self.policy)})
                return
            out = await cancel_parcel(s.tools, target["order_seq"], target["order_parcel_seq"])
            s.measure("ORDER_CANCEL", (time.monotonic() - t0) * 1000)
            s.note("취소", out.code or out.facts.get("outcome", out.status))
            await self.notify(s, "N2", {"cancel": out.to_output()})

    async def _follow(self, s: CallSession, what: str, value) -> None:
        st = s.state
        if what == "hold":
            pending_id, utterance_id, delegations = value
            await self._wait_delegations(s, delegations=delegations)
            retry = False
            async with s.lock:  # G2 재검사는 commit에서
                rt = self.rt(s)
                if (s.phase == Phase.ACTIVE and not s.closed and st.pending and st.pending.id == pending_id
                        and rt.latest_applied == utterance_id
                        and not any(d.get("needs") for d in delegations)
                        and (not rt.customer_turns or rt.customer_turns[-1].utterance_id == utterance_id)):
                    if all(d["done"].is_set() for d in delegations):
                        self._arm_commit(s, pending_id)
                    else:
                        retry = True
            if retry:
                await self._follow(s, "ask_confirm", pending_id)
        elif what == "ask_confirm_after_delegation":
            pending_id, utterance_id, delegations = value
            await self._wait_delegations(s, delegations=delegations)
            async with s.lock:
                rt = self.rt(s)
                if (s.phase != Phase.ACTIVE or not st.pending or st.pending.id != pending_id
                        or rt.latest_applied != utterance_id
                        or rt.customer_turns and rt.customer_turns[-1].utterance_id != utterance_id
                        or any(d.get("needs") or d.get("readback_sent_id") == pending_id for d in delegations)):
                    return
            await self._follow(s, "ask_confirm", pending_id)
        elif what == "ask_confirm":
            async with s.lock:
                pending = st.pending if st.pending and st.pending.id == value else None
                facts = None
                if pending and pending.kind == "cancel":
                    facts = {"confirmation": "ask_again", "cancel_target": _order_facts(pending.snapshot)}
                elif pending and st.current is not None:
                    facts = {"confirmation": "ask_again", "readback": readback_facts(pending.snapshot),
                             "readback_id": pending.id}
            if facts:
                s.note("확인 다시 묻기", value)
                await self.notify(s, "N2", facts, again=True)  # 두 번째 애매한 답에도 다시 묻는다(같은 내용 중복 제거 무시)
        elif what == "released":
            await self.notify(s, "N1'", {"confirmation": "cancelled_by_customer", "answer": value,
                                         "summary": state_summary(st, self.policy)})
        elif what == "intent":
            await self._on_intent(s, value)
        elif what == "greeting_order":
            await self._on_intent(s, "order", greeting_turn=value)
        elif what == "clarify_greeting":
            await self._clarify_greeting(s, value)
        elif what == "box_answer":
            await self._answer_box(s, *value)
        elif what == "lookup_picked":
            await self.notify(s, "N2", {"lookup_order": value})
        elif what == "destination_change":
            utterance, draft, buffered = value
            facts = {}
            if buffered:
                try:
                    out = await asyncio.wait_for(record_fields(s.tools, RecordArgs(**buffered), expected_draft=draft),
                                                 s.tools.tool_budget_sec)
                except TimeoutError:
                    facts["needs"] = [{"field": "receiver_address", "reason": "TOOL_TIMEOUT"}]
                else:
                    if out.code == "RESULT_SUPERSEDED":
                        return
                    facts.update(out.facts)
                    if out.needs:
                        facts["needs"] = out.needs
                    async with s.lock:
                        self._sync_intake(s)
            facts["summary"] = state_summary(st, self.policy)
            s.spawn(self.notify(s, "N2", facts, again=True, unless_tool_turn=utterance), "destination_change")
        elif what == "picked":
            async with s.lock:
                issued = issue_cancel_confirmation(st, s.tools.clock()) if st.intent == "cancel" else None
                summary = state_summary(st, self.policy)
            await self.notify(s, "N1'", {"picked": value, "summary": summary}
                              | ({"cancel_target": _order_facts(issued.snapshot)} if issued else {}))
        elif what in ("origin", "sender_change", "sender_name_scope"):
            async with s.lock:
                facts = self._origin_step(st) if what != "sender_name_scope" else {}
                destination = resume_destination(st)
                if destination:
                    facts.update(destination.facts)
                facts["summary"] = state_summary(st, self.policy)
                sender_change = destination is not None or what == "sender_name_scope" or st.current and (
                    st.current.sender_name_for_parcel or st.current.sender_address_change)
                if (sender_change and not sender_change_next(st) and not st.candidates
                        and st.pending and st.pending.kind == "parcel"):
                    facts["readback"] = readback_facts(st.pending.snapshot)
                    facts["readback_id"] = st.pending.id
            if sender_change or what == "sender_change" or facts.get("origin"):
                s.spawn(self.notify(s, "N2", facts, unless_tool_turn=value), "sender_change")
        elif what == "callback":  # 콜백 동의(yes) → 분석 hasCallbackRequest, 안내는 "담당자가 연락"
            s.note("콜백", value)
            await self.notify(s, "N2", {"agent": "callback_registered" if value == "yes" else "callback_declined"})
        elif what == "no_more":
            await self._wait_delegations(s)
            async with s.lock:
                st.no_more_parcels = True
                done = assess(st, self.policy).stage == "closing"
            if done:  # 접수 완료 단계 → 결과로 마무리 인사 뒤 끊는다
                await self._finish(s)
                return
            await self.notify(s, "N1'", {"more_parcels": False})
            self._maybe_submit(s)

    async def _answer_box(self, s: CallSession, box: BoxProposal, answer: str, utt: Spoken) -> None:
        await self._wait_delegations(s)  # 같은 발화에서 직접 말한 정정이 먼저 반영된다.
        async with s.lock:
            st, rt = s.state, self.rt(s)
            if (s.closed or st.intent != "order" or not st.current or st.current.box_proposal is not box
                    or rt.latest_applied != utt.utterance_id
                    or (rt.customer_turns and rt.customer_turns[-1].utterance_id > utt.utterance_id)):
                return
            if answer == "no":
                st.current.box_proposal = None
                st.bump()
        if answer == "no":
            await self.notify(s, "N2", {"box_proposal_declined": True})
            return
        ctx = replace(s.tools, item_utterance=(utt.utterance_id, utt.text))
        field = f"{box.size}_box_count"
        out = await record_fields(ctx, RecordArgs(add_item_counts=[field], **{field: box.count}), expected_box=box)
        if out.code == "RESULT_SUPERSEDED":
            return
        async with s.lock:
            self._sync_intake(s)
        facts = out.facts | {"summary": out.summary}
        if out.needs:
            facts["needs"] = out.needs
        await self.notify(s, "N2", facts)

    async def _on_intent(self, s: CallSession, intent: str, *, greeting_turn: Spoken | None = None) -> None:
        st = s.state
        if intent in BUSINESS:
            self._business(s, intent)
        async with s.lock:
            if intent == "end":
                if st.parcels and not st.no_more_parcels and assess(st, self.policy).stage == "more_parcels":
                    st.no_more_parcels = True
                    facts = {"more_parcels": False, "closing": True}
                else:
                    facts = {"closing": True}
            elif intent == "edit_parcel":
                facts = self._edit(s)
            elif intent == "cancel_current" and s.tools.draft_intake:
                target = self.svc.intake.current_target(s)
                if target:
                    st.selected_order, st.candidates = target, None
                    st.intent = "cancel"
                    issued = issue_cancel_confirmation(st, s.tools.clock())
                    facts = {"cancel_target": _order_facts(issued.snapshot)}
                else:
                    facts = {"cancel_current": "none"}
            elif intent == "agent":
                facts = self._agent_route(s)
            else:  # 조회·취소로 전환(받던 택배는 state.current에 그대로), 문의는 하던 업무를 바꾸지 않는다
                if intent in ("lookup", "cancel") or st.intent is None:
                    st.intent = intent
                facts = {"intent": st.intent}
                if st.intent == "order":
                    facts |= self._origin_step(st)  # 다음 질문의 기준(missing 첫 항목)을 같이 준다 — 없으면 Live가 순서 밖 질문을 지어냄(운영 통화 3a0b9c7f)
                    facts["summary"] = state_summary(st, self.policy)
                    if greeting_turn:
                        facts["greeting_confirmation"] = "confirmed"
        if facts.get("closing"):
            await self._wait_delegations(s)
            self._maybe_submit(s, force=True)
            facts["order"] = _order_status(s)
        if greeting_turn:
            # 이 발화의 도구는 Decision 반영을 기다린다. 안내가 도구를 기다리며 서로 막히지 않도록 별도 작업으로 보낸다.
            s.spawn(self.notify(s, "N2", facts, unless_tool_turn=greeting_turn), "greeting_order")
        else:
            await self.notify(s, "N2" if facts.get("closing") or "agent" in facts or "cancel_target" in facts else "N1'", facts)
        if facts.get("closing"):
            self.svc.begin_closing(s, "customer_end", after_speech=True,  # 마무리 인사 뒤 끊는다(S6: 결과 전송)
                                   remind=lambda: self.notify(s, "N2", facts, again=True))

    async def _finish(self, s: CallSession) -> None:
        """접수 완료 단계(assess closing): 결과를 closing_result_wait_sec까지 기다려 그 상태로 마무리 인사(N2 closing)를
        시키고 끊는다. 고객이 먼저 끝냈거나 이미 끝나는 중이면 하지 않는다."""
        if s.phase != Phase.ACTIVE:
            return
        self._maybe_submit(s, force=True)
        results = getattr(self.svc, "results", None)
        task = results.tasks.get(s.call_id) if results is not None else None
        if task is not None:
            t0 = time.monotonic()
            await asyncio.wait({task}, timeout=self.cfg.closing_result_wait_sec)  # 실패·초과여도 pending으로 마무리
            s.timing("마무리 결과 대기", (time.monotonic() - t0) * 1000)
        if s.phase != Phase.ACTIVE:
            return
        facts = {"more_parcels": False, "closing": True, "order": _order_status(s)}
        s.note("마무리", "접수 완료 단계")
        await self.notify(s, "N2", facts)
        self.svc.begin_closing(s, "flow_complete", after_speech=True,
                               remind=lambda: self.notify(s, "N2", facts, again=True))

    def _edit(self, s, *, use_lookup: bool = True) -> dict:
        from app.domain.store import open_for_edit
        st = s.state
        if st.order_submitted:  # 이미 보낸 결과는 고치지 않는다(다시 열면 '수정됐다'는 거짓 안내가 된다)
            return {"order": "submitted"}
        if s.tools.draft_intake and use_lookup and st.selected_order:
            target = st.selected_order
            if "draft_seq" not in target:
                return {"edit_parcel": "existing_order", "guidance": "기존 주문은 현재 통화 초안처럼 수정할 수 없다"}
            local_id = self.svc.intake.local_id(s, target["draft_seq"])
            if local_id and st.current and st.current.client_parcel_id == local_id:
                st.intent = "order"
                if st.pending and st.pending.kind == "cancel":
                    st.pending = None
                return {"edit_parcel": "current", "summary": state_summary(st, self.policy)}
            chosen = next((p for p in st.parcels if local_id and p.draft.client_parcel_id == local_id), None)
            if chosen is None:
                return {"edit_parcel": "unavailable"}
            open_for_edit(st, chosen.parcel_id)
            st.intent = "order"
            self._sync_intake(s)
            return {"edit_parcel": chosen.parcel_id, "summary": state_summary(st, self.policy)}
        if not st.parcels:
            return {"edit_parcel": "none"}
        if len(st.parcels) == 1:
            open_for_edit(st, st.parcels[0].parcel_id)
            self._sync_intake(s)
            return {"edit_parcel": st.parcels[0].parcel_id, "summary": state_summary(st, self.policy)}
        labels = tuple(f"{i}번 {p.draft['receiver_name'].value or '받는 분'}님 택배" for i, p in enumerate(st.parcels, 1))
        offer(st, "parcel", labels, tuple(p.parcel_id for p in st.parcels))
        return {"edit_parcel": "choose", "labels": list(labels)}

    def _origin_step(self, st) -> dict:
        """잠금 안. 등록 고객의 발송 주소 확인과 자동 입력을 안내한다."""
        c = st.customer
        if st.origin_applied or not c.customer_seq:
            return {}
        if st.origin_answer is None and c.origin_place and not st.field_of("sender_address").valid:
            st.origin_offered = True
            return {"origin_confirm": origin} if (origin := origin_confirmation(st)) else {}
        done = prefill_sender(st, full=st.origin_answer is True)
        st.origin_applied = True
        if "sender_address" in done:
            return {"origin": "prefilled"}
        if st.field_of("sender_address").valid:
            return {"origin": "address_recorded"}
        return {"origin": "name_only"} if done or st.origin_answer is not None else {}

    def _maybe_save_addresses(self, s: CallSession) -> None:
        """택배를 담았으면 묻지 않고 고객 정보·주소를 저장한다(백그라운드, 통화 중 — 기본 주소는 종료 후 409).
        담기 전(되읽기 중)에는 저장하지 않는다(사용자 결정 2026-11-06)."""
        st, results = s.state, getattr(self.svc, "results", None)
        offer = st.address_offer
        if not offer or not offer.get("parcel"):
            return
        st.address_offer = None
        snap = next((p.confirmed_snapshot for p in st.parcels if p.parcel_id == offer["parcel"]), None)
        if results is not None and snap:
            s.spawn(results.save_addresses(s, self.svc.call_session_seq, snap, offer), "address_save")

    def _agent_route(self, s: CallSession) -> dict:
        """잠금 안. 상담원 연결 요구(업무 규칙 e): 근무 시간 밖 → 콜백 제안, 안 + 전환 대상 있음 → 전환, 없음 → 담당자 연락."""
        st = s.state
        st.agent_transferred = True  # 연결 요구 여부(성공 아님)
        if not self._agent_hours(s.tools.now()):
            st.callback_offered = not st.callback_requested
            return {"agent": "callback_registered" if st.callback_requested else "callback_offer"}
        if self.cfg.agent_transfer_uri:
            s.spawn(self._transfer(s), "transfer")
            return {"agent": "transferring"}
        return {"agent": "not_configured"}

    def _agent_hours(self, now) -> bool:
        k = now.astimezone(KST)
        return k.weekday() in self.cfg.agent_days and \
            dtime.fromisoformat(self.cfg.agent_open) <= k.time() < dtime.fromisoformat(self.cfg.agent_close)

    async def _transfer(self, s: CallSession) -> None:
        """안내("바로 연결해 드리겠습니다")가 끝나면 통화 전환(SIP REFER, PBX 계약: 고객 동의 후에만). 실패 → 콜백 제안."""
        deadline = time.monotonic() + 10.0
        rt = self.rt(s)
        while time.monotonic() < deadline and (rt.await_speech or time.time() - s.last_output_t < 1.2):
            await asyncio.sleep(0.1)
        try:
            await self.svc.d.client.live.sessions.refer(s.call_id, target_uri=self.cfg.agent_transfer_uri)
            s.note("상담원 전환", "refer")
        except Exception as e:  # 전환 실패: 고객 탓 아님 — 콜백으로 안내
            s.note("상담원 전환 실패", type(e).__name__)
            async with s.lock:
                s.state.callback_offered = True
            await self.notify(s, "N2", {"agent": "transfer_failed"})

    def _count_unanswered(self, s: CallSession, out: dict) -> dict:
        """매뉴얼 검색이 설정 횟수만큼 연속 실패하면 상담원 연결을 권유한다. 성공하면 초기화한다."""
        rt = self.rt(s)
        if out.get("status") == "ok" and (out.get("facts") or {}).get("answerable"):
            rt.unanswered = 0
            return out
        rt.unanswered += 1
        if rt.unanswered < self.cfg.unanswered_agent_after:
            return out
        rt.unanswered = 0
        s.note("상담원 권유", "매뉴얼 연속 미답변")
        return out | {"facts": (out.get("facts") or {}) | {"agent": "suggest"}}

    # ------------------------------------------------------------------ S6: 등록·결과 전송(대화는 기다리지 않음)
    def _maybe_register(self, s: CallSession) -> None:
        """미등록 고객이 보내는 분 성함·주소·상세를 다 말하면 1번(원본 register_customer)."""
        results = getattr(self.svc, "results", None)
        c, cur = s.state.customer, s.state.current
        if results is None or c.status != "UNREGISTERED" or "register" in s.tools.ops or not s.caller or cur is None:
            return
        if s.tools.draft_intake and (not cur.sender_geo or len(s.caller) != 11):
            return
        if all(cur[n].valid for n in ("sender_name", "sender_address", "sender_address_detail")):
            s.tools.ops["register"] = {"status": "running"}
            s.spawn(results.register(s, self.svc.call_session_seq), "register")

    def _maybe_submit(self, s: CallSession, force: bool = False) -> None:
        """더 없음 + 결제 방식을 알면(또는 고객이 끝낼 때) 결과 전송을 백그라운드로 시작한다(결제는 묻지 않는다)."""
        results = getattr(self.svc, "results", None)
        if s.tools.draft_intake or results is None or s.call_id in results.tasks:
            return
        st = s.state
        a = assess(st, self.policy)
        ready = (st.parcels and st.no_more_parcels and (st.payment.valid or a.payment_auto)
                 and not st.candidates and not item_issues_pending(st))
        if force and (st.parcels or st.intent) or ready:
            st.order_submitted = bool(st.parcels)
            results.start(s, self._on_result)

    def _sync_intake(self, s: CallSession) -> asyncio.Task | None:
        """잠금 안에서 저장 순서를 고정하고, HTTP는 통화 작업에서 실행한다."""
        if s.tools.draft_intake and not s.closed and self.svc.intake.sync(s):
            return s.spawn(self.svc.intake.flush(s.call_id), "draft_save")
        return None

    async def _on_result(self, s: CallSession, data: dict) -> None:
        """통화 중에 결과가 오면 무음으로 사실만(마무리 안내에 쓴다). ACCEPTED만 접수 성공."""
        if s.phase in (Phase.ACTIVE, Phase.CLOSING):
            await self.notify(s, "N1'", {"order": _order_status(s)})

    def _business(self, s: CallSession, intent: str) -> None:
        """첫 업무 의도 → 2단계 고객 확인 1회(call-lifecycle.md §2.2)."""
        rt = self.rt(s)
        if s.state.intent is None:
            s.state.intent = intent
        elif intent == "order" and s.state.intent != "order":
            # 문의·조회 뒤 접수 도구를 부르면 접수로 바꾼다(그대로 두면 '더 없음'·마무리를 못 들음, 운영 통화 8df5dd7f)
            s.note("업무 전환", f"{s.state.intent}→order")
            s.state.intent = "order"
        if not rt.intent_started:
            rt.intent_started = True
            self.svc.stage2(s)

    # ------------------------------------------------------------------ 위임 → 함수 호출
    def on_delegation(self, s: CallSession, ev: dict) -> None:
        d = ev.get("delegation") or {}
        s.stats["위임"] += 1
        said = next((r["text"] for r in reversed(s.transcript) if r["speaker"] == "customer"), None)
        s.note("위임 시작", f"{(d.get('id') or '_')[-6:]} offset={ev.get('offset_ms')}",
               {"delegation": d.get("id"), "target": d.get("target"), "response_id": d.get("response_id"),
                "offset_ms": ev.get("offset_ms"), "last_customer": said})
        self.rt(s).delegations[d.get("id") or "_"] = {"offset_ms": ev.get("offset_ms"), "inflight": 0, "outputs": 0,
                                                       "completed": False, "done": asyncio.Event(), "t": time.time()}

    def _dl(self, s: CallSession, delegation_id) -> dict:
        return self.rt(s).delegations.setdefault(delegation_id or "_", {
            "offset_ms": None, "inflight": 0, "outputs": 0, "completed": False, "done": asyncio.Event(), "t": time.time()})

    def _open(self, s: CallSession) -> list[dict]:
        """진행 중으로 볼 위임: 끝나지 않았고 15초 안에 시작한 것(완료 이벤트를 못 받은 위임이 대기를 붙잡지 않게)."""
        now = time.time()
        return [d for d in self.rt(s).delegations.values() if not d["done"].is_set() and now - d["t"] < 15.0]

    def on_response(self, s: CallSession, ev: dict) -> None:
        inner = ev.get("event") or {}
        t, did = inner.get("type"), ev.get("delegation_id")
        if t == "response.output_item.done" and (inner.get("item") or {}).get("type") == "function_call":
            d = self._dl(s, did)
            d["inflight"] += 1
            item = inner["item"]
            s.note("함수 호출 도착", f"{str(did)[-6:]} {item.get('name')}",
                   {"delegation": did, "call_id": item.get("call_id"), "name": item.get("name"),
                    "arguments": _args(item.get("arguments"))})
            s.spawn(self.call_tool(s, did, item), "tool")
        elif t == "response.output_item.done" and (text := _item_text(inner.get("item") or {})):
            kind = "Backend 출력" if inner["item"].get("type") == "message" else "Backend 추론 요약"
            s.note(kind, text, {"delegation": did, "item_type": inner["item"].get("type")})
        elif t in ("response.completed", "response.failed", "response.incomplete"):
            d = self._dl(s, did)
            d["completed"] = True
            r = inner.get("response") or {}
            s.note("Backend 응답 끝", f"{str(did)[-6:]} {t.split('.')[-1]} inflight={d['inflight']}",
                   {"delegation": did, "status": r.get("status") or t.split(".")[-1], "error": r.get("error"),
                    "incomplete": r.get("incomplete_details"), "usage": r.get("usage"),
                    "elapsed_ms": round((time.time() - d["t"]) * 1000)})
            s.spawn(self.resume(s, did), "resume")
            if d["inflight"] == 0 and d["outputs"] == 0:
                d["done"].set()  # 최종 문장까지 끝남
                s.spawn(self._reopen_readback(s, d), "reopen")
        elif t == "response.created":
            self._dl(s, did)["completed"] = False

    async def call_tool(self, s: CallSession, did, item: dict) -> None:
        name, call_id = item.get("name"), item.get("call_id")
        d0 = self._dl(s, did)
        if not d0.get("tool_t"):  # 위임 시작 → 첫 함수 호출 도착(Backend 판단 시간)
            d0["tool_t"] = time.time()
            s.timing("위임→도구 호출", (d0["tool_t"] - d0["t"]) * 1000)
        st = s.state
        arguments = _args(item.get("arguments"))
        records_sender_name = name == "record_fields" and isinstance(arguments, dict) and bool(arguments.get("sender_name"))
        if ((st.origin_offered and st.origin_answer is None and not st.origin_applied) or sender_change_available(st)
                or name in ("record_fields", "find_destination", "get_state")
                and st.candidates and st.candidates.kind == "destination"
                or records_sender_name and st.customer.customer_seq):
            await self._customer_quiet(s)  # 고객 발화 끝에 보내는 분 변경을 판단한 뒤 그 발화의 값을 기록한다.
        await self._decided(s)
        if name in TOOL_INTENT:
            self._business(s, TOOL_INTENT[name])
        if name == "lookup_orders":
            await self.svc.call_session_seq(s)  # 2단계 통화 등록을 기다린다(실패면 도구가 CALL_NOT_REGISTERED)
        t0 = time.monotonic()
        view = {"name": name, "status": "실행 중", "arguments": item.get("arguments"), "args": arguments,
                "elapsed_ms": None, "output": None, "at": time.time(), "done_at": None, "delegation": did,
                "call_id": call_id}
        s.tool_calls.append(view)
        s.stats["도구"] += 1
        ctx = s.tools
        turns = self.rt(s).customer_turns
        readback_turn = turns[-1].utterance_id if turns else 0
        if name == "record_fields":
            offset = d0["offset_ms"]
            utterance = next((u for u in reversed(turns) if offset is not None
                              and u.start_ms <= offset <= u.end_ms + self.cfg.utterance_gap_ms), None)
            if not utterance and offset is None and len(turns) == 1:
                utterance = turns[0]
            if utterance:
                readback_turn = utterance.utterance_id
                if records_sender_name and utterance.scope_decided is not None:
                    await self._decided(s, utterance.scope_decided)
            ctx = replace(ctx, item_utterance=(utterance.utterance_id, utterance.text) if utterance else (0, ""),
                          sender_name_scope=utterance.sender_name_scope if utterance else None)
        with span("tool", tool=name):
            out = await run_tool(ctx, name, item.get("arguments") or "{}", call_id, allowed=MODEL_TOOLS)
        readback_id = (out.get("facts") or {}).get("readback_id")
        if readback_id:
            out = out | {"facts": {key: value for key, value in out["facts"].items() if key != "readback_id"}}
        view.update(status=out.get("code") or out["status"], output=out,
                    elapsed_ms=round((time.monotonic() - t0) * 1000), done_at=time.time())
        if out["status"] != "ok":
            d0["needs"] = True  # 재질문·실패 결과: 이 위임 끝에 되읽기를 다시 열지 않는다
        s.timing(f"도구 {name}", view["elapsed_ms"])
        if name in TOOL_LATENCY:
            s.measure(TOOL_LATENCY[name], view["elapsed_ms"])
        s.note("도구", f"{name} {out.get('code') or out['status']}")
        if name == "record_fields":
            self._maybe_register(s)
            if out.get("code") == "ITEM_PARCEL_UNCLEAR":
                async with s.lock:
                    selection = self._edit(s, use_lookup=False) if s.state.unassigned_item_issues else {}
                if selection:
                    out.setdefault("facts", {}).update(selection)
            if s.tools.draft_intake:
                await self.svc.call_session_seq(s)
                async with s.lock:
                    self._sync_intake(s)
        if name == "search_manual":
            out = self._count_unanswered(s, out)
        if name == "lookup_orders" and s.state.selected_order:  # 1건이면 바로 취소 확인 대기(의도가 취소일 때)
            async with s.lock:
                if s.state.intent == "cancel":
                    issued = issue_cancel_confirmation(s.state, s.tools.clock())
                    if issued:
                        out = out | {"facts": out.get("facts", {}) | {"cancel_target": _order_facts(issued.snapshot)}}
        view["output"] = out  # Live에 실제로 넘긴 결과(매뉴얼 미답변 집계·취소 대상이 덧붙은 것)
        s.changed()
        delivered = await self.send(s, {"type": "response.item.create", "item": {
            "type": "function_call_output", "call_id": call_id, "output": json.dumps(out, ensure_ascii=False)}})
        d = self._dl(s, did)
        if delivered and out.get("missing") is not None:
            d["summary_delivered"] = True
        d["readback_offer"] = (readback_id, readback_turn) if delivered and readback_id else None
        d["inflight"] -= 1
        d["outputs"] += 1
        if d["completed"]:
            await self.resume(s, did)
        else:  # response.completed가 끝내 안 오는 경우(F6): 결과를 넣었으면 재개해야 한다
            await asyncio.sleep(self.cfg.response_fallback_sec)
            await self.resume(s, did)

    async def resume(self, s: CallSession, did) -> None:
        """미결 호출이 없고 보낸 결과가 있으면 response.create 1회. 생략하면 Live가 멈춘다(S0b b3).
        고객이 끼어들어 말하는 중이면 말이 끝난 뒤 재개한다(앞선 결과를 고객 말 위에 얹지 않게)."""
        await self._customer_quiet(s)
        d = self._dl(s, did)
        if d["inflight"] == 0 and d["outputs"]:
            d["outputs"] = 0
            s.note("재개", str(did)[-6:])
            self.rt(s).await_speech = ("재개→AI 발화", time.time())
            offer = d.pop("readback_offer", None)
            marked = offer is not None and self._mark_readback(s, *offer)
            delivered = await self.send(s, {"type": "response.create"})
            if marked:
                if delivered:
                    d["readback_sent_id"] = offer[0]
                else:
                    self.rt(s).readback_id = None

    def _mark_readback(self, s: CallSession, pending_id: str, customer_turn: int) -> bool:
        rt, pending = self.rt(s), s.state.pending
        latest = rt.customer_turns[-1].utterance_id if rt.customer_turns else 0
        if (s.phase != Phase.ACTIVE or pending is None or pending.kind != "parcel" or pending.id != pending_id
                or customer_turn != latest or rt.cust is not None):
            return False
        rt.readback_id = pending_id
        return True

    def _delegation_in(self, s: CallSession, utt: Spoken) -> bool:
        return bool(self._delegations_for(s, utt))

    def _delegations_for(self, s: CallSession, utt: Spoken) -> list[dict]:
        lo, hi = utt.start_ms, utt.end_ms + self.cfg.utterance_gap_ms
        return [d for d in self._open(s) if d["offset_ms"] is not None and lo <= d["offset_ms"] <= hi]

    async def _wait_delegations(self, s: CallSession, timeout: float = 6.0, *, delegations: list[dict] | None = None) -> None:
        tasks = [asyncio.create_task(d["done"].wait()) for d in (self._open(s) if delegations is None else delegations)]
        if tasks:
            try:
                await asyncio.wait(tasks, timeout=timeout)
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()

    # ------------------------------------------------------------------ 전달(N1'/N2/N3)
    async def notify(self, s: CallSession, level: str, facts: dict, again: bool = False,
                     *, unless_tool_turn: Spoken | None = None) -> None:
        """N1' thinking(무음) · N2 commentary(말할 것, AI 발화가 멈춘 뒤·진행 위임 뒤) · N3 instructions(정정, 상한).
        again: 같은 내용이라도 다시 보낸다(마무리 인사 재요청)."""
        rt = self.rt(s)
        readback_id = facts.get("readback_id")
        readback_turn = rt.customer_turns[-1].utterance_id if rt.customer_turns else 0
        if readback_id:
            facts = {key: value for key, value in facts.items() if key != "readback_id"}
        content = json.dumps(facts, ensure_ascii=False, sort_keys=True)
        h = hashlib.sha256(f"{level}:{readback_id}:{content}".encode()).hexdigest()
        if h in rt.sent_hashes and not again:
            return  # 같은 내용 중복 송신 안 함(§6.3)
        rt.sent_hashes.add(h)
        if level == "N3":
            if rt.n3 >= self.cfg.n3_max:
                content = json.dumps({"agent_offer": True, "reason": "corrections_exceeded"}, ensure_ascii=False)
                level = "N2"  # P4: 3회 이후는 정정 대신 이관 제안 사실
            else:
                rt.n3 += 1
        if level == "N2":
            receipt_pid = facts.get("parcel_added") if facts.get("draft_intake") == "ready" else None
            t0 = time.monotonic()
            await self._wait_quiet(s, min_quiet_ms=self.cfg.utterance_gap_ms if receipt_pid else 0)
            if unless_tool_turn:
                turn = unless_tool_turn
                if not rt.customer_turns or rt.customer_turns[-1] != turn or s.state.intent != "order":
                    return
                if any(d.get("summary_delivered") and (not readback_id or d.get("readback_sent_id") == readback_id)
                       and d["offset_ms"] is not None
                       and turn.start_ms <= d["offset_ms"] <= turn.end_ms + self.cfg.utterance_gap_ms
                       for d in rt.delegations.values()):
                    return  # 같은 발화의 도구 결과가 이미 다음 질문에 필요한 최신 상태를 전달했다.
                facts = facts | {"summary": state_summary(s.state, self.policy)}
                if facts["summary"].get("sender_change_next") or s.state.current and s.state.current["sender_address"].valid:
                    facts.pop("origin_confirm", None)
                content = json.dumps(facts, ensure_ascii=False, sort_keys=True)
            if readback_id and not self._mark_readback(s, readback_id, readback_turn):
                return
            if facts.get("greeting_confirmation") == "ask_intent" and (
                    s.state.intent is not None or len(rt.customer_turns) != 1):
                return
            waited = time.monotonic() - t0
            s.timing("N2 대기(AI 발화 끝)", waited * 1000)
            if waited > 1.0:
                s.note("N2 대기", f"{waited:.1f}s")
            if receipt_pid:
                status = self.svc.intake.confirmed_status(s, receipt_pid)
                if status != "ready":
                    content = json.dumps(facts | {"draft_intake": status}, ensure_ascii=False, sort_keys=True)
                    receipt_pid = None
            rt.ready_notice = receipt_pid
        etype = {"N1'": "session.thinking.append", "N2": "session.commentary.append",
                 "N3": "session.instructions.append"}[level]
        s.stats[f"전달 {level}"] += 1
        s.note(f"전달 {level}", content[:200], {"content": json.loads(content)})
        if level == "N2" and facts.get("closing"):
            s.closing_requested_t = time.time()
        delivered = await self.send(s, {"type": etype, "delegation_id": None, "content": f"[서버 결과] {content}"[:1800]})
        if not delivered and readback_id and rt.readback_id == readback_id:
            rt.readback_id = None
        if level == "N2":
            rt.await_speech = ("N2→AI 발화", time.time())

    async def _wait_quiet(self, s: CallSession, timeout: float = 8.0, *, min_quiet_ms: int = 0) -> None:
        deadline = time.monotonic() + timeout
        quiet = max(self.cfg.notify_quiet_ms, min_quiet_ms) / 1000
        while time.monotonic() < deadline:
            busy = self.rt(s).cust is not None or any(d["inflight"] or d["offset_ms"] is not None for d in self._open(s))
            if not busy and time.time() - s.last_output_t >= quiet:
                return
            await asyncio.sleep(0.1)

    async def _customer_quiet(self, s: CallSession, timeout: float = 8.0) -> None:
        """고객 발화가 끝날 때까지(발화 끝 = 마지막 전사 뒤 utterance_gap_ms). 상한을 넘기면 그대로 진행한다."""
        deadline = time.monotonic() + timeout
        while self.rt(s).cust is not None and time.monotonic() < deadline:
            await asyncio.sleep(0.05)

    async def send(self, s: CallSession, event: dict) -> bool:
        if s.sideband is None or s.phase in (Phase.CLOSED, Phase.FAILED, Phase.FINALIZING, Phase.DONE):
            return False
        try:
            await s.sideband.send(event | {"event_id": s.next_event_id()})
        except Exception as e:
            log.warning("송신 실패 %s %s %s", s.call_id, event.get("type"), type(e).__name__)
            return False
        return True


def _transcript(s: CallSession, speaker: str, u: Spoken) -> None:
    """관제·통화 기록용 전사(개인정보 — 관제는 인증, logs/는 커밋 안 함). 발화 id로 묶어 갱신한다."""
    for row in reversed(s.transcript[-5:]):
        if row["id"] == u.utterance_id:
            row["text"] = u.text
            s.changed()
            return
    s.transcript.append({"id": u.utterance_id, "speaker": speaker, "text": u.text, "t": u.t_start})
    del s.transcript[:-300]
    s.changed()


def _args(raw) -> dict | str | None:
    """함수 호출 인수(JSON 문자열) → dict. 깨진 JSON은 원문 그대로(관제·기록용)."""
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def _item_text(item: dict) -> str:
    """Backend 출력 항목의 문장: message는 output_text, reasoning은 요약. 그 밖의 항목은 빈 문자열."""
    if item.get("type") == "message":
        parts = item.get("content") or []
    elif item.get("type") == "reasoning":
        parts = item.get("summary") or []
    else:
        return ""
    return "\n".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("text")).strip()


def _answer(a) -> tuple[str, float, dict]:
    probs = {str(p.value): p.probability for p in (a.probabilities or [])}
    return str(a.choice), float(a.confidence or 0), probs


def _last_question(text: str) -> str:
    return re.split(r"[.!?…]", text.rstrip(" .!?…"))[-1]


def _asked_pending_origin(state: ConversationState, text: str) -> bool:
    origin = origin_confirmation(state)
    if not origin or not asks(text):
        return False
    if origin == "registered" and REGISTERED_ORIGIN_QUESTION.search("".join(_last_question(text).split())):
        return True
    return _greeting_offer(state, text) == "registered_origin"


def _asked_receiver_name(text: str, expecting_name: bool) -> bool:
    question = _last_question(text)
    if not asks(text) or not re.search(r"성함|이름|누구", question):
        return False
    return bool(RECEIVER_NAME_QUESTION.search(question) or expecting_name and not SENDER_NAME_REFERENCE.search(question))


def _asked_destination(candidates: CandidateSet, text: str) -> bool:
    question = re.sub(r"[\s,.!?…~]+", "", _last_question(text))
    if candidates.destination_clarification:
        expected = DESTINATION_CHANGE_QUESTIONS[candidates.destination_clarification]
        return question == re.sub(r"[\s?]+", "", expected)
    return (bool(re.search(r"보내|받는|받으", question))
            and any("".join(place.name.split()) in question for place in candidates.items if place.name))


def _explicit_destination_reply(candidates: CandidateSet, question: str, text: str) -> str | None:
    if len(candidates.items) != 1 or not _asked_destination(candidates, question):
        return None
    compact = re.sub(r"[\s,.!?…~]+", "", text)
    if DESTINATION_OTHER_TASK.search(compact):
        return None
    address_changed = DESTINATION_OTHER_ADDRESS.search(compact)
    person_changed = DESTINATION_OTHER_PERSON.search(compact)
    if address_changed and person_changed:
        return None
    if candidates.destination_clarification in ("recipient", "address"):
        if SHORT_YES.fullmatch(compact) or (re.match(r"\s*(?:네|예|맞아요|맞습니다)[ ,.]", text)
                                              and not re.search(r"아니|안맞|맞지않", compact)):
            if candidates.destination_clarification == "recipient" and not person_changed:
                return "new_address_1"
            if candidates.destination_clarification == "address" and not address_changed:
                return "new_recipient_1"
    if address_changed:
        name = re.escape("".join(candidates.items[0].name.split()))
        same_person = re.search(rf"(?:그분|그사람|받는분|수신인|{name})(?:님)?(?:한테|에게|은|는|이|가)?"
                                r"(?:그대로보내(?!지않|지말)|맞아요|맞습니다|맞고|같아요|같고)", compact)
        if same_person or re.search(r"주소만(?:바꿀|바꾸|바꿔|변경)", compact):
            return "new_address_1"
        return "clarify_recipient"
    if person_changed:
        if re.search(r"(?:같은|동일한)주소|(?:주소|받는곳)(?:가|는)?(?:그대로|맞아요|맞고|같아요|같고)|(?:받는분|수신인)만(?:바꿀|바꾸|바꿔|변경)", compact):
            return "new_recipient_1"
        return "clarify_address"
    return None


def _greeting_offer(state: ConversationState, text: str) -> str | None:
    """첫 인사에서 실제로 들려준 접수 질문과 등록 주소를 대조한다."""
    question = _last_question(text)
    place = state.customer.origin_place
    location = re.search(r"(.+?)에서\s*(?:발송|보내)", question)
    offered_origin = state.origin_offered and place and place.address and location
    short_question = re.search(r"(?:발송하시나요|발송하실까요|보내시나요|보내실까요)$", "".join(question.split()))
    if not asks(text) or not (GREETING_ORDER.search("".join(question.split())) or offered_origin and short_question):
        return None
    if not offered_origin:
        return "order"
    spoken = clean_text(re.split(r"님\s*[,，]?\s*", location[1], maxsplit=1)[-1])
    heard_parts = [part for form in (spoken, split_gil(spoken), unlink_gil(spoken)) if form for part in parse(form)]
    for expected, branch, number in parse(clean_text(place.address)):
        if not number:
            continue
        for heard, heard_branch, heard_number in heard_parts:
            if (heard_branch, heard_number) != (branch, number):
                continue
            if heard == expected:
                return "registered_origin"
            if expected[0].endswith(("특별시", "광역시", "도", "특별자치시")) and heard[1:] == expected[1:] \
                    and heard[0] in sido_aliases(expected[0]):
                return "registered_origin"
    return "origin_mentioned"


def _order_status(s: CallSession) -> dict:
    """결과 상태 사실(정책 [results].order). 응답 전이면 pending."""
    data = s.result or {}
    if not data:
        return {"status": "pending"}
    out = {"status": data.get("status")}
    if data.get("status") == "ACCEPTED" and data.get("parcelNo"):
        out["parcelNo"] = data["parcelNo"]
    return out


def _order_facts(order: dict) -> dict:
    """취소 확인 때 읽을 것: 받는 분·상태만(주소는 시·구 수준으로 Live가 읽는다)."""
    return {"receiver_name": order.get("receiver_name"), "status": order.get("status"),
            "status_text": status_text(order.get("status"))}

