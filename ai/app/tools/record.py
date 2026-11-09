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
from functools import lru_cache
from typing import Literal
from pydantic import Field, create_model, model_validator

from app.domain.address_book import save_offer
from app.domain.assess import readback_facts
from app.domain.confirm import issue_parcel_confirmation
from app.domain.parcel_items import ItemIssue, measurements, size_issues, unclassified_mentions
from app.domain.pickup import check_pickup, default_pickup, describe, rule_of
from app.domain.rules import normalize_phone, parse_pickup
from app.domain.state import Items, Source
from app.domain.store import hold_items, open_for_edit
from app.observability.trace import observe_latency
from app.policy.model import InputLimits, Policy
from app.tools.context import ToolContext
from app.tools.executor import Args, model_tool
from app.tools.outcome import ToolOutcome, state_summary

TEXT = ("sender_name", "sender_address_detail", "receiver_name", "receiver_address_detail")
ADDRESSES = ("sender_address", "receiver_address")
COUNTS = ("document_count", "small_box_count", "medium_box_count", "big_box_count")


class ItemEvidence(Args):
    rule: str = Field(min_length=1, max_length=40, description="접수 물품 정책의 규칙 ID")
    quote: str = Field(min_length=1, max_length=200, description="이번 고객 발화에서 근거를 그대로 인용")
    status: Literal["included", "removed", "inquiry", "condition_met", "condition_unmet"]
    side_cm: float | None = Field(None, gt=0, description="한 변의 길이(cm), 세 변의 합은 제외")
    weight_kg: float | None = Field(None, gt=0)


