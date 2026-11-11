"""record_fields: 고객이 말한 택배 값·수거 일시 기록(정정 포함). 원본 record_order를 새 상태 모델로.

흐름(concurrency.md §3.1): ① 잠금 안: 주소 필드 버전 읽기 → ② 잠금 밖: 주소DB 보정·카카오(병렬) → ③ 잠금 안: 검증 값
반영, 주소는 ①의 버전 그대로일 때만(늦은 결과는 RESULT_SUPERSEDED) → 되읽기 가능하면 확인 대기를 열고 확인 내용(N1).
규칙: 전화번호 자릿수(PHONE_INVALID_DIGITS), 수거 시각 P1(PICKUP_*), 주소 not_found는 기록 안 함(ADDRESS_NOT_FOUND),
ambiguous는 1순위 자동 확정 + 나머지 후보 보관(P6, ADDRESS_AUTO_SELECTED), 보정 장애는 들은 값 + geo 없음
(ADDRESS_GEO_MISSING), 주소가 바뀌었는데 상세주소를 같이 말하지 않았으면 이전 상세주소를 비운다(facts.cleared).
정정 값이 틀리면 기존 값을 유지한다(state.record_invalid).
"""

import asyncio
import re
import time
from dataclasses import replace
from functools import lru_cache
from typing import Literal
from pydantic import Field, create_model, model_validator

from app.address.parse import detail_text, has_numbered_address
from app.domain.address_book import (begin_sender_name_change, origin_confirmation, prefill_sender,
                                     request_sender_address_change, save_offer, sender_change_available,
                                     sender_change_next)
from app.domain.assess import area_label, readback_facts
from app.domain.candidates import DESTINATION_CHANGE_FIELDS, buffer_destination_fields, destination_changes
from app.domain.confirm import issue_parcel_confirmation
from app.domain.parcel_items import (ItemIssue, contextual_keyword, excluded_evidence, measurements, mentions,
                                     size_issues, supported_box_correction, unclassified_mentions)
from app.domain.pickup import check_pickup, default_pickup, describe, rule_of
from app.domain.rules import normalize_phone, parse_pickup
from app.domain.state import BoxProposal, ConversationState, Items, ParcelDraft, Source
from app.domain.store import hold_items, open_for_edit
from app.observability.trace import observe_latency
from app.policy.model import InputLimits, Policy
from app.tools.context import ToolContext
from app.tools.executor import Args, model_tool
from app.tools.lookup import book_matches, offer_destination, resume_destination
from app.tools.outcome import ToolOutcome, state_summary

TEXT = ("sender_name", "sender_address_detail", "receiver_name", "receiver_address_detail")
ADDRESSES = ("sender_address", "receiver_address")
COUNTS = ("document_count", "small_box_count", "medium_box_count", "big_box_count")
BOX_COUNTS = COUNTS[1:]
CountField = Literal["document_count", "small_box_count", "medium_box_count", "big_box_count"]


class ItemEvidence(Args):
    rule: str = Field(min_length=1, max_length=40, description="접수 물품 정책의 규칙 ID")
    quote: str = Field(min_length=1, max_length=200, description="이번 고객 발화에서 근거를 그대로 인용")
    status: Literal["included", "removed", "inquiry", "condition_met", "condition_unmet", "not_applicable"]
    side_cm: float | None = Field(None, gt=0, description="한 변의 길이(cm), 세 변의 합은 제외")
    weight_kg: float | None = Field(None, gt=0)


class BoxSuggestion(Args):
    size: Literal["small", "medium", "big"]
    count: int = Field(ge=1)
    quote: str = Field(min_length=1, max_length=200, description="후보의 근거가 된 이번 고객 발화 그대로")


