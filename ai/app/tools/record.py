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
from datetime import timedelta
from pydantic import Field

from app.domain.preparation import prepare_confirmation
from app.domain.pickup import check_pickup, default_pickup, describe, rule_of
from app.domain.rules import normalize_phone, parse_pickup
from app.domain.state import Items, Source
from app.observability.trace import observe_latency
from app.policy.inputs import input_rules
from app.tools.context import ToolContext
from app.tools.executor import Args, model_tool
from app.tools.outcome import ToolOutcome, state_summary

TEXT = ("sender_name", "sender_address_detail", "receiver_name", "receiver_address_detail")
ADDRESSES = ("sender_address", "receiver_address")
COUNTS = ("document_count", "small_box_count", "medium_box_count", "big_box_count")
INPUT_RULES = input_rules()


class RecordArgs(Args):
    utterance_id: int | None = Field(None, ge=1, description="Live 주도 모드에서 최신 통화 상태의 고객 발화 ID. get_state로 확인")
    sender_name: str | None = Field(None, max_length=30)
    sender_address: str | None = Field(None, max_length=120, description="보내는 곳 기본 주소(도로명·지번)")
    sender_address_detail: str | None = Field(None, max_length=60, description="동·호수 등. 없다고 하면 빈 문자열")
    receiver_name: str | None = Field(None, max_length=30)
    receiver_phone: str | None = Field(None, max_length=40, description="들은 그대로(한글 숫자 가능)")
    receiver_address: str | None = Field(None, max_length=120, description="받는 곳 기본 주소(도로명·지번)")
    receiver_address_detail: str | None = Field(None, max_length=60, description="동·호수 등. 없다고 하면 빈 문자열")
    document_count: int | None = Field(None, ge=0, le=INPUT_RULES.document_max, description="서류 봉투 수. 물품은 지금 보낼 전체 구성을 넣는다")
    small_box_count: int | None = Field(None, ge=0, le=INPUT_RULES.box_total_max, description="소형 박스 수. 박스 규격 합계 한도 적용")
    medium_box_count: int | None = Field(None, ge=0, le=INPUT_RULES.box_total_max, description="중형 박스 수")
    big_box_count: int | None = Field(None, ge=0, le=INPUT_RULES.box_total_max, description="대형 박스 수")
    other_item: str | None = Field(None, max_length=40, description="서류·박스가 아닌 물품일 때만 그 설명")
    item_price: int | None = Field(None, ge=INPUT_RULES.item_price_min, le=INPUT_RULES.item_price_max, description="물품 가액(원). 예: 만 원 → 10000")
    client_comment: str | None = Field(None, max_length=100, description="배송 요청 사항(고객이 말했을 때만)")
    pickup_at: str | None = Field(None, max_length=40, description="고객이 수거 시각을 바꿀 때만. 한국 시간 ISO 8601"
                                  "(예: 2026-11-05T10:00:00+09:00). 오늘·내일은 지시문의 현재 시각 기준")
    pickup_after_minutes: int | None = Field(None, ge=1, description="'한 시간 뒤' 등 상대 수거 시각. 분 단위, 서버가 실행 시각 기준 계산. pickup_at과 동시에 쓰지 않음")


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
            RecordArgs)
