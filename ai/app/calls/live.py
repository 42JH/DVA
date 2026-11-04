"""S5: 통화 중 흐름 — 함수 호출 라우터 · 발화 끝 Decision · 확인 관문 · 서버 결과 전달(N1'/N2/N3) · 결과 문구 검사.

CallService.handlers에 붙는 동기 핸들러(상태 갱신 + 작업 생성만)와, 잠금 밖에서 I/O 하는 작업으로 나뉜다(concurrency.md §3).
설계: delegation.md v3.1 §3(발화 끝 Decision)·§4(경로·복합 발화 R1~R6)·§6(전달 등급), conversation-state.md §5(관문).
"""

import asyncio
from datetime import time as dtime
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field

from app.calls.session import CallSession, Phase
from app.domain.rules import KST
from app.domain.assess import assess, readback_facts
from app.domain.candidates import apply_pick, offer, reject_candidates
from app.domain.claims import truth, unverified_claims
from app.domain.confirm import (ConfirmAnswer, Utterance, check_gate, commit_parcel, issue_cancel_confirmation,
                                release, take_cancel)
from app.observability.trace import span
from app.policy.render import decision_questions
from app.tools import MODEL_TOOLS, run_tool
from app.tools.cancel import cancel_parcel
from app.tools.outcome import state_summary

log = logging.getLogger(__name__)
BUSINESS = ("order", "lookup", "cancel", "inquiry", "agent")
TOOL_INTENT = {"record_fields": "order", "find_destination": "order", "lookup_orders": "lookup",
               "search_manual": "inquiry"}


@dataclass
class Spoken:
    utterance_id: int
    text: str
    start_ms: int
    end_ms: int
    t_start: float
    t_last: float

    def utterance(self) -> Utterance:
        return Utterance(self.utterance_id, self.start_ms or 0, self.end_ms or 0, self.t_start, self.text)