class RecordArgs(Args):
    sender_name: str | None = Field(None, max_length=30)
    sender_address: str | None = Field(None, max_length=120, description="발송 기본주소(도로명·지번). '○○에서 보낼게요'의 ○○")
    sender_address_detail: str | None = Field(None, max_length=60, description="발송지 상세주소. 없다고 하면 빈 문자열")
    receiver_name: str | None = Field(None, max_length=30)
    receiver_phone: str | None = Field(None, max_length=40, description="들은 그대로(한글 숫자 가능)")
    receiver_address: str | None = Field(None, max_length=120, description="받는 곳 기본주소(도로명·지번). '○○로 보낼게요'의 ○○")
    receiver_address_detail: str | None = Field(None, max_length=60, description="받는 곳 상세주소. 없다고 하면 빈 문자열")
    document_count: int | None = Field(None, ge=0, description="서류 봉투 수. 생략하면 기존 값을 유지하고 0은 제외한다")
    small_box_count: int | None = Field(None, ge=0, description="소형 박스 수")
    medium_box_count: int | None = Field(None, ge=0, description="중형 박스 수")
    big_box_count: int | None = Field(None, ge=0, description="대형 박스 수")
    add_item_counts: list[CountField] | None = Field(None, max_length=4, description="수량을 더할 항목 이름만 넣는다. 각 항목의 숫자 필드에 추가할 개수를 넣는다")
    box_suggestion: BoxSuggestion | None = Field(None, description="박스 규격을 직접 말하지 않았을 때 추가할 박스 후보")
    box_size_needed: str | None = Field(None, min_length=1, max_length=200, description="박스 규격·개수를 더 확인해야 하는 물품의 고객 발화 원문")
    omit_unconfirmed_box: str | None = Field(None, min_length=1, max_length=200, description="확인 중인 추가 박스만 제외해 달라는 고객 발화 원문")
    item_evidence: list[ItemEvidence] | None = Field(None, max_length=12, description="고객이 언급한 제한 품목·포장·규격 초과의 근거")
    omit_blocked_parcel: str | None = Field(None, max_length=200, description="문제 택배 전체를 빼 달라는 고객 발화 원문")
    item_price: int | None = Field(None, description="서류·배송비를 제외한 물품의 대략적인 가액 합계(원). "
                                                    "고객이 말한 기준 금액을 정수로 넣는다. 예: 10만 원 안 될 것 같아요 → 100000")
    client_comment: str | None = Field(None, max_length=100, description="배송 요청 사항(고객이 말했을 때만)")
    pickup_at: str | None = Field(None, max_length=40, description="고객이 수거 시각을 바꿀 때만. 한국 시간 ISO 8601"
                                  "(예: 2026-11-05T10:00:00+09:00). 오늘·내일은 지시문의 현재 시각 기준")

    @model_validator(mode="after")
    def check_additions(self):
        if any(not getattr(self, name) for name in self.add_item_counts or ()):
            raise ValueError("추가할 물품 항목에는 1개 이상의 추가 수량이 필요합니다")
        return self


@lru_cache(maxsize=16)
def _record_args(limits: InputLimits) -> type[RecordArgs]:
    """같은 정책으로 모델 스키마와 실행기 검증 모델을 만든다. 합계는 서버에서 추가 검사한다."""
    fields = {
        name: (int | None, Field(None, ge=0, le=limits.document_max if name == "document_count"
                                else limits.box_total_max,
                                description=RecordArgs.model_fields[name].description +
                                (f". 박스와 별도로 최대 {limits.document_max}개" if name == "document_count" else
                                 f". 소형·중형·대형 합계는 접수 묶음마다 최대 {limits.box_total_max}개")))
        for name in COUNTS
    }
    fields["item_price"] = (int | None, Field(None, ge=limits.item_price_min, le=limits.item_price_max,
                                             description=RecordArgs.model_fields["item_price"].description))

    @model_validator(mode="after")
    def check_box_total(self):
        if sum(getattr(self, name) or 0 for name in COUNTS[1:]) > limits.box_total_max:
            raise ValueError(f"박스 합계는 접수 묶음마다 {limits.box_total_max}개 이하여야 합니다")
        return self

    return create_model("PolicyRecordArgs", __base__=RecordArgs,
                        __validators__={"check_box_total": check_box_total}, **fields)


def record_args(policy: Policy) -> type[RecordArgs]:
    return _record_args(policy.input_limits)


# 이름 끝에 붙어 받아써진 말끝(2026-11-03 통화 512a1b: "현승준이니다"). "이"로 시작하는 말끝은 앞 글자에 받침이
# 있을 때만 뗀다("박소이요"는 "박소이" — 이름 끝 "이"를 지우지 않게). 남는 이름이 두 글자 이상일 때만
_TAIL_ANY = re.compile(r"\s*(?:라고\s*합니다|입니다|예요|에요|요)[.!?\s]*$")
_TAIL_I = re.compile(r"(?<=[가-힣])\s*(?:이라고\s*합니다|이니다|이에요|이요)[.!?\s]*$")


