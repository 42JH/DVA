"""Plan one customer turn on a detached copy of the call's business state."""

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import datetime

from openai import APIError

from app.calls import decision_input
from app.calls.backend_turn import BackendTurn
from app.config import CallConfig
from app.domain.address_book import (begin_sender_name_change, origin_confirmation, prefill_sender,
                                     receiver_questions_deferred, request_sender_address_change,
                                     sender_change_available, sender_change_next)
from app.domain.assess import assess
from app.domain.candidates import apply_pick, reject_candidates
from app.domain.confirm import (ConfirmAnswer, Utterance, check_gate, commit_parcel, explicitly_requests_parcel,
                                issue_cancel_confirmation, release)
from app.domain.state import ConversationState
from app.domain.store import hold_unclassified_items
from app.policy.model import Policy
from app.policy.render import decision_questions
from app.tools.context import ToolContext
from app.tools.lookup import lookup_order_facts, resume_destination
from app.tools.outcome import state_summary
from app.tools.record import RecordArgs, record_fields

SHORT_YES = re.compile(r"(?:아|어|음)?(?:네|예|응|맞아요|맞습니다|그렇습니다)+")
SHORT_NO = re.compile(r"(?:아|어|음)?(?:아니|아니요|아뇨|아닙니다)+")
ACTION_CONFIDENCE = 0.85
EXITS = ("end", "agent", "cancel", "cancel_current")
NOT_AN_ANSWER = ("not_answer", "none", "chit_chat", "unclear", "other")


@dataclass(frozen=True)
class TurnInput:
    state: ConversationState
    customer: Utterance
    previous: Utterance | None
    now: datetime
    greeting: str | None = None
    origin_question: bool = False
    destination: str | None = None
    pick_allowed: bool = False
    end_question: bool = False
    end_waiting: bool = False
    spoken_question: str | None = None
    receiver_name_answer: bool = False
    recent_ai: str | None = None      # 마지막 고객 발화 이후 AI가 한 말 전체(없으면 previous)
    said: str | None = None           # 끊어진 앞 조각을 이어 붙인 고객 발화(없으면 customer)
    tools: ToolContext | None = None
    before_lookup: Callable[[], Awaitable[None]] | None = None


@dataclass(frozen=True)
class TurnState:
    fields: dict
    next_question: str
    parcels: int
    candidate_kind: str | None


@dataclass(frozen=True)
class TurnResult:
    state: TurnState
    route: str
    status: str = "ok"
    tool_calls: int = 0
    address_unverified: bool = False
    facts: dict = field(default_factory=dict)
    commit_pending: str | None = None
    decision: dict | None = None      # 통화 기록용: 입력·열린 질문·답


def observe_turn(state: ConversationState, policy: Policy, action: str | None = None) -> TurnState:
    summary = state_summary(state, policy)
    fields = {name: field.value for name, field in state.current.fields.items()
              if field.valid and policy.fields[name].kind != "auto"} if state.current else {}
    fields.update({name: field.value for name, field in (("pickup_at", state.pickup_at), ("payment", state.payment))
                   if field.valid})
    question = (action or summary.get("sender_change_next") or
                ("origin" if summary.get("origin_confirm") else None) or
                ("destination" if summary.get("destination_choices") else None) or
                ("box" if state.current and state.current.box_proposal else None) or
                next(iter(summary["missing"]), summary["stage"]))
    return TurnState(fields, question, len(state.parcels), state.candidates.kind if state.candidates else None)