@dataclass
class Runtime:
    """통화별 S5 상태(세션에 붙는다). 업무 값은 state에만 있다."""
    cust: Spoken | None = None
    seq: int = 0
    ai: list[Spoken] = field(default_factory=list)   # 최근 AI 발화(직전 AI 발화·G3)
    endpoint: asyncio.TimerHandle | None = None
    ai_end: asyncio.TimerHandle | None = None
    latest_applied: int = 0                           # 적용한 가장 최근 고객 발화 id(DECISION_STALE)
    delegations: dict[str, dict] = field(default_factory=dict)  # delegation_id → {offset_ms, inflight, outputs, completed}
    commit: asyncio.TimerHandle | None = None
    commit_pid: str | None = None
    n3: int = 0
    sent_hashes: set[str] = field(default_factory=set)
    intent_started: bool = False
    unanswered: int = 0                               # 매뉴얼 검색이 연속으로 답을 못 한 횟수(3회 → 상담원 권유, 답하면 0)
    cust_end_t: float = 0.0                           # 관제: 마지막 고객 발화 끝(→ AI 말 시작)
    await_speech: tuple[str, float] | None = None     # 관제: (구간 이름, 시작) — 다음 AI 발화 시작까지
    confirm_t: float = 0.0                            # 관제: 확인 "네" 발화 끝(→ 담기)

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
            rt.seq += 1
            rt.cust = Spoken(rt.seq, "", ev.get("start_ms") or 0, ev.get("end_ms") or 0, now, now)
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
        if last and now - last.t_last <= self.cfg.utterance_gap_ms / 1000:
            last.text += ev.get("delta", "")
            last.end_ms, last.t_last = ev.get("end_ms") or last.end_ms, now
        else:
            rt.seq += 1
            rt.ai.append(Spoken(rt.seq, ev.get("delta", ""), ev.get("start_ms") or 0, ev.get("end_ms") or 0, now, now))
            del rt.ai[:-20]
            if rt.cust_end_t:  # 새 AI 발화 시작 = 고객 말 끝 뒤 첫 반응
                s.timing("고객 말 끝→AI 말 시작", (now - rt.cust_end_t) * 1000)
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
            s.spawn(self.judge(s, utt, prev), "decision")

    def _ai_done(self, s: CallSession) -> None:
        """AI 발화 끝: 결과 문구 검사(LLM 없음, delegation.md §6.2-5)."""
        rt = self.rt(s)
        rt.ai_end = None
        if rt.ai and (claims := unverified_claims(rt.ai[-1].text, s.state, self.policy)):
            s.note("결과 문구", ",".join(claims))
            s.spawn(self.notify(s, "N3", {"unverified": claims, "truth": truth(s.state)}), "n3")

    # ------------------------------------------------------------------ 발화 끝 Decision
    async def judge(self, s: CallSession, utt: Spoken, prev: Spoken | None) -> None:
        async with s.lock:
            stage = assess(s.state, self.policy).stage
            pending = s.state.pending
            pick = s.state.candidates.labels if s.state.candidates else ()
            pending_id = pending.id if pending else None
            methods = s.state.customer.payment_methods
            callback = s.state.callback_offered and not s.state.callback_requested
            save = bool(s.state.address_offer) and s.state.address_consent is None
        questions = decision_questions(self.policy, stage, pending=pending is not None, pick_labels=pick,
                                       pay_methods=methods, callback=callback, save=save)
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
            s.note("Decision", f"DECISION_TIMEOUT >{self.cfg.decision_budget_sec * 1000:.0f}ms 입력 {len(text)}자")
            # 늦은 답은 쓰지 않고 실제 응답 시간만 남긴다(예산 조정 근거). 추가 호출 없음
            call.add_done_callback(lambda f: f.cancelled() or f.exception() or s.note(
                "Decision 늦은 응답", f"{(time.monotonic() - started) * 1000:.0f}ms") or s.timing(
                "Decision(시간 초과분)", (time.monotonic() - started) * 1000))
            return
        except Exception as e:
            s.note("Decision", f"DECISION_UNAVAILABLE {type(e).__name__}")
            return
        ms = round((time.monotonic() - started) * 1000)
        s.decision_ms.append(ms)
        s.timing("Decision", ms)
        answers = {a.name: _answer(a) for a in d.answers if a.type == "choice"}
        s.note("Decision", ", ".join(f"{k}={v[0]}({v[1]:.2f})" for k, v in answers.items()) + f" {ms}ms")
        await self.apply(s, utt, prev, answers, pending_id)

    async def apply(self, s: CallSession, utt: Spoken, prev: Spoken | None, answers: dict, pending_id: str | None):
        rt, st, th = self.rt(s), s.state, self.cfg.decision_min_confidence
        followups = []
        async with s.lock:
            if s.closed or utt.utterance_id < rt.latest_applied:
                s.note("Decision", "DECISION_STALE")
                return
            rt.latest_applied = utt.utterance_id
            if "confirm" in answers and pending_id:
                followups.append(self._on_confirm(s, utt, prev, answers["confirm"], pending_id))
            if (p := answers.get("pick")) and p[1] >= th:
                if p[0] == "none":
                    reject_candidates(st)
                elif p[0] != "not_answer" and apply_pick(st, p[0]):
                    followups.append(("picked", p[0]))
            if (t := answers.get("task")) and t[1] >= th and t[0] in BUSINESS + ("end",):
                followups.append(("intent", t[0]))
            if (w := answers.get("switch")) and w[1] >= th and w[0] != "none":
                followups.append(("intent", w[0]))
            if (m := answers.get("more")) and m[1] >= th and m[0] == "no_more" and st.parcels:
                followups.append(("no_more", None))
            if (sv := answers.get("save")) and sv[1] >= th and sv[0] in ("yes", "no") and st.address_offer \
                    and st.address_consent is None:
                st.address_consent = sv[0] == "yes"
                s.note("주소 저장 동의", sv[0])
                followups.append(("save", None))
            if (cb := answers.get("callback")) and cb[1] >= th and cb[0] in ("yes", "no") and st.callback_offered:
                st.callback_offered = False
                st.callback_requested = cb[0] == "yes"
                followups.append(("callback", cb[0]))
            if (pay := answers.get("pay")) and pay[1] >= th and pay[0] in st.customer.payment_methods:
                st.record("payment", pay[0])
                followups.append(("payment", pay[0]))
        for f in followups:
            if f:
                await self._follow(s, *f)

    def _on_confirm(self, s: CallSession, utt: Spoken, prev: Spoken | None, ans: tuple, pending_id: str):
        """잠금 안. yes → 관문(G1~G5) → G6(같은 발화 위임 보류) → 확정 지연 / no·change → 즉시 해제."""
        choice, conf, probs = ans
        st, rt = s.state, self.rt(s)
        if choice in ("no", "change") and probs.get(choice, 0) >= self.cfg.decision_min_confidence:
            release(st, pending_id)
            return ("released", choice)
        if choice == "proceed" and conf >= self.cfg.decision_min_confidence:
            return ("ask_confirm", pending_id)  # 질문 없이 "접수해 주세요": 확정하지 않고 확인 질문을 다시 하게 한다
        if choice != "yes":
            return None
        gate = check_gate(st, self.policy, pending_id, ConfirmAnswer(choice, probs), utt.utterance(),
                          prev.utterance() if prev else None, latest_applied_utterance=None, closed=s.closed)
        if not gate.ok:
            s.note("확인 관문", gate.code)
            return None
        if self._delegation_in(s, utt):  # G6: 같은 발화의 위임이 끝난 뒤 다시 본다
            s.note("확인 관문", "COMMIT_HELD_FOR_DELEGATION")
            rt.confirm_t = utt.t_last
            return ("hold", pending_id)
        rt.confirm_t = utt.t_last
        self._arm_commit(s, pending_id)
        return None

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
                target = None
            else:
                target = take_cancel(s.state, self.policy, pending_id)
                facts = None
        if kind == "parcel":
            self._maybe_save_addresses(s)
            if facts:
                s.note("담기", facts["parcel_added"])
                await self.notify(s, "N2", facts | {"summary": state_summary(s.state, self.policy)})
            return
        if target:  # 취소: 서버 전용 실행, 결과는 N2
            out = await cancel_parcel(s.tools, target["order_seq"], target["order_parcel_seq"])
            s.note("취소", out.code or out.facts.get("outcome", out.status))
            await self.notify(s, "N2", {"cancel": out.to_output()})

    async def _follow(self, s: CallSession, what: str, value) -> None:
        st = s.state
        if what == "hold":
            await self._wait_delegations(s)
            async with s.lock:  # G2 재검사는 commit에서
                if st.pending and st.pending.id == value:
                    self._arm_commit(s, value)
        elif what == "ask_confirm":
            async with s.lock:
                pending = st.pending if st.pending and st.pending.id == value else None
                facts = None
                if pending and st.current is not None:
                    sources = {n: f.source for n, f in st.current.fields.items()}
                    facts = {"confirmation": "ask_again", "readback": readback_facts(pending.snapshot, sources, self.policy)}
            if facts:
                s.note("확인 다시 묻기", value)
                await self.notify(s, "N2", facts)
        elif what == "released":
            await self.notify(s, "N1'", {"confirmation": "cancelled_by_customer", "answer": value,
                                         "summary": state_summary(st, self.policy)})
        elif what == "intent":
            await self._on_intent(s, value)
        elif what == "picked":
            async with s.lock:
                issued = issue_cancel_confirmation(st, s.tools.clock()) if st.selected_order else None
                summary = state_summary(st, self.policy)
            await self.notify(s, "N1'", {"picked": value, "summary": summary}
                              | ({"cancel_target": _order_facts(issued.snapshot)} if issued else {}))
        elif what == "save":
            self._maybe_save_addresses(s)
        elif what == "callback":  # 콜백 동의(yes) → 분석 hasCallbackRequest, 안내는 "담당자가 연락"
            s.note("콜백", value)
            await self.notify(s, "N2", {"agent": "callback_registered" if value == "yes" else "callback_declined"})
        elif what == "payment":
            await self.notify(s, "N1'", {"payment": value})
            self._maybe_submit(s)
        elif what == "no_more":  # 더 없음: 마무리는 고객이 끝낼 때(문의가 남았을 수 있다)
            async with s.lock:
                st.no_more_parcels = True
                a = assess(st, self.policy)
            facts = {"more_parcels": False}
            if a.stage == "payment":
                facts["payment_choice"] = list(st.customer.payment_methods)
            await self.notify(s, "N1'", facts)
            self._maybe_submit(s)

    async def _on_intent(self, s: CallSession, intent: str) -> None:
        st = s.state
        if intent in BUSINESS:
            self._business(s, intent)
        async with s.lock:
            if intent == "end":
                if st.parcels and not st.no_more_parcels and assess(st, self.policy).stage == "more_parcels":
                    st.no_more_parcels = True
                    a = assess(st, self.policy)
                    if a.stage == "payment":
                        facts = {"more_parcels": False, "payment_choice": list(st.customer.payment_methods)}
                    else:
                        facts = {"more_parcels": False, "closing": True}
                else:
                    facts = {"closing": True}
            elif intent == "edit_parcel":
                facts = self._edit(st)
            elif intent == "agent":
                facts = self._agent_route(s)
            else:  # 조회·취소로 전환(받던 택배는 state.current에 그대로), 문의는 하던 업무를 바꾸지 않는다
                if intent in ("lookup", "cancel") or st.intent is None:
                    st.intent = intent
                facts = {"intent": st.intent}
                if st.intent == "order":  # 다음 질문의 기준(missing 첫 항목)을 같이 준다 — 없으면 Live가 순서 밖 질문을 지어냄(운영 통화 3a0b9c7f)
                    facts["summary"] = state_summary(st, self.policy)
        if facts.get("closing"):
            self._maybe_submit(s, force=True)
            facts["order"] = _order_status(s)
        await self.notify(s, "N2" if facts.get("closing") or "agent" in facts else "N1'", facts)
        if facts.get("closing"):
            self.svc.begin_closing(s, "customer_end", after_speech=True)  # 마무리 인사 뒤 끊는다(S6: 결과 전송)

    def _edit(self, st) -> dict:
        from app.domain.store import open_for_edit
        if st.order_submitted:  # 이미 보낸 결과는 고치지 않는다(다시 열면 '수정됐다'는 거짓 안내가 된다)
            return {"order": "submitted"}
        if not st.parcels:
            return {"edit_parcel": "none"}
        if len(st.parcels) == 1:
            open_for_edit(st, st.parcels[0].parcel_id)
            return {"edit_parcel": st.parcels[0].parcel_id, "summary": state_summary(st, self.policy)}
        labels = tuple(f"{i}번 {p.draft['receiver_name'].value or '받는 분'}님 택배" for i, p in enumerate(st.parcels, 1))
        offer(st, "parcel", labels, tuple(p.parcel_id for p in st.parcels))
        return {"edit_parcel": "choose", "labels": list(labels)}

    def _maybe_save_addresses(self, s: CallSession) -> None:
        """택배를 담았고 고객이 저장에 동의했으면 고객 기본 주소·주소록 저장(백그라운드, 통화 중 — 기본 주소는 종료 후 409)."""
        st, results = s.state, getattr(self.svc, "results", None)
        offer = st.address_offer
        if results is None or not offer or not offer.get("parcel") or not st.address_consent:
            if offer and offer.get("parcel") and st.address_consent is False:
                st.address_offer = None
            return
        snap = next((p.confirmed_snapshot for p in st.parcels if p.parcel_id == offer["parcel"]), None)
        st.address_offer = None
        if snap:
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
        """같은 질문에 3번 연속 답을 못 드리면 상담원 연결 권유(업무 규칙). 답이 나오면 0으로.
        shortcut: 질문이 같은지 보지 않고 연속 실패만 센다 — 다른 질문으로 바뀌어도 이어 센다."""
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
        if all(cur[n].valid for n in ("sender_name", "sender_address", "sender_address_detail")):
            s.tools.ops["register"] = {"status": "running"}
            s.spawn(results.register(s, self.svc.call_session_seq), "register")

    def _maybe_submit(self, s: CallSession, force: bool = False) -> None:
        """더 없음 + 결제 방식이 정해졌으면(또는 고객이 끝낼 때) 결과 전송을 백그라운드로 시작한다."""
        results = getattr(self.svc, "results", None)
        if results is None or s.call_id in results.tasks:
            return
        st = s.state
        a = assess(st, self.policy)
        ready = st.parcels and st.no_more_parcels and (st.payment.valid or a.payment_auto) and not st.candidates
        if force and (st.parcels or st.intent) or ready:
            st.order_submitted = bool(st.parcels)
            results.start(s, self._on_result)

    async def _on_result(self, s: CallSession, data: dict) -> None:
        """통화 중에 결과가 오면 무음으로 사실만(마무리 안내에 쓴다). ACCEPTED만 접수 성공."""
        if s.phase in (Phase.ACTIVE, Phase.CLOSING):
            await self.notify(s, "N1'", {"order": _order_status(s)})

    def _business(self, s: CallSession, intent: str) -> None:
        """첫 업무 의도 → 2단계 고객 확인 1회(call-lifecycle.md §2.2)."""
        rt = self.rt(s)
        if s.state.intent is None:
            s.state.intent = intent
        if not rt.intent_started:
            rt.intent_started = True
            self.svc.stage2(s)

    # ------------------------------------------------------------------ 위임 → 함수 호출
    def on_delegation(self, s: CallSession, ev: dict) -> None:
        d = ev.get("delegation") or {}
        s.stats["위임"] += 1
        s.note("위임 시작", f"{(d.get('id') or '_')[-6:]} offset={ev.get('offset_ms')}")
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
            s.note("함수 호출 도착", f"{str(did)[-6:]} {(inner.get('item') or {}).get('name')}")
            s.spawn(self.call_tool(s, did, inner["item"]), "tool")
        elif t in ("response.completed", "response.failed", "response.incomplete"):
            d = self._dl(s, did)
            d["completed"] = True
            s.note("Backend 응답 끝", f"{str(did)[-6:]} {t.split('.')[-1]} inflight={d['inflight']}")
            s.spawn(self.resume(s, did), "resume")
            if d["inflight"] == 0 and d["outputs"] == 0:
                d["done"].set()  # 최종 문장까지 끝남
        elif t == "response.created":
            self._dl(s, did)["completed"] = False

    async def call_tool(self, s: CallSession, did, item: dict) -> None:
        name, call_id = item.get("name"), item.get("call_id")
        d0 = self._dl(s, did)
        if not d0.get("tool_t"):  # 위임 시작 → 첫 함수 호출 도착(Backend 판단 시간)
            d0["tool_t"] = time.time()
            s.timing("위임→도구 호출", (d0["tool_t"] - d0["t"]) * 1000)
        if name in TOOL_INTENT:
            self._business(s, TOOL_INTENT[name])
        if name == "lookup_orders":
            await self.svc.call_session_seq(s)  # 2단계 통화 등록을 기다린다(실패면 도구가 CALL_NOT_REGISTERED)
        t0 = time.monotonic()
        view = {"name": name, "status": "실행 중", "arguments": item.get("arguments"), "elapsed_ms": None, "output": None,
                "at": time.time()}
        s.tool_calls.append(view)
        s.stats["도구"] += 1
        with span("tool", tool=name):
            out = await run_tool(s.tools, name, item.get("arguments") or "{}", call_id, allowed=MODEL_TOOLS)
        view.update(status=out.get("code") or out["status"], output=out,
                    elapsed_ms=round((time.monotonic() - t0) * 1000))
        s.timing(f"도구 {name}", view["elapsed_ms"])
        s.note("도구", f"{name} {out.get('code') or out['status']}")
        if name == "record_fields":
            self._maybe_register(s)
        if name == "search_manual":
            out = self._count_unanswered(s, out)
        if name == "lookup_orders" and s.state.selected_order:  # 1건이면 바로 취소 확인 대기(의도가 취소일 때)
            async with s.lock:
                if s.state.intent == "cancel":
                    issued = issue_cancel_confirmation(s.state, s.tools.clock())
                    if issued:
                        out = out | {"facts": out.get("facts", {}) | {"cancel_target": _order_facts(issued.snapshot)}}
        await self.send(s, {"type": "response.item.create", "item": {
            "type": "function_call_output", "call_id": call_id, "output": json.dumps(out, ensure_ascii=False)}})
        d = self._dl(s, did)
        d["inflight"] -= 1
        d["outputs"] += 1
        if d["completed"]:
            await self.resume(s, did)
        else:  # response.completed가 끝내 안 오는 경우(F6): 결과를 넣었으면 재개해야 한다
            await asyncio.sleep(self.cfg.response_fallback_sec)
            await self.resume(s, did)

    async def resume(self, s: CallSession, did) -> None:
        """미결 호출이 없고 보낸 결과가 있으면 response.create 1회. 생략하면 Live가 멈춘다(S0b b3)."""
        d = self._dl(s, did)
        if d["inflight"] == 0 and d["outputs"]:
            d["outputs"] = 0
            s.note("재개", str(did)[-6:])
            self.rt(s).await_speech = ("재개→AI 발화", time.time())
            await self.send(s, {"type": "response.create"})

    def _delegation_in(self, s: CallSession, utt: Spoken) -> bool:
        lo, hi = utt.start_ms, utt.end_ms + self.cfg.utterance_gap_ms
        return any(d["offset_ms"] is not None and lo <= d["offset_ms"] <= hi for d in self._open(s))

    async def _wait_delegations(self, s: CallSession, timeout: float = 6.0) -> None:
        events = [d["done"] for d in self._open(s)]
        if events:
            await asyncio.wait([asyncio.create_task(e.wait()) for e in events], timeout=timeout)

    # ------------------------------------------------------------------ 전달(N1'/N2/N3)
    async def notify(self, s: CallSession, level: str, facts: dict) -> None:
        """N1' thinking(무음) · N2 commentary(말할 것, AI 발화가 멈춘 뒤·진행 위임 뒤) · N3 instructions(정정, 상한)."""
        rt = self.rt(s)
        content = json.dumps(facts, ensure_ascii=False, sort_keys=True)
        h = hashlib.sha256(f"{level}:{content}".encode()).hexdigest()
        if h in rt.sent_hashes:
            return  # 같은 내용 중복 송신 안 함(§6.3)
        rt.sent_hashes.add(h)
        if level == "N3":
            if rt.n3 >= self.cfg.n3_max:
                content = json.dumps({"agent_offer": True, "reason": "corrections_exceeded"}, ensure_ascii=False)
                level = "N2"  # P4: 3회 이후는 정정 대신 이관 제안 사실
            else:
                rt.n3 += 1
        if level == "N2":
            t0 = time.monotonic()
            await self._wait_quiet(s)
            waited = time.monotonic() - t0
            s.timing("N2 대기(AI 발화 끝)", waited * 1000)
            if waited > 1.0:
                s.note("N2 대기", f"{waited:.1f}s")
        etype = {"N1'": "session.thinking.append", "N2": "session.commentary.append",
                 "N3": "session.instructions.append"}[level]
        s.stats[f"전달 {level}"] += 1
        s.note(f"전달 {level}", content[:200])
        await self.send(s, {"type": etype, "delegation_id": None, "content": f"[서버 결과] {content}"[:1800]})
        if level == "N2":
            rt.await_speech = ("N2→AI 발화", time.time())

    async def _wait_quiet(self, s: CallSession, timeout: float = 8.0) -> None:
        deadline = time.monotonic() + timeout
        quiet = self.cfg.notify_quiet_ms / 1000
        while time.monotonic() < deadline:
            busy = any(d["inflight"] or d["offset_ms"] is not None for d in self._open(s))
            if not busy and time.time() - s.last_output_t >= quiet:
                return
            await asyncio.sleep(0.1)

    async def send(self, s: CallSession, event: dict) -> None:
        if s.sideband is None or s.phase in (Phase.CLOSED, Phase.FAILED, Phase.FINALIZING, Phase.DONE):
            return
        try:
            await s.sideband.send(event | {"event_id": s.next_event_id()})
        except Exception as e:
            log.warning("송신 실패 %s %s %s", s.call_id, event.get("type"), type(e).__name__)


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


def _answer(a) -> tuple[str, float, dict]:
    probs = {str(p.value): p.probability for p in (a.probabilities or [])}
    return str(a.choice), float(a.confidence or 0), probs


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
    return {"receiver_name": order.get("receiver_name"), "status": order.get("status")}