def _has_final(ch: str) -> bool:
    return "가" <= ch <= "힣" and (ord(ch) - 0xAC00) % 28 != 0


def clean_name(raw: str) -> str:
    name = raw.strip()
    m = _TAIL_I.search(name)
    if m and _has_final(name[:m.start()].rstrip()[-1:] or " "):
        cut = name[:m.start()].rstrip()
    else:
        cut = _TAIL_ANY.sub("", name)
    return cut if len(cut) >= 2 else name


@model_tool("record_fields",
            "고객이 말한 택배 값(보내는 분·받는 분·주소·물품·물품 가액·요청 사항)을 기록한다(정정도 같은 도구). "
            "이번에 들은 항목만 채우고 나머지는 null. 전화번호는 들은 그대로 넘기면 서버가 숫자로 바꾸고 자릿수를 검사한다.",
            RecordArgs, args_factory=record_args)
async def record_fields(ctx: ToolContext, args: RecordArgs, *, expected_box: BoxProposal | None = None,
                        expected_draft: ParcelDraft | None = None) -> ToolOutcome:
    given = args.model_dump(exclude_none=True)
    if not given:
        return ToolOutcome("needs_input", "NOTHING_TO_RECORD")
    s, policy = ctx.state, ctx.policy
    if s.order_submitted:  # 접수 후 수정·추가 없음 — 받아 적으면 반영 안 된 값을 확정한 것처럼 안내하게 된다
        return ToolOutcome("rejected", "ORDER_SUBMITTED", {"order": "submitted"})
    async with ctx.lock:
        if expected_draft is not None and (s.current is not expected_draft or s.intent != "order"):
            return ToolOutcome("needs_input", "RESULT_SUPERSEDED", summary=state_summary(s, policy))
        if buffer_destination_fields(s, given) and not given:
            return ToolOutcome("ok", summary=state_summary(s, policy))
    values, needs = {}, []
    for name in TEXT:
        if name in given:
            values[name] = (clean_name(given[name]) if name.endswith("_name")
                            else detail_text(given[name]) if name.endswith("_detail")  # 상세주소 수사 → 숫자(서버가 한다)
                            else given[name].strip())
    if "receiver_phone" in given:
        phone = normalize_phone(given["receiver_phone"], policy.phone)
        if phone:
            values["receiver_phone"] = phone
        else:
            needs.append({"field": "receiver_phone", "reason": "PHONE_INVALID_DIGITS"})
    rule = rule_of(policy.pickup)
    if "pickup_at" in given:  # 고객 조정: 형식 → 업무 범위(1시간 이후·09~17시·3일 이내)
        now = ctx.now()
        iso, code = parse_pickup(given["pickup_at"], now, rule.min_lead_minutes)
        code = code or check_pickup(iso, now, rule)
        if code:
            needs.append({"field": "pickup_at", "reason": code})
        else:
            values["pickup_at"] = iso
    item_parts = {k: given[k] for k in COUNTS if k in given}

    async with ctx.lock:  # ① 주소 필드 버전과 지금 값
        deps = {a: s.field_of(a).version for a in ADDRESSES}
        current = {a: s.field_of(a).value for a in ADDRESSES}
        draft = s.current
    heard = {a: given[a].strip() for a in ADDRESSES if a in given and given[a].strip() != current[a]}
    results = dict(zip(heard, await asyncio.gather(*(_resolve(ctx, h) for h in heard.values()))))  # ②

    async with ctx.lock:  # ③
        if s.order_submitted:
            return ToolOutcome("rejected", "ORDER_SUBMITTED", {"order": "submitted"})
        facts: dict = {"recorded": [], "changed": [], "cleared": []}
        if draft is not s.current or expected_draft is not None and s.intent != "order":
            return ToolOutcome("needs_input", "RESULT_SUPERSEDED", summary=state_summary(s, policy))
        if expected_box is not None and (draft.box_proposal is not expected_box or s.intent != "order" or s.pending):
            return ToolOutcome("needs_input", "RESULT_SUPERSEDED", summary=state_summary(s, policy))
        sender_address_pending = sender_change_next(s) in ("sender_address", "sender_address_detail")
        old_items = draft["items"].value if draft["items"].valid else None
        was_box_pending = draft.box_size_pending
        _check_items(ctx, args, item_parts, facts, needs)
        failed_items = {"RESULT_SUPERSEDED", "ITEM_BOX_LIMIT", "ITEM_DOCUMENT_LIMIT"}
        if s.current is draft and not any(need["reason"] in failed_items for need in needs):
            price = _price_for_items(s, draft, old_items, was_box_pending, args.item_price, facts)
            if price is not None:
                values["item_price"] = price
        keep_origin = False
        spoken_origin = given.get("sender_address", "").strip()
        if (spoken_origin and s.current is draft and draft["sender_address"].version == deps["sender_address"]
                and (sender_change_next(s) == "ask_address_change" or origin_confirmation(s))):
            # 주소 선택 질문에 주소로 직접 답해도 처리한다. 이전 상세는 새 상세를 기록하기 전에 비운다.
            resolved = results.get("sender_address")
            chosen = resolved.address if resolved is not None else spoken_origin
            place = s.customer.origin_place
            known = draft["sender_address"].value or (place.address if place else None)
            keep_origin = bool(chosen and chosen == known
                               and (resolved is None or resolved.status not in ("not_found", "region_needed")))
            if not keep_origin:
                request_sender_address_change(s)
                deps["sender_address"] = draft["sender_address"].version
                sender_address_pending = True
        for name, value in values.items():
            prev = s.field_of(name)
            was = prev.value if prev.valid else None
            if name == "sender_name" and value and value != s.customer.name and sender_change_available(s):
                begin_sender_name_change(s)
            if s.record(name, value):
                if name == "sender_name" and s.customer.customer_seq and was != value:
                    scope = ctx.sender_name_scope or s.current.sender_name_scope_pending
                    s.current.sender_name_scope_pending = None
                    if value == s.customer.name:
                        s.current.ask_customer_name_save = False
                        s.current.save_sender_name = False
                    elif scope or was is not None or not s.current.sender_name_for_parcel:
                        s.current.ask_customer_name_save = scope is None
                        s.current.save_sender_name = scope == "save"
                facts["recorded"].append(name)
                if was not in (None, ""):
                    facts["changed"].append(name)
        if "client_comment" in given:
            s.field_of("sender_name")  # current 보장
            s.current.client_comment = given["client_comment"].strip() or None
            facts["recorded"].append("client_comment")
        require_destination_address = (expected_draft is not None or draft.destination_partial_change == "address"
                                       or bool(destination_changes(s.candidates)))
        for addr, r in results.items():
            if s.field_of(addr).version != deps[addr]:
                needs.append({"field": addr, "reason": "RESULT_SUPERSEDED"})  # 그사이 다른 값으로 바뀜
                continue
            _apply_address(ctx, addr, r, given, facts, needs,
                           require_address_value=addr == "receiver_address" and require_destination_address)
        if keep_origin:
            s.origin_answer = s.origin_applied = True
            facts["recorded"].extend(prefill_sender(s, full=True))
        for name in invalid_fields(needs):
            s.record_invalid(name, next(n["reason"] for n in needs if n["field"] == name))
        changed = bool(facts["recorded"] or facts["cleared"] or facts.get("blocked_parcel_omitted") or facts.get("box_proposal")
                       or facts.get("box_request_removed"))
        if changed:
            s.awaiting_fix = False
        nothing = not changed and not needs
        if nothing and (s.pending or s.awaiting_fix):
            return ToolOutcome("ok", "NOTHING_CHANGED", summary=state_summary(s, policy))
        next_sender = sender_change_next(s)
        address_pending = next_sender in ("sender_address", "sender_address_detail")
        partial_change = s.current.destination_partial_change if s.current else None
        if partial_change and all(s.current[name].valid for name in DESTINATION_CHANGE_FIELDS[partial_change]):
            s.current.destination_partial_change = None
        address_completed = (sender_address_pending and s.current is draft and
                             all(draft[name].valid for name in ("sender_address", "sender_address_detail")))
        receiver_keys = {"receiver_name", "receiver_address"}
        if s.current and receiver_keys.intersection(facts["recorded"]):
            s.current.deferred_destination = None
            s.current.destination_search_id += 1
            if s.candidates and s.candidates.kind == "destination":
                s.candidates = None
        if not needs and (resumed := resume_destination(s)):
            resumed.facts |= {k: v for k, v in facts.items() if v}
            resumed.summary = state_summary(s, policy)
            return resumed
        # 받는 분 성함·주소는 자동으로 주소록과 대조한다. 발송 주소가 덜 채워졌으면 후보는 보류한다.
        # 핀에서 고른 받는 곳이면 다시 찾지 않는다.
        if (not partial_change and not needs and not s.pending and s.customer.places
                and (receiver_keys.intersection(facts["recorded"])
                     or address_completed and not s.candidates)
                and s.field_of("receiver_address").source not in (Source.PIN, Source.HISTORY, Source.COMPANY)):
            rn, ra = s.field_of("receiver_name"), s.field_of("receiver_address")
            found = (book_matches(s.customer.places, rn.value if rn.valid else None, ra.value if ra.valid else None, None)
                     if rn.valid or ra.valid else [])
            if found:
                out = offer_destination(s, found, ctx.max_pin_options)
                if out.status == "needs_choice":
                    out.facts |= {k: v for k, v in facts.items() if v}
                    out.facts["guidance"] = ("주소록에 같은 받는 분이나 같은 주소가 있음. 그분(그곳)께 보내는지 확인한다. "
                                             "답을 받은 뒤에는 최신 서버 결과의 확인 질문이나 빠진 항목을 따른다.")
                    out.summary = state_summary(s, policy)
                    return out
        # 같은 값을 다시 말했는데 확인 대기가 풀려 있으면(no·change 뒤) 되읽기로 다시 연다(운영 통화 56c133c8)
        pending = issue_parcel_confirmation(s, policy, ctx.clock()) if not needs and not s.candidates else None
        moved = False
        if pending and not s.pickup_at.valid:  # 되읽기 때 기본 수거 시각을 정해 함께 안내
            iso, moved = default_pickup(ctx.now(), rule)
            s.record("pickup_at", iso, Source.SERVER)
        if pending:  # 되읽기 gate 개방: 확인 내용을 이 결과로 준다(N1)
            if not next_sender:
                facts["readback"] = readback_facts(pending.snapshot)
                facts["readback_id"] = pending.id
            # 고객 정보·주소 저장은 묻지 않고 택배를 담을 때 한다(사용자 결정 2026-11-06). 여기서는 대상만 정해 둔다
            s.address_offer = save_offer(s) or None
        elif (not address_pending and (address_completed or any(a in facts["recorded"] for a in ADDRESSES))
              and all(s.field_of(a).valid for a in ADDRESSES)):
            # 두 주소가 갖춰진 순간 동 이름으로 한 번 확인(S15P31D109-164). 되읽기가 열리면 거기에 같은 값이 있다
            facts["confirm_route"] = {"from": area_label(s.current["sender_address"].value, s.current.sender_geo),
                                      "to": area_label(s.current["receiver_address"].value, s.current.receiver_geo)}
        if pending or "pickup_at" in values or any(n["field"] == "pickup_at" for n in needs):
            facts["pickup"] = {"at": s.pickup_at.value, "today_unavailable": moved, "allowed": describe(rule)}
        phones = [n for n in facts["recorded"] if n.endswith("_phone")]
        if phones:
            facts["phones_to_read"] = phones  # 고객이 새로 불러 준 번호: 한 번 끊어 읽어 확인(README §5)
        facts = {k: v for k, v in facts.items() if v}
        status = "needs_input" if needs else "ok"
        code = needs[0]["reason"] if needs else "NOTHING_CHANGED" if nothing else None
        return ToolOutcome(status, code, facts, needs, state_summary(s, policy))