class RecordArgs(Args):
    sender_name: str | None = Field(None, max_length=30)
    sender_address: str | None = Field(None, max_length=120, description="발송 기본주소(도로명·지번). '○○에서 보낼게요'의 ○○")
    sender_address_detail: str | None = Field(None, max_length=60, description="발송지 상세주소. 없다고 하면 빈 문자열")
    receiver_name: str | None = Field(None, max_length=30)
    receiver_phone: str | None = Field(None, max_length=40, description="들은 그대로(한글 숫자 가능)")
    receiver_address: str | None = Field(None, max_length=120, description="받는 곳 기본주소(도로명·지번). '○○로 보낼게요'의 ○○")
    receiver_address_detail: str | None = Field(None, max_length=60, description="받는 곳 상세주소. 없다고 하면 빈 문자열")
    document_count: int | None = Field(None, ge=0, description="서류 봉투 수. 물품은 지금 보낼 전체 구성을 넣는다")
    small_box_count: int | None = Field(None, ge=0, description="소형 박스 수")
    medium_box_count: int | None = Field(None, ge=0, description="중형 박스 수")
    big_box_count: int | None = Field(None, ge=0, description="대형 박스 수")
    item_evidence: list[ItemEvidence] | None = Field(None, max_length=12, description="고객이 언급한 제한 품목·포장·규격 초과의 근거")
    omit_blocked_parcel: str | None = Field(None, max_length=200, description="문제 택배 전체를 빼 달라는 고객 발화 원문")
    item_price: int | None = Field(None, description="물품 가액(원). 예: 만 원 → 10000")
    client_comment: str | None = Field(None, max_length=100, description="배송 요청 사항(고객이 말했을 때만)")
    pickup_at: str | None = Field(None, max_length=40, description="고객이 수거 시각을 바꿀 때만. 한국 시간 ISO 8601"
                                  "(예: 2026-11-05T10:00:00+09:00). 오늘·내일은 지시문의 현재 시각 기준")


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
async def record_fields(ctx: ToolContext, args: RecordArgs) -> ToolOutcome:
    given = args.model_dump(exclude_none=True)
    if not given:
        return ToolOutcome("needs_input", "NOTHING_TO_RECORD")
    s, policy = ctx.state, ctx.policy
    if s.order_submitted:  # 접수 후 수정·추가 없음 — 받아 적으면 반영 안 된 값을 확정한 것처럼 안내하게 된다
        return ToolOutcome("rejected", "ORDER_SUBMITTED", {"order": "submitted"})
    values, needs = {}, []
    for name in TEXT:
        if name in given:
            values[name] = clean_name(given[name]) if name.endswith("_name") else given[name].strip()
    if "receiver_phone" in given:
        phone = normalize_phone(given["receiver_phone"], policy.phone)
        if phone:
            values["receiver_phone"] = phone
        else:
            needs.append({"field": "receiver_phone", "reason": "PHONE_INVALID_DIGITS"})
    if "item_price" in given:
        values["item_price"] = given["item_price"]
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
        if draft is not s.current:
            return ToolOutcome("needs_input", "RESULT_SUPERSEDED", summary=state_summary(s, policy))
        _check_items(ctx, args, item_parts, facts, needs)
        for name, value in values.items():
            prev = s.field_of(name)
            was = prev.value if prev.valid else None
            if s.record(name, value):
                facts["recorded"].append(name)
                if was not in (None, ""):
                    facts["changed"].append(name)
        if "client_comment" in given:
            s.field_of("sender_name")  # current 보장
            s.current.client_comment = given["client_comment"].strip() or None
            facts["recorded"].append("client_comment")
        for addr, r in results.items():
            if s.field_of(addr).version != deps[addr]:
                needs.append({"field": addr, "reason": "RESULT_SUPERSEDED"})  # 그사이 다른 값으로 바뀜
                continue
            _apply_address(ctx, addr, r, given, facts, needs)
        for name in invalid_fields(needs):
            s.record_invalid(name, next(n["reason"] for n in needs if n["field"] == name))
        changed = bool(facts["recorded"] or facts.get("blocked_parcel_omitted"))
        if changed:
            s.awaiting_fix = False
        nothing = not changed and not needs
        if nothing and (s.pending or s.awaiting_fix):
            return ToolOutcome("ok", "NOTHING_CHANGED", summary=state_summary(s, policy))
        # 같은 값을 다시 말했는데 확인 대기가 풀려 있으면(no·change 뒤) 되읽기로 다시 연다(운영 통화 56c133c8)
        pending = issue_parcel_confirmation(s, policy, ctx.clock()) if not needs else None
        moved = False
        if pending and not s.pickup_at.valid:  # 되읽기 때 기본 수거 시각을 정해 함께 안내
            iso, moved = default_pickup(ctx.now(), rule)
            s.record("pickup_at", iso, Source.SERVER)
        if pending:  # 되읽기 gate 개방: 확인 내용을 이 결과로 준다(N1)
            sources = {n: f.source for n, f in s.current.fields.items()}
            facts["readback"] = readback_facts(pending.snapshot, sources, policy)
            # 고객 정보·주소 저장은 묻지 않고 택배를 담을 때 한다(사용자 결정 2026-11-06). 여기서는 대상만 정해 둔다
            s.address_offer = save_offer(s) or None
        if pending or "pickup_at" in values or any(n["field"] == "pickup_at" for n in needs):
            facts["pickup"] = {"at": s.pickup_at.value, "today_unavailable": moved, "allowed": describe(rule)}
        phones = [n for n in facts["recorded"] if n.endswith("_phone")]
        if phones:
            facts["phones_to_read"] = phones  # 고객이 새로 불러 준 번호: 한 번 끊어 읽어 확인(README §5)
        facts = {k: v for k, v in facts.items() if v}
        status = "needs_input" if needs else "ok"
        code = needs[0]["reason"] if needs else "NOTHING_CHANGED" if nothing else None
        return ToolOutcome(status, code, facts, needs, state_summary(s, policy))