class TurnPipeline:
    def __init__(self, client, backend: BackendTurn, policy: Policy, decision_budget_sec: float,
                 cfg: CallConfig | None = None):
        self.client, self.backend, self.policy = client, backend, policy
        self.decision_budget_sec = decision_budget_sec
        self.cfg = cfg or CallConfig()

    async def run(self, turn: TurnInput) -> TurnResult:
        record: dict = {}
        result = await self._run(turn, record)
        return replace(result, decision=record or None)

    def _passes(self, name: str, answer: tuple, kind: str | None) -> bool:
        """판정 적용 하한(선택지 확률 기준, decision-input-plan.md §3.3). confidence는 기록만 한다."""
        choice, score, probabilities = answer
        p = probabilities.get(choice, score)
        if name == "pick":  # 이름이 같은 후보가 여럿일 수 있어 열린 질문의 답이어도 하한을 낮추지 않는다
            return p >= ACTION_CONFIDENCE
        if name in decision_input.ANSWERED_BY.get(kind, ()) and not (name == "task" and choice in ("end", "agent")):
            second = max((v for k, v in probabilities.items() if k != choice), default=0.0)
            return p >= self.cfg.decision_open_min_p and p - second >= self.cfg.decision_open_margin
        if name in ("switch", "task") and choice in EXITS and not (name == "task" and choice == "cancel"):
            return p >= self.cfg.decision_exit_min_p
        if name == "switch":
            return p >= self.cfg.decision_switch_min_p
        return p >= ACTION_CONFIDENCE

    async def _run(self, turn: TurnInput, record: dict) -> TurnResult:
        state, customer = turn.state, turn.customer
        text = customer.text.strip()
        short = re.sub(r"[\s,.!?…~]+", "", text)
        yes, no = bool(SHORT_YES.fullmatch(short)), bool(SHORT_NO.fullmatch(short))
        if turn.greeting in ("registered_origin", "origin_mentioned"):
            state.origin_mentioned_in_greeting = True
        review = hold_unclassified_items(state, self.policy.parcel_items, customer.utterance_id, text)
        if review:
            return self._result(state, "closed", "item_review", facts={"item_review": review})
        if turn.end_question and (yes or no):
            return self._result(state, "closed", "end" if yes else None)
        if turn.end_waiting and (yes or no):
            return self._result(state, "closed", "confirm_end")
        if turn.greeting and yes:
            state.intent = "order"
            self._origin_step(state, True if turn.greeting == "registered_origin" else None)
            return self._result(state, "closed")
        # '발송 주소도 바꿀지'는 예 = 등록 주소를 쓰지 않는다
        address_change = sender_change_next(state) == "ask_address_change"
        if turn.origin_question and (yes or no):
            self._origin_step(state, yes != address_change)
            return self._result(state, "closed")
        if turn.destination and yes:
            apply_pick(state, turn.destination)
            return self._result(state, "closed")
        if turn.spoken_question == "more_parcels" and state.parcels and no:
            state.no_more_parcels = True
            return self._result(state, "closed")
        if turn.spoken_question == "callback" and state.callback_offered and (yes or no):
            state.callback_offered, state.callback_requested = False, yes
            return self._result(state, "closed", "callback",
                                facts={"agent": "callback_registered" if yes else "callback_declined"})
        if turn.spoken_question == "box" and state.current and state.current.box_proposal and (yes or no):
            return await self._answer_box(turn, yes)

        answers, decision_status, kind = await self._decide(turn, record)
        confidence = {name: answer[0] for name, answer in answers.items() if self._passes(name, answer, kind)}
        switch = confidence.get("switch") or confidence.get("task")
        pending = state.pending
        confirmation = answers.get("confirm")
        value = answers.get("value")
        has_value = bool(value and value[0] == "yes" and value[1] >= 0.5)
        mixed = not (yes or no) or has_value
        open_yes = any(confidence.get(name) in ("yes", "proceed", "more")
                       for name in decision_input.ANSWERED_BY.get(kind, ()))
        end = answers.get("switch") or answers.get("task")
        end_p = end[2].get("end", end[1]) if end and end[0] == "end" and kind != "end" else 0.0
        # 종료는 확실하고 열린 질문의 동의와 겹치지 않을 때만 바로 한다. 그 밖에는 한 번 확인한다.
        if switch == "end" and (open_yes or pending and pending.kind == "parcel" and confirmation and (
                confirmation[0] in ("yes", "proceed") and confirmation[1] >= self.policy.confirm.yes_min)):
            return self._result(state, "closed", "confirm_end")
        if switch in ("end", "agent"):
            return self._result(state, "closed", switch)
        if switch is None and end_p >= self.cfg.decision_switch_min_p:
            return self._result(state, "closed", "confirm_end")
        if kind == "callback" and not has_value and (callback := confidence.get("callback")) in ("yes", "no"):
            state.callback_offered, state.callback_requested = False, callback == "yes"
            return self._result(state, "closed", "callback", facts={
                "agent": "callback_registered" if callback == "yes" else "callback_declined"})
        if kind == "box" and not has_value and (box := confidence.get("box")) in ("yes", "no"):
            return await self._answer_box(turn, box == "yes")
        asked_more = turn.spoken_question == "more_parcels"
        if (asked_more or kind == "more") and state.parcels:
            more = confidence.get("more")
            if more == "no_more":
                state.no_more_parcels = True
                return self._result(state, "closed")
            if more == "more" or asked_more and yes:
                state.current = None
                state.origin_answer = None
                state.origin_applied = False
                self._origin_step(state, None)
                next_question = observe_turn(state, self.policy).next_question
                if next_question == "more_parcels":
                    next_question = "sender_name" if not state.customer.customer_seq else "sender_address"
                return self._result(state, "closed", next_question)
        if switch in ("cancel_current", "edit_parcel", "edit_other_parcel") or (
                turn.tools is None and switch in ("lookup", "cancel", "inquiry")):
            return self._result(state, "closed", switch, "external_action")
        if switch in ("lookup", "cancel") or switch == "inquiry" and state.intent is None:
            if state.intent != switch:
                state.pending, state.candidates, state.selected_order = None, None, None
            state.intent = switch
        if confidence.get("task") == "order" and state.intent is None:
            state.intent = "order"
            self._origin_step(state, None)
            if review := hold_unclassified_items(state, self.policy.parcel_items, customer.utterance_id, text):
                return self._result(state, "closed", "item_review", facts={"item_review": review})
        sender_change = confidence.get("sender_change")
        if sender_change in ("name", "both") and turn.receiver_name_answer:
            sender_change = None
        if sender_change_available(state) and sender_change in ("name", "both"):
            begin_sender_name_change(state)
        if sender_change_available(state) and sender_change in ("address", "both"):
            request_sender_address_change(state)
        selected = False
        pick_applied = False
        origin_answer = confidence.get("origin")
        if state.intent == "order" and (turn.origin_question or kind in ("origin", "address_change") or
                                        turn.greeting == "registered_origin" or
                                        turn.greeting == "origin_mentioned" and origin_answer == "no") and (
                origin_answer in ("yes", "no") and sender_change not in ("name", "address", "both")):
            self._origin_step(state, (origin_answer == "yes") != address_change)
            selected = True
        if turn.pick_allowed and (pick := confidence.get("pick")) and not receiver_questions_deferred(state):
            if pick == "none":
                reject_candidates(state)
                pick_applied = True
            elif pick != "not_answer":
                pick_applied = apply_pick(state, pick)
            selected |= pick_applied
        if pending and state.pending is pending and confirmation and not sender_change_next(state):
            answer, score, probabilities = confirmation
            if confidence.get("confirm") in ("no", "change"):
                release(state, pending.id)
                selected = True
            elif answer in ("yes", "proceed") and (not mixed or (
                    explicitly_requests_parcel(text) and not (value and value[0] == "yes" and value[1] >= 0.5)
            )) and check_gate(
                    state, self.policy, pending.id, ConfirmAnswer(answer, probabilities), customer, turn.previous,
                    latest_applied_utterance=None, closed=False).ok:
                if turn.tools is not None:
                    return TurnResult(observe_turn(state, self.policy), "closed", commit_pending=pending.id)
                if pending.kind == "cancel":
                    return self._result(state, "closed", "cancel", "external_action")
                selected = commit_parcel(state, self.policy, pending.id) is not None
        if not mixed and selected:
            if turn.tools is not None and pick_applied and state.selected_order:
                if state.intent == "cancel":
                    issue_cancel_confirmation(state, turn.tools.clock())
                elif state.intent == "lookup":
                    return self._result(state, "closed", facts={"lookup_order": lookup_order_facts(state.selected_order)})
            return self._result(state, "closed")

        scope = None if turn.receiver_name_answer else confidence.get("sender_name_scope")
        if scope in ("confirm_once", "confirm_save") and sender_change_next(state) == "ask_name_save":
            state.current.ask_customer_name_save = False
            state.current.save_sender_name = scope == "confirm_save"
            if not mixed:
                return self._result(state, "closed")
        if scope in ("once_pending", "save_pending") and state.current and sender_change_available(state):
            state.clear("sender_name")
            state.current.sender_name_scope_pending = scope.removesuffix("_pending")
            state.current.ask_customer_name_save = state.current.save_sender_name = False
        summary = state_summary(state, self.policy)
        if "origin_confirm" in summary:
            summary["origin_confirm"] = True
        if "destination_choices" in summary:
            summary["destination_choices"] = len(summary["destination_choices"])
        # Only decision names and safe choices are needed here. Candidate labels can contain addresses or names.
        findings = {name: value for name, value in confidence.items() if name != "pick"}
        findings["pick_applied"] = pick_applied
        if (yes or no) and any(answers[name][0] not in NOT_AN_ANSWER and name not in confidence
                               for name in decision_input.ANSWERED_BY.get(kind, ()) if name in answers):
            # 짧은 답이 열린 질문의 답으로 보이지만 확실하지 않다: 같은 질문을 되풀이하지 않고 선택지를 풀어 다시 묻는다.
            return self._result(state, "closed", facts={"clarify": kind})
        backend = await self.backend.run(self._tools(turn, scope), {
            "customer": (turn.said or text).strip(), "previous_question": turn.previous.text if turn.previous else None,
            "state": summary, "decision": findings, "now": turn.now.isoformat(), "requested_action": switch,
        }, before_lookup=turn.before_lookup)
        if turn.tools is not None and state.intent == "cancel" and state.selected_order:
            issue_cancel_confirmation(state, turn.tools.clock())
        return TurnResult(observe_turn(state, self.policy), "backend",
                          backend.status if backend.status != "ok" else decision_status,
                          backend.tool_calls, backend.address_unverified, backend.facts)

    async def _answer_box(self, turn: TurnInput, accept: bool) -> TurnResult:
        state, box = turn.state, turn.state.current.box_proposal
        if not accept:
            state.current.box_proposal = None
            state.bump()
            return self._result(state, "closed", facts={"box_proposal_declined": True})
        field = f"{box.size}_box_count"
        out = await record_fields(self._tools(turn), RecordArgs(add_item_counts=[field], **{field: box.count}),
                                  expected_box=box)
        return self._result(state, "closed", facts=out.facts | ({"needs": out.needs} if out.needs else {}))

    def _tools(self, turn: TurnInput, scope: str | None = None) -> ToolContext:
        tools = turn.tools or ToolContext("shadow", turn.state, self.policy, backend=None, now=lambda: turn.now)
        return replace(tools, item_utterance=(turn.customer.utterance_id, turn.customer.text),
                       sender_name_scope=scope if scope in ("once", "save") else None)

    def _origin_step(self, state: ConversationState, use_registered: bool | None) -> None:
        if use_registered is not None:
            state.origin_answer = use_registered
            if not use_registered:
                request_sender_address_change(state)
        if not state.customer.customer_seq:
            return
        if state.origin_answer is None and state.customer.origin_place:
            state.origin_offered = True
        else:
            prefill_sender(state, full=state.origin_answer is True)
            state.origin_applied = True
            resume_destination(state)

    def _result(self, state: ConversationState, route: str, action: str | None = None, status: str = "ok",
                *, facts: dict | None = None) -> TurnResult:
        return TurnResult(observe_turn(state, self.policy, action), route, status, facts=facts or {})

    async def _decide(self, turn: TurnInput, record: dict) -> tuple[dict, str, str | None]:
        """(답, 상태, 열린 질문 종류). 질문 목록은 열린 질문 + switch이고, 첫 인사와 발송 확인에만 보내는 분 변경을 더한다."""
        state, open_line = turn.state, self.cfg.decision_open_question
        text, kind = decision_input.render(
            state, self.policy, turn.recent_ai if turn.recent_ai is not None else (
                turn.previous.text if turn.previous else ""), turn.said or turn.customer.text,
            end_waiting=turn.end_waiting, open_line=open_line)
        flags = decision_input.question_flags(state, self.policy, kind) if open_line else {
            "pending": state.pending is not None,
            "origin": turn.origin_question or turn.greeting in ("registered_origin", "origin_mentioned"),
            "sender_change": sender_change_available(state),
            "sender_name_scope": bool(state.customer.customer_seq and state.intent in (None, "order"))}
        flags["sender_name_scope"] = flags["sender_name_scope"] and not turn.receiver_name_answer
        box = state.current.box_proposal if kind == "box" else None
        questions = decision_questions(
            self.policy, assess(state, self.policy).stage,
            pick_labels=state.candidates.labels if turn.pick_allowed else (),
            cancel_current=bool(turn.tools and turn.tools.draft_intake and state.current and not state.current.empty()),
            box_label=box.label if box else None, **flags)
        for question in questions:
            if question["name"] == "switch":
                question["choices"].append({"value": "other"})
                question["instructions"] += " 목록에 없는 다른 요청은 other다."
        questions.append({"type": "choice", "name": "value", "choices": [{"value": "yes"}, {"value": "no"}],
                          "instructions": "고객이 확인의 답 외에 새 접수 정보나 정정할 값을 함께 말했으면 yes다."})
        record.update(input=text, open_question=kind, questions=[q["name"] for q in questions])
        started = time.monotonic()
        try:
            async with asyncio.timeout(self.decision_budget_sec):
                response = await self.client.decisions.create(model="gpt-6-luna", input=text, questions=questions)
        except TimeoutError:
            record["status"] = "decision_timeout"
            return {}, "decision_timeout", kind
        except APIError:
            record["status"] = "decision_error"
            return {}, "decision_error", kind
        allowed = {q["name"]: {c["value"] for c in q["choices"]} for q in questions}
        answers = {answer.name: (answer.choice, float(answer.confidence or 0),
                                 {p.value: p.probability for p in (answer.probabilities or [])})
                   for answer in response.answers if answer.type == "choice" and
                   answer.choice in allowed.get(answer.name, ())}
        record.update(ms=round((time.monotonic() - started) * 1000), answers={
            name: {"choice": choice, "confidence": round(score, 3), "probabilities": probabilities}
            for name, (choice, score, probabilities) in answers.items()})
        return answers, "ok", kind