def _price_for_items(state: ConversationState, draft: ParcelDraft, old_items: Items | None, was_box_pending: bool,
                     heard: int | None, facts: dict) -> int | None:
    documents_only = draft.documents_only()
    items = draft["items"].value if draft["items"].valid else Items()
    changed_goods = old_items is not None and (_box_total(old_items), old_items.other_item) != (
        _box_total(items), items.other_item)
    # 추가 박스를 묻기 시작할 때 기존 합계를 지운다. 후보를 확인하기 전에 새로 들은 합계는 유지한다.
    invalidate = documents_only or not was_box_pending and (draft.box_size_pending or changed_goods)
    if invalidate and (documents_only or heard is None) and draft["item_price"].valid:
        state.clear("item_price")
        facts["cleared"].append("item_price")
    return None if documents_only else heard


def _check_items(ctx: ToolContext, args: RecordArgs, counts: dict, facts: dict, needs: list[dict]) -> None:
    s, policy = ctx.state, ctx.policy.parcel_items
    utterance_id, text = ctx.item_utterance or (0, "")
    evidence = [e for e in args.item_evidence or () if e.quote.strip()
                and (ctx.item_utterance is None or e.quote.strip() in text)]
    issues = {key: replace(issue, utterance_id=utterance_id)
              for key, issue in unclassified_mentions(policy, text).items()}
    if not (counts or evidence or issues or args.omit_blocked_parcel or args.box_suggestion
            or args.box_size_needed or args.omit_unconfirmed_box):
        return
    if utterance_id and utterance_id < s.latest_item_utterance_id:
        needs.append({"field": "items", "reason": "RESULT_SUPERSEDED"})
        return
    s.latest_item_utterance_id = max(s.latest_item_utterance_id, utterance_id)
    # 이미 담은 택배의 내용물이 드러나면 그 택배를 다시 연다. 여러 건이면 대상 선택을 기다린다.
    confirmed, resolved, dismissed = {}, {}, {}
    for e in evidence:
        if e.status == "inquiry":
            continue
        if e.status == "not_applicable":
            rule = policy.rules.get(e.rule)
            if text and rule and contextual_keyword(rule, e.quote):
                dismissed.setdefault(e.rule, []).append(e.quote.strip())
            continue
        if e.rule == "size":
            sizes = measurements(e.quote) | {key: value for key, value in
                                            (("side_cm", e.side_cm), ("weight_kg", e.weight_kg)) if value is not None}
            exceeded = size_issues(policy, sizes)
            confirmed.update(exceeded)
            for key in sizes.keys() - exceeded.keys():
                resolved.setdefault(key, []).append(e.quote.strip())
        elif rule := policy.rules.get(e.rule):
            if excluded_evidence(rule, e.quote, text):
                continue
            if rule.kind == "format":
                unsupported = e.rule in mentions(policy, e.quote)
                if e.status == "condition_met":
                    if not unsupported and supported_box_correction(e.quote):
                        resolved.setdefault(e.rule, []).append(e.quote.strip())
                    continue
                if not unsupported:
                    continue
            if e.status == "removed" or rule.kind == "conditional" and e.status == "condition_met":
                resolved.setdefault(e.rule, []).append(e.quote.strip())
            else:
                code = {"prohibited": "PROHIBITED_ITEM", "format": "UNSUPPORTED_FORMAT",
                        "conditional": "CONDITION_UNMET" if e.status == "condition_unmet" else "NEEDS_CONDITION"}[rule.kind]
                confirmed[e.rule] = ItemIssue(code, rule.guidance)
    for key in resolved.keys() | dismissed.keys():
        remaining = text
        for quote in (*resolved.get(key, ()), *dismissed.get(key, ())):
            remaining = remaining.replace(quote, "")
        if key not in unclassified_mentions(policy, remaining):
            issues.pop(key, None)
    issues.update(confirmed)
    if issues and s.current.empty() and s.parcels and not s.editing:
        if len(s.parcels) > 1:
            for key, issue in issues.items():
                if issue.code != "ITEM_MENTION_UNCLEAR" or key not in s.unassigned_item_issues:
                    s.unassigned_item_issues[key] = issue
            needs.append({"field": "items", "reason": "ITEM_PARCEL_UNCLEAR"})
            return
        open_for_edit(s, s.parcels[0].parcel_id)
    draft = s.current
    omit = args.omit_blocked_parcel
    if (omit and draft.item_issues and (ctx.item_utterance is None or omit in text)
            and re.search(r"(?:택배|묶음|건).*?(?:빼|제외|취소|안\s*보내|보내지\s*않)", omit)):
        if draft.client_parcel_id:
            s.discarded_parcel_ids.add(draft.client_parcel_id)
        s.parcels[:] = [p for p in s.parcels if p.parcel_id != s.editing]
        s.current = s.editing = s.pending = None
        s.address_offer = None
        s.bump()
        facts["blocked_parcel_omitted"] = True
        return
    for key in resolved.keys() - issues.keys():
        draft.item_issues.pop(key, None)
    for key in dismissed.keys() - issues.keys():
        for pending_issues in (draft.item_issues, s.unassigned_item_issues):
            prior = pending_issues.get(key)
            if prior and prior.code == "ITEM_MENTION_UNCLEAR" and prior.utterance_id == utterance_id:
                pending_issues.pop(key)
    if s.unassigned_item_issues and draft.empty():
        needs.append({"field": "items", "reason": "ITEM_PARCEL_UNCLEAR"})
        return
    if any(counts.values()) and "format" not in issues:
        draft.item_issues.pop("format", None)
    if issues:
        hold_items(s, issues)
    box_counts = any(counts.get(name, 0) for name in BOX_COUNTS)
    if counts and not any(key in draft.item_issues for key in ("format", "side_cm", "weight_kg")):
        _record_item_counts(ctx, args, counts, facts, utterance_id)
    omit_box = (not box_counts and (draft.box_size_pending or "box_count" in draft.item_issues)
                and _quoted(ctx, args.omit_unconfirmed_box))
    if omit_box:
        draft.item_issues.pop("box_count", None)
        _set_box_request(s, pending=False)
        facts["box_request_removed"] = True
    if draft.item_issues:
        needs.extend({"field": "items", "reason": issue.code, "detail": issue.guidance}
                     for issue in draft.item_issues.values())
        return
    if args.box_suggestion and not box_counts and not omit_box:
        suggestion = args.box_suggestion
        current = draft["items"].value or Items()
        if not s.unassigned_item_issues and _quoted(ctx, suggestion.quote):
            if _box_total(current) + suggestion.count > ctx.policy.input_limits.box_total_max:
                _set_box_request(s, pending=True)
                needs.append({"field": "items", "reason": "ITEM_BOX_LIMIT"})
                return
            proposal = BoxProposal(suggestion.size, suggestion.count, ctx.clock())
            _set_box_request(s, pending=True, proposal=proposal)
            facts["box_proposal"] = {"label": proposal.label}
        else:
            needs.append({"field": "items", "reason": "ITEM_UNSPECIFIED"})
    elif not box_counts and not omit_box and _quoted(ctx, args.box_size_needed):
        _set_box_request(s, pending=True)
    if draft.box_size_pending and draft.box_proposal is None:
        needs.append({"field": "items", "reason": "ITEM_BOX_SIZE_NEEDED"})
    elif not draft.box_size_pending and not draft["items"].valid:
        needs.append({"field": "items", "reason": "ITEM_UNSPECIFIED"})
    elif resolved or dismissed:
        if "items" not in facts["recorded"]:
            facts["recorded"].append("items")