def _check_items(ctx: ToolContext, args: RecordArgs, counts: dict, facts: dict, needs: list[dict]) -> None:
    s, policy = ctx.state, ctx.policy.parcel_items
    utterance_id, text = ctx.item_utterance or (0, "")
    evidence = [e for e in args.item_evidence or () if e.quote.strip()
                and (ctx.item_utterance is None or e.quote.strip() in text)]
    issues = unclassified_mentions(policy, text)
    if not (counts or evidence or issues or args.omit_blocked_parcel):
        return
    if utterance_id and utterance_id < s.latest_item_utterance_id:
        needs.append({"field": "items", "reason": "RESULT_SUPERSEDED"})
        return
    s.latest_item_utterance_id = max(s.latest_item_utterance_id, utterance_id)
    # 이미 담은 택배의 내용물이 드러나면 그 택배를 다시 연다. 여러 건이면 대상 선택을 기다린다.
    confirmed, resolved = {}, {}
    for e in evidence:
        if e.status == "inquiry":
            continue
        if e.rule == "size":
            sizes = measurements(e.quote) | {key: value for key, value in
                                            (("side_cm", e.side_cm), ("weight_kg", e.weight_kg)) if value is not None}
            exceeded = size_issues(policy, sizes)
            confirmed.update(exceeded)
            for key in sizes.keys() - exceeded.keys():
                resolved.setdefault(key, []).append(e.quote.strip())
        elif rule := policy.rules.get(e.rule):
            if e.status == "removed" or rule.kind == "conditional" and e.status == "condition_met":
                resolved.setdefault(e.rule, []).append(e.quote.strip())
            else:
                code = {"prohibited": "PROHIBITED_ITEM", "format": "UNSUPPORTED_FORMAT",
                        "conditional": "CONDITION_UNMET" if e.status == "condition_unmet" else "NEEDS_CONDITION"}[rule.kind]
                confirmed[e.rule] = ItemIssue(code, rule.guidance)
    for key, quotes in resolved.items():
        remaining = text
        for quote in quotes:
            remaining = remaining.replace(quote, "")
        if key not in unclassified_mentions(policy, remaining):
            issues.pop(key, None)
    issues.update(confirmed)
    if issues and s.current.empty() and s.parcels and not s.editing:
        if len(s.parcels) > 1:
            s.unassigned_item_issues.update(issues)
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
    items = Items(**counts)
    if items.any() and "format" not in issues:
        draft.item_issues.pop("format", None)
    if issues:
        hold_items(s, issues)
    if items.any() and not any(key in draft.item_issues for key in ("format", "side_cm", "weight_kg")):
        s.record("items", items)
        facts["recorded"].append("items")
    if draft.item_issues:
        needs.extend({"field": "items", "reason": issue.code, "detail": issue.guidance}
                     for issue in draft.item_issues.values())
    elif (counts and not items.any()) or not draft["items"].valid:
        needs.append({"field": "items", "reason": "ITEM_UNSPECIFIED"})
    elif resolved:
        facts["recorded"].append("items")


def invalid_fields(needs: list[dict]) -> list[str]:
    """값을 저장하지 않고 재질문할 항목(정정 실패면 기존 값 유지). 늦은 결과·경고는 제외."""
    keep = {"RESULT_SUPERSEDED", "ADDRESS_GEO_MISSING", "ADDRESS_AUTO_SELECTED"}
    return list(dict.fromkeys(n["field"] for n in needs if n["reason"] not in keep))


async def _resolve(ctx: ToolContext, heard: str):
    if ctx.address is None:
        return None
    t0 = time.monotonic()
    try:
        return await ctx.address.resolve(heard)
    finally:
        observe_latency("ADDRESS_LOOKUP", (time.monotonic() - t0) * 1000)


def _apply_address(ctx: ToolContext, addr: str, r, given: dict, facts: dict, needs: list) -> None:
    s = ctx.state
    role = addr.removesuffix("_address")
    detail = f"{role}_address_detail"
    if r is not None and r.status in ("not_found", "region_needed"):
        need = {"field": addr, "reason": "ADDRESS_NOT_FOUND"}
        if r.status == "region_needed":  # 같은 주소가 여러 지역에 있음: Live가 지역을 묻고, 모델이 heard와 합쳐 다시 넘긴다
            need = {"field": addr, "reason": "ADDRESS_REGION_NEEDED", "regions": list(r.alternatives),
                    "heard": given[addr].strip()}
        needs.append(need)
        if detail in facts["recorded"] and not s.field_of(addr).valid:
            s.clear(detail)  # 못 찾은 주소에 붙은 상세주소도 믿을 수 없다
            facts["recorded"].remove(detail)
        return
    value = r.address if r else given[addr].strip()
    source = Source.RESOLVER if r and r.status in ("confirmed", "ambiguous") and value != given[addr].strip() \
        else Source.CUSTOMER
    had = s.field_of(addr).valid
    if s.record(addr, value, source):
        facts["recorded"].append(addr)
        if had:
            facts["changed"].append(addr)
            if detail not in given:  # 주소가 바뀌었는데 상세주소를 같이 말하지 않음 → 이전 상세주소는 맞지 않다
                s.clear(detail)
                facts["cleared"].append(detail)
    setattr(s.current, f"{role}_geo", r.geo if r else None)
    if r is not None and r.status == "ambiguous":
        s.field_of(addr).candidates = r.alternatives  # P6: 나머지 후보 보관
        facts.setdefault("auto_selected", []).append(addr)
    if r is None or r.geo is None:
        facts.setdefault("geo_missing", []).append(addr)  # 접수 필수값 부족(대화는 계속, 결과 INCOMPLETE)
