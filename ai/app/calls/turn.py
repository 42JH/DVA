"""Plan one customer turn on a detached copy of the call's business state."""

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import datetime

from openai import APIError

from app.calls.backend_turn import BackendTurn
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
    def __init__(self, client, backend: BackendTurn, policy: Policy, decision_budget_sec: float):
        self.client, self.backend, self.policy = client, backend, policy
        self.decision_budget_sec = decision_budget_sec

    async def run(self, turn: TurnInput) -> TurnResult:
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
            return self._result(state, "closed", "end" if yes else "readback")
        if turn.end_waiting and (yes or no):
            return self._result(state, "closed", "confirm_end")
        if turn.greeting and yes:
            state.intent = "order"
            self._origin_step(state, True if turn.greeting == "registered_origin" else None)
            return self._result(state, "closed")
        if turn.origin_question and (yes or no):
            self._origin_step(state, yes)
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
            box = state.current.box_proposal
            if no:
                state.current.box_proposal = None
                state.bump()
                return self._result(state, "closed", facts={"box_proposal_declined": True})
            field = f"{box.size}_box_count"
            out = await record_fields(self._tools(turn), RecordArgs(add_item_counts=[field], **{field: box.count}),
                                      expected_box=box)
            return self._result(state, "closed", facts=out.facts | ({"needs": out.needs} if out.needs else {}))

        answers, decision_status = await self._decide(turn)
        confidence = {name: choice for name, (choice, score, _) in answers.items() if score >= ACTION_CONFIDENCE}
        switch = confidence.get("switch") or confidence.get("task")
        pending = state.pending
        confirmation = answers.get("confirm")
        value = answers.get("value")
        mixed = not (yes or no) or bool(value and value[0] == "yes" and value[1] >= 0.5)
        if switch == "end" and pending and pending.kind == "parcel" and confirmation and (
                confirmation[0] in ("yes", "proceed") and confirmation[1] >= self.policy.confirm.yes_min):
            return self._result(state, "closed", "confirm_end")
        if switch in ("end", "agent"):
            return self._result(state, "closed", switch)
        if turn.spoken_question == "more_parcels" and state.parcels:
            more = confidence.get("more")
            if more == "no_more":
                state.no_more_parcels = True
                return self._result(state, "closed")
            if more == "more" or yes:
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
        if state.intent == "order" and (turn.origin_question or turn.greeting == "registered_origin" or
                                        turn.greeting == "origin_mentioned" and origin_answer == "no") and (
                origin_answer in ("yes", "no") and sender_change not in ("name", "address", "both")):
            self._origin_step(state, origin_answer == "yes")
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
            if answer in ("no", "change") and score >= ACTION_CONFIDENCE:
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
        backend = await self.backend.run(self._tools(turn, scope), {
            "customer": text, "previous_question": turn.previous.text if turn.previous else None,
            "state": summary, "decision": findings, "now": turn.now.isoformat(), "requested_action": switch,
        }, before_lookup=turn.before_lookup)
        if turn.tools is not None and state.intent == "cancel" and state.selected_order:
            issue_cancel_confirmation(state, turn.tools.clock())
        return TurnResult(observe_turn(state, self.policy), "backend",
                          backend.status if backend.status != "ok" else decision_status,
                          backend.tool_calls, backend.address_unverified, backend.facts)

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

    async def _decide(self, turn: TurnInput) -> tuple[dict, str]:
        state = turn.state
        questions = decision_questions(
            self.policy, assess(state, self.policy).stage,
            pending=state.pending is not None,
            pick_labels=state.candidates.labels if turn.pick_allowed else (),
            origin=turn.origin_question or turn.greeting in ("registered_origin", "origin_mentioned"),
            sender_change=sender_change_available(state),
            sender_name_scope=bool(state.customer.customer_seq and state.intent in (None, "order")
                                   and not turn.receiver_name_answer),
            cancel_current=bool(turn.tools and turn.tools.draft_intake and state.current and not state.current.empty()),
        )
        for question in questions:
            if question["name"] == "switch":
                question["choices"].append({"value": "other"})
                question["instructions"] += " 목록에 없는 다른 요청은 other다."
        questions.append({"type": "choice", "name": "value", "choices": [{"value": "yes"}, {"value": "no"}],
                          "instructions": "고객이 확인의 답 외에 새 접수 정보나 정정할 값을 함께 말했으면 yes다."})
        text = f"직전 AI 발화: {turn.previous.text if turn.previous else '(없음)'}\n고객 발화: {turn.customer.text}"
        try:
            async with asyncio.timeout(self.decision_budget_sec):
                response = await self.client.decisions.create(model="gpt-6-luna", input=text, questions=questions)
        except TimeoutError:
            return {}, "decision_timeout"
        except APIError:
            return {}, "decision_error"
        allowed = {q["name"]: {c["value"] for c in q["choices"]} for q in questions}
        return {answer.name: (answer.choice, float(answer.confidence or 0),
                              {p.value: p.probability for p in (answer.probabilities or [])})
                for answer in response.answers if answer.type == "choice" and
                answer.choice in allowed.get(answer.name, ())}, "ok"