def _quoted(ctx: ToolContext, quote: str | None) -> bool:
    return bool(quote and quote.strip() and (ctx.item_utterance is None or quote.strip() in ctx.item_utterance[1]))


def _set_box_request(state: ConversationState, *, pending: bool, proposal: BoxProposal | None = None) -> None:
    draft = state.current
    if draft.box_size_pending != pending or draft.box_proposal is not proposal:
        draft.box_size_pending, draft.box_proposal = pending, proposal
        if state.pending and state.pending.kind == "parcel":
            state.pending = None
            state.address_offer = None
        state.bump()


def _box_total(items: Items) -> int:
    return sum(getattr(items, name) for name in BOX_COUNTS)


def _record_item_counts(ctx: ToolContext, args: RecordArgs, counts: dict, facts: dict, utterance_id: int) -> None:
    state, limits = ctx.state, ctx.policy.input_limits
    draft = state.current
    current = draft["items"].value or Items()
    additions = set(args.add_item_counts or ())
    changes = {name: value + (getattr(current, name) if name in additions else 0)
               for name, value in counts.items()
               if not (name in additions and utterance_id and draft.item_addition_turns.get(name) == utterance_id)}
    items = replace(current, **changes)
    exceeded = {}
    if items.document_count > limits.document_max:
        exceeded["document_count"] = ItemIssue("ITEM_DOCUMENT_LIMIT", f"서류는 최대 {limits.document_max}개입니다.")
    if _box_total(items) > limits.box_total_max:
        exceeded["box_count"] = ItemIssue("ITEM_BOX_LIMIT", f"박스 합계는 최대 {limits.box_total_max}개입니다.")
    if exceeded:
        hold_items(state, exceeded)
        return
    if "document_count" in changes:
        draft.item_issues.pop("document_count", None)
    if any(name in changes for name in BOX_COUNTS):
        draft.item_issues.pop("box_count", None)
    if any(changes.get(name, 0) for name in BOX_COUNTS):
        _set_box_request(state, pending=False)
    if not changes:
        return
    if items.any():
        state.record("items", items)
        facts["recorded"].append("items")
    else:
        state.clear("items")
    if utterance_id:
        draft.item_addition_turns.update({name: utterance_id for name in additions & changes.keys()})