async def record_fields(ctx: ToolContext, args: RecordArgs) -> ToolOutcome:
    if ctx.closed:
        return ToolOutcome("rejected", "CALL_ENDING")
    given = args.model_dump(exclude_none=True, exclude={"utterance_id"})
    if ctx.live_led and (args.utterance_id is None or args.utterance_id != ctx.last_utterance_id):
        return ToolOutcome("rejected", "RECORD_STALE", {"utterance_id": ctx.last_utterance_id})
    if not given:
        return ToolOutcome("needs_input", "NOTHING_TO_RECORD")
    now = ctx.now()
    if "pickup_after_minutes" in given:
        if "pickup_at" in given:
            return ToolOutcome("needs_input", "PICKUP_CONFLICT")
        at = now + timedelta(minutes=given.pop("pickup_after_minutes"))
        # 처리/전송 중 경계가 지나 반복 거절되지 않도록 기존 기본 시각과 같은 10분 단위 올림.
        if at.second or at.microsecond:
            at = at.replace(second=0, microsecond=0) + timedelta(minutes=1)
        if at.minute % 10:
            at += timedelta(minutes=10-at.minute % 10)
        given["pickup_at"] = at.isoformat()
    s, policy = ctx.state, ctx.policy
    if s.order_submitted:  # 접수 후 수정·추가 없음 — 받아 적으면 반영 안 된 값을 확정한 것처럼 안내하게 된다
        return ToolOutcome("rejected", "ORDER_SUBMITTED", {"order": "submitted"})
    values, needs = {}, []
    for name in TEXT:
        if name in given:
            values[name] = clean_name(given[name]) if name.endswith("_name") else given[name].strip()
    if "receiver_phone" in given:
        phone = normalize_phone(given["receiver_phone"])
        if phone:
            values["receiver_phone"] = phone
        else:
            needs.append({"field": "receiver_phone", "reason": "PHONE_INVALID_DIGITS"})
    if "item_price" in given:
        values["item_price"] = given["item_price"]
    rule = rule_of(policy.pickup)
    if "pickup_at" in given:  # 고객 조정: 형식 → 업무 범위(1시간 이후·09~17시·3일 이내)
        iso, code = parse_pickup(given["pickup_at"], now, rule.min_lead_minutes)
        code = code or check_pickup(iso, now, rule)
        if code:
            needs.append({"field": "pickup_at", "reason": code})
        else:
            values["pickup_at"] = iso
    item_parts = {k: given[k] for k in (*COUNTS, "other_item") if k in given}

    async with ctx.lock:  # ① 주소 필드 버전과 지금 값
        deps = {a: s.field_of(a).version for a in ADDRESSES}
        current = {a: s.field_of(a).value for a in ADDRESSES}
        if ctx.live_led:
            s.unresolved_fields.update(k for k in given if k in ctx.policy.fields or k == "pickup_at")
            if any(k in given for k in (*COUNTS, "other_item")):
                s.unresolved_fields.add("items")
    heard = {a: given[a].strip() for a in ADDRESSES if a in given and
             (given[a].strip() != current[a] or a in s.unresolved_fields or
              (ctx.live_led and getattr(s.current, a.replace("address", "geo")) is None))}
    ctx.address_pending += len(heard)
    try:
        results = dict(zip(heard, await asyncio.gather(*(_resolve(ctx, h) for h in heard.values()))))  # ②
    finally:
        ctx.address_pending -= len(heard)

    async with ctx.lock:  # ③
        if ctx.closed:
            return ToolOutcome("rejected", "CALL_ENDING")
        if ctx.live_led and args.utterance_id != ctx.last_utterance_id:
            return ToolOutcome("rejected", "RESULT_SUPERSEDED", {"utterance_id": ctx.last_utterance_id})
        facts: dict = {"recorded": [], "changed": [], "cleared": []}
        for name, value in values.items():
            prev = s.field_of(name)
            was = prev.value if prev.valid else None
            if s.record(name, value):
                facts["recorded"].append(name)
                if was not in (None, ""):
                    facts["changed"].append(name)
            s.unresolved_fields.discard(name)
        if item_parts:  # 모델이 지금 보낼 물품 전체를 넘긴다(render_backend) → 교체(정정 "중형 아니라 소형" 대응)
            items = Items(**{k: (v.strip() or None) if isinstance(v, str) else v for k, v in item_parts.items()})
            if sum(getattr(items, k) for k in COUNTS[1:]) > INPUT_RULES.box_total_max:
                needs.append({"field": "items", "reason": "BOX_TOTAL_EXCEEDED"})
            elif items.any():
                s.record("items", items)
                facts["recorded"].append("items")
            else:
                needs.append({"field": "items", "reason": "ITEM_UNSPECIFIED"})
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
            if ctx.live_led:
                s.unresolved_fields.add(name)
        for name in facts["recorded"]:
            s.unresolved_fields.discard(name)
        if not facts["recorded"] and not needs and not ctx.live_led:
            return ToolOutcome("ok", "NOTHING_CHANGED", summary=state_summary(s, policy))
        if not needs:
            facts.update(prepare_confirmation(ctx))
        if "pickup" not in facts and ("pickup_at" in values or any(n["field"] == "pickup_at" for n in needs)):
            facts["pickup"] = {"at": s.pickup_at.value, "today_unavailable": False, "allowed": describe(rule)}
        phones = [n for n in facts["recorded"] if n.endswith("_phone")]
        if phones:
            facts["phones_to_read"] = phones  # 고객이 새로 불러 준 번호: 한 번 끊어 읽어 확인(README §5)
        facts = {k: v for k, v in facts.items() if v}
        status = "needs_input" if needs else "ok"
        return ToolOutcome(status, needs[0]["reason"] if needs else None, facts, needs, state_summary(s, policy))


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
    if ctx.live_led and (r is None or r.status in ("off", "error") or (r.status != "not_found" and r.geo is None)):
        reason = "ADDRESS_UNAVAILABLE" if r is None or r.status in ("off", "error") else "ADDRESS_GEO_MISSING"
        needs.append({"field": addr, "reason": reason})
        return
    if r is not None and r.status == "not_found":
        needs.append({"field": addr, "reason": "ADDRESS_NOT_FOUND"})
        if detail in facts["recorded"] and not s.field_of(addr).valid:
            s.clear(detail)  # 못 찾은 주소에 붙은 상세주소도 믿을 수 없다
            facts["recorded"].remove(detail)
        return
    value = r.address if r else given[addr].strip()
    s.unresolved_fields.discard(addr)
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