def invalid_fields(needs: list[dict]) -> list[str]:
    """값을 저장하지 않고 재질문할 항목(정정 실패면 기존 값 유지). 늦은 결과·경고는 제외."""
    keep = {"RESULT_SUPERSEDED", "ADDRESS_GEO_MISSING", "ADDRESS_AUTO_SELECTED", "ITEM_PARCEL_UNCLEAR"}
    return list(dict.fromkeys(n["field"] for n in needs if n["reason"] not in keep))


async def _resolve(ctx: ToolContext, heard: str):
    if ctx.address is None:
        return None
    t0 = time.monotonic()
    try:
        return await ctx.address.resolve(heard)
    finally:
        observe_latency("ADDRESS_LOOKUP", (time.monotonic() - t0) * 1000)


def _apply_address(ctx: ToolContext, addr: str, r, given: dict, facts: dict, needs: list, *,
                   require_address_value: bool = False) -> None:
    s = ctx.state
    role = addr.removesuffix("_address")
    detail = f"{role}_address_detail"
    # 들은 문장에서 서버가 뗀 상세주소("… 오십삼백십이동 사백삼호" → 312동 403호)는 기본주소를 못 찾아도 기록해 둔다 —
    # 기본주소와 독립된 값이라 다시 묻지 않는다(결정 1, 2026-11-09). 모델이 따로 넘긴 상세보다 우선한다.
    # 출처는 CUSTOMER: 고객이 말한 상세를 서버가 갈랐을 뿐이라 저장된 값(PIN·PROFILE)과 구분한다
    if r is not None and r.detail:
        if s.record(detail, r.detail, Source.CUSTOMER) and detail not in facts["recorded"]:
            facts["recorded"].append(detail)
    if r is not None and r.status in ("not_found", "region_needed"):
        need = {"field": addr, "reason": "ADDRESS_NOT_FOUND"}
        if r.status == "region_needed":  # 같은 주소가 여러 지역에 있음: Live가 지역을 묻고, 모델이 heard와 합쳐 다시 넘긴다
            need = {"field": addr, "reason": "ADDRESS_REGION_NEEDED", "regions": list(r.alternatives),
                    "heard": given[addr].strip()}
        needs.append(need)
        return
    value = r.address if r else given[addr].strip()
    if require_address_value and not (value and (has_numbered_address(value) or r and r.geo)):
        needs.append({"field": addr, "reason": "RECEIVER_ADDRESS_VALUE_REQUIRED"})
        return
    source = Source.RESOLVER if r and r.status in ("confirmed", "ambiguous") and value != given[addr].strip() \
        else Source.CUSTOMER
    before = s.field_of(addr)
    had, was = before.valid, before.value
    if s.record(addr, value, source):
        facts["recorded"].append(addr)
        if had:
            facts["changed"].append(addr)
            # 기본주소가 바뀌었는데 상세주소를 같이 말하지 않음 → 이전 상세주소는 맞지 않을 수 있어 비우고 다시 묻는다.
            # 같은 도로의 번호만 바뀌어도 비운다 — 저장된 상세는 되읽지 않아 다른 건물로 틀리게 접수된다(사용자 결정 2026-11-09)
            if detail not in given and not (r and r.detail) and was != value:
                s.clear(detail)
                facts["cleared"].append(detail)
    setattr(s.current, f"{role}_geo", r.geo if r else None)
    if r is not None and r.status == "ambiguous":
        s.field_of(addr).candidates = r.alternatives  # P6: 나머지 후보 보관
        facts.setdefault("auto_selected", []).append(addr)
    if r is None or r.geo is None:
        facts.setdefault("geo_missing", []).append(addr)  # 접수 필수값 부족(대화는 계속, 결과 INCOMPLETE)
