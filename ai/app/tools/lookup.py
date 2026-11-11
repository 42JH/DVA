"""읽기 도구: find_destination(받는 곳 찾기) · lookup_orders(보낸 택배 조회) · search_manual(FAQ) · get_state.
원본 match_pins·lookup_orders·search_manual을 새 상태 모델로. 찾은 후보는 state.candidates에 두고 결과에는 이름표만 준다
(상세주소·연락처는 먼저 읽어 주지 않는다. 고객이 물으면 get_state include_values로 준다). 후보 선택은 고객 발화 끝 Decision pick → app.domain.candidates.apply_pick.
"""

import asyncio
import logging
import time

from pydantic import Field

from app.address.parse import detail_text
from app.domain.address_book import receiver_questions_deferred
from app.domain.candidates import apply_pick, buffer_destination_fields, offer, reject_candidates
from app.domain.state import DOCUMENT_ITEM_PRICE, CandidateSet, Items, ParcelDraft, Place, Source
from app.integrations.backend.gateway import BackendFailure
from app.observability.trace import observe_latency
from app.rag.schemas import Evidence, SearchContext
from app.tools.context import ToolContext
from app.tools.executor import Args, model_tool
from app.tools.outcome import ToolOutcome, order_values, state_summary
from backend_client.api import parcel_lookup_details
from backend_client.order import Place as BEPlace
from backend_client.order import match_places, pin_labels, words

log = logging.getLogger(__name__)


# --- find_destination ---

class DestinationArgs(Args):
    name: str | None = Field(None, max_length=30, description="고객이 말한 받는 분 이름(조사·호칭 빼고)")
    place: str | None = Field(None, max_length=80, description="고객이 말한 지역·도로명·건물명(조사 빼고)")
    detail: str | None = Field(None, max_length=40, description="고객이 말한 층·동·호수. 없다고 답하면 빈 문자열")
    organization: str | None = Field(None, max_length=80, description="찾을 기업명. 개인 주소록과 별도로 기업 사원을 검색")
    department: str | None = Field(None, max_length=80, description="찾을 부서명")


def _to_be(p: Place) -> BEPlace:
    from backend_client.order import Geo
    geo = Geo(jibun_address=p.geo.jibun_address, dong_name=p.geo.dong_name, postal_code=p.geo.postal_code) if p.geo else None
    return BEPlace(name=p.name, phone=p.phone, address=p.address, address_detail=p.address_detail, geo=geo)


def _from_be(p: BEPlace, source: Source) -> Place:
    from app.domain.state import Geo
    geo = Geo(p.geo.jibun_address, p.geo.dong_name, p.geo.postal_code) if p.geo else None
    return Place(p.name, p.phone, p.address, p.address_detail, geo, source)


@model_tool("find_destination",
            "주소록·이전 도착지와 기업·사원 배송지에서 고객이 말한 받는 곳을 찾는다. 상호·건물명·도로명은 place에(실제 주소로 바꿔 "
            "현재 택배의 받는 분과 맞는 주소록 후보만 찾고, 없으면 그 주소를 기록한다). 받는 분을 정정할 때는 record_fields를 사용한다. "
            "기업명은 organization, 부서는 department. "
            "고객이 말한 문자열만 채우고 나머지는 null.", DestinationArgs)
async def find_destination(ctx: ToolContext, args: DestinationArgs) -> ToolOutcome:
    said = {k: v.strip() for k, v in args.model_dump().items() if v and v.strip()}
    if not said:
        return ToolOutcome("needs_input", "NOTHING_TO_RECORD")
    name, place, detail = said.get("name"), said.get("place"), said.get("detail")
    company = said.get("organization") or said.get("department")
    async with ctx.lock:
        spoken_fields = {key: value for key, value in (("receiver_name", name), ("receiver_address", place),
                        ("receiver_address_detail", args.detail)) if value is not None}
        if buffer_destination_fields(ctx.state, spoken_fields):
            return ToolOutcome("ok", summary=state_summary(ctx.state, ctx.policy))
        ctx.state.field_of("sender_name")
        draft = ctx.state.current
        if draft.destination_partial_change:
            return ToolOutcome("needs_input", "DEST_CHANGE_USE_RECORD", {
                "guidance": "받는 곳에서 바꾸기로 한 항목에 이미 들은 값이 있으면 record_fields로 바로 기록한다. "
                            "값을 아직 듣지 않았으면 missing의 첫 항목만 묻는다."},
                summary=state_summary(ctx.state, ctx.policy))
        receiver = draft["receiver_name"]
        known_name = receiver.value if receiver.valid else None
        if not company and known_name and name and _recipient_key(name) != _recipient_key(known_name):
            return ToolOutcome("needs_input", "DEST_RECIPIENT_USE_RECORD", {
                "guidance": "고객이 받는 분을 정정했으면 실제로 들은 새 이름과 주소를 record_fields로 기록한다. "
                            "주소만 말했으면 주소만 기록한다."}, summary=state_summary(ctx.state, ctx.policy))
        draft.deferred_destination = None  # 새 검색은 같은 택배의 앞선 검색을 대신한다.
        draft.destination_search_id += 1
        search = (draft, draft.destination_search_id)
        places = list(ctx.state.customer.places)
        started_deferred = receiver_questions_deferred(ctx.state)
    recipient_name = known_name or name
    # 상호·건물명·도로명 → 실제 주소(주소DB, 없으면 카카오 키워드). 핀 문자열은 상호를 담지 않으므로 주소로 대조한다
    # (통화 67d29423: "다이소 구미 인동점"이 낱말 겹침으로 다른 건물의 핀 3건을 불러왔다)
    resolved = await _resolve(ctx, place) if place and not company else None
    if resolved and resolved.status in ("confirmed", "ambiguous"):
        found = book_matches(places, recipient_name, resolved.address, detail)
        if found:  # 기존 수신인: 확인을 거친다
            return await _offer(ctx, search, found)
        return await _new_receiver(ctx, search, name if not known_name else None, resolved.detail or args.detail, resolved)
    if not company:  # 주소로 못 바꾼 말(지역·약칭): 들은 낱말로 주소록 대조
        found = (book_matches(places[:ctx.pin_recent_count], recipient_name, place, detail)
                 or book_matches(places, recipient_name, place, detail))
        if found:  # 최근 N개에서 먼저
            return await _offer(ctx, search, found)
    if resolved and resolved.status == "region_needed":
        return await _destination_problem(ctx, search, ToolOutcome("needs_input", "ADDRESS_REGION_NEEDED", {"found": 0}, [
            {"field": "receiver_address", "reason": "ADDRESS_REGION_NEEDED", "regions": list(resolved.alternatives),
             "heard": place}]))
    if known_name and not company:
        needs = [{"field": "receiver_address", "reason": "DEST_NONE"}] if place else []
        return await _destination_problem(ctx, search, ToolOutcome("needs_input" if needs else "ok", "DEST_NONE",
                                          {"found": 0}, needs), keep_receiver=True)
    query = " ".join(said[k] for k in ("organization", "department", "name", "place", "detail") if k in said)
    page = await ctx.backend.read("company_search", ctx.backend.api.search_company_places, query,
                                  limit=ctx.max_pin_options + 1)
    if page.has_next or page.total_count > ctx.max_pin_options:
        return await _destination_problem(ctx, search, ToolOutcome("needs_input", "DEST_TOO_MANY", {"found": page.total_count},
                           [{"field": "receiver_place", "reason": "DEST_TOO_MANY"}]))
    if page.places:
        return await _offer(ctx, search, [_from_be(p, Source.COMPANY) for p in page.places], page.places)
    ask = "receiver_place" if name and not place else "receiver_name" if place and not name else None
    return await _destination_problem(ctx, search, ToolOutcome("needs_input", "DEST_NONE", {"found": 0},
                       [{"field": ask, "reason": "DEST_NONE"}] if ask else []),
                       name=name, started_deferred=started_deferred)


def _current_search(ctx: ToolContext, search: tuple[ParcelDraft, int]) -> bool:
    draft, search_id = search
    s = ctx.state
    return (s.intent == "order" and not s.order_submitted and s.current is draft
            and draft.destination_search_id == search_id)


async def _destination_problem(ctx: ToolContext, search: tuple[ParcelDraft, int], outcome: ToolOutcome, *,
                               name: str | None = None, started_deferred: bool = False,
                               keep_receiver: bool = False) -> ToolOutcome:
    async with ctx.lock:
        s = ctx.state
        if not _current_search(ctx, search):
            return ToolOutcome("needs_input", "RESULT_SUPERSEDED", summary=state_summary(s, ctx.policy))
        if keep_receiver and s.candidates and s.candidates.kind == "destination":
            reject_candidates(s)
        deferred = receiver_questions_deferred(s)
        facts = {}
        if name and (started_deferred or deferred) and s.record("receiver_name", name):
            facts["recorded"] = ["receiver_name"]
        if deferred:
            return ToolOutcome("ok", facts=facts, summary=state_summary(s, ctx.policy))
        if facts or keep_receiver:
            outcome.facts.update(facts)
            outcome.summary = state_summary(s, ctx.policy)
        return outcome


async def _resolve(ctx: ToolContext, heard: str):
    if ctx.address is None:
        return None
    t0 = time.monotonic()
    try:
        return await ctx.address.resolve(heard)
    finally:
        observe_latency("ADDRESS_LOOKUP", (time.monotonic() - t0) * 1000)


async def _new_receiver(ctx: ToolContext, search: tuple[ParcelDraft, int],
                        name: str | None, detail: str | None, resolved) -> ToolOutcome:
    """그 주소에 저장된 받는 분이 없음: 주소·geo는 해석 결과로, 성함은 고객 말로(없으면 missing이 묻는다).
    주소 출처는 RESOLVER — PIN이면 save_offer가 새 받는 분 핀을 저장하지 않는다."""
    async with ctx.lock:
        s = ctx.state
        if not _current_search(ctx, search):
            return ToolOutcome("needs_input", "RESULT_SUPERSEDED", summary=state_summary(s, ctx.policy))
        s.candidates = None
        if name:
            s.record("receiver_name", name, Source.CUSTOMER)
        before = s.field_of("receiver_address")
        changed = before.valid and before.value != resolved.address
        s.record("receiver_address", resolved.address, Source.RESOLVER)
        if resolved.status == "ambiguous":
            s.field_of("receiver_address").candidates = resolved.alternatives  # P6: 나머지 후보 보관
        if detail is not None:
            s.record("receiver_address_detail", detail_text(detail), Source.CUSTOMER)
        elif changed:
            s.clear("receiver_address_detail")
        s.current.receiver_geo = resolved.geo
        s.bump()
        summary = state_summary(s, ctx.policy)
        if receiver_questions_deferred(s):
            return ToolOutcome("ok", "DEST_NEW_RECEIVER", summary=summary)
    return ToolOutcome("ok", "DEST_NEW_RECEIVER", {
        "address": resolved.address,
        "guidance": "받는 곳 주소를 기록했다. 서버 결과에서 빠진 항목만 묻는다."},
        summary=summary)


def _recipient_key(name: str) -> str:
    return "".join(words(name)).casefold().removesuffix("님")


def book_matches(places, name: str | None, place: str | None, detail: str | None) -> list[Place]:
    """주소록에서 이름·장소(실제 주소 또는 들은 낱말)·상세가 맞는 핀."""
    recipient = _recipient_key(name) if name else None
    places = [p for p in places if recipient is None or _recipient_key(p.name) == recipient]
    if not places:
        return []
    be = [_to_be(p) for p in places]
    return [places[be.index(p)] for p in match_places(be, None, place, detail)]


def offer_destination(state, found: list[Place], max_options: int, be_places: list | None = None) -> ToolOutcome:
    """후보를 state.candidates에 두고 이름표만 돌려준다(호출자가 잠금을 쥔다)."""
    chosen = found[:max_options]
    labels = pin_labels(be_places[:max_options] if be_places else [_to_be(p) for p in chosen])
    if len(set(labels)) != len(labels):  # 구별되지 않는 이름표는 번호로
        labels = [f"{i}번 {label}" for i, label in enumerate(labels, 1)]
    candidates = CandidateSet("destination", tuple(labels), tuple(chosen), len(found))
    if receiver_questions_deferred(state):
        state.current.deferred_destination = candidates
        if state.candidates and state.candidates.kind == "destination":
            state.candidates = None
        return ToolOutcome("ok")
    return _activate_destination(state, candidates)


def _activate_destination(state, candidates: CandidateSet) -> ToolOutcome:
    labels = list(candidates.labels)
    offer(state, "destination", candidates.labels, candidates.items, total=candidates.total)
    facts = {"found": candidates.total or len(labels), "labels": labels}
    if len(labels) == 1:
        facts["guidance"] = f"주소록 후보 1건. '{labels[0]}(으)로 보내시는 거 맞나요?'처럼 질문으로 확인하고 답은 서버가 듣는다."
    return ToolOutcome("needs_choice", "DEST_MANY" if len(labels) > 1 else None, facts)


def resume_destination(state) -> ToolOutcome | None:
    draft = state.current
    if draft is None or state.intent != "order":
        return None
    if receiver_questions_deferred(state):
        if state.candidates and state.candidates.kind == "destination":
            draft.deferred_destination = draft.deferred_destination or state.candidates
            state.candidates = None
        return None
    if draft.deferred_destination and state.candidates is None:
        candidates, draft.deferred_destination = draft.deferred_destination, None
        if state.pending and state.pending.kind == "parcel":
            state.pending = None
        return _activate_destination(state, candidates)
    return None


async def _offer(ctx: ToolContext, search: tuple[ParcelDraft, int],
                 found: list[Place], be_places: list | None = None) -> ToolOutcome:
    async with ctx.lock:
        s, c = ctx.state, ctx.state.candidates
        if not _current_search(ctx, search):
            return ToolOutcome("needs_input", "RESULT_SUPERSEDED", summary=state_summary(s, ctx.policy))
        if (not receiver_questions_deferred(s) and len(found) == 1 and c is not None
                and c.kind == "destination" and found[0] in c.items):
            # 이미 제시한 후보 중 하나로 좁혀짐 = 고객이 고른 것(모델이 find_destination으로 전달). 재제시하면 Decision pick이
            # 하한에 걸렸을 때 받는 곳이 빈 채 도로명 주소를 다시 묻게 된다(통화 d9b5208e) — 서버가 바로 적용한다
            apply_pick(s, c.labels[c.items.index(found[0])])
            return ToolOutcome("ok", "DEST_PICKED", {"guidance": "고객이 고른 주소록의 받는 분으로 기록했다. 다시 확인하지 않고 빠진 항목만 묻는다."},
                               summary=state_summary(s, ctx.policy))
        outcome = offer_destination(s, found, ctx.max_pin_options, be_places)
        outcome.summary = state_summary(s, ctx.policy)
        return outcome


# --- lookup_orders ---

# 주문 상태 → 모델에 넘길 뜻(BE 계약 docs/be-contract/ai/backend-api.md §2·§4). 원문 상태만 주면 모델이 COLLECTING을
# '수거 중'으로 추측했다(통화 293). 지시문(workflow.toml·business_rules.md)이 아니라 서버 코드에 둔다 — 다른 개발자가
# 수정 중인 지시문과 간섭하지 않게(2026-11-06 사용자 결정). 수거·배송·결제 완료는 말하지 않는다(백엔드에 수거·배송 상태 없음).
ORDER_STATUS_TEXT = {
    "COLLECTING": "접수 미완료(정보 수집 중), 최종 접수 전",
    "notPaid": "접수 대기 중, 결제가 확인되면 접수 진행",
    "PAID": "접수 대기 중",
    "SUBMITTING": "접수 처리 중",
    "ACCEPTED": "접수 완료",
    "SUBMISSION_FAILED": "접수 처리 문제, 담당자 확인 중",
    "CANCELLED": "취소됨",
}
DRAFT_STATUS_TEXT = {
    "READY": "이번 통화에서 접수된 택배",
    "EDITING": "이번 통화에서 정보를 확인하거나 수정 중인 택배",
}


def status_text(status: str | None) -> str:
    """모르는 상태는 추측하지 않는다."""
    return DRAFT_STATUS_TEXT.get(status) or ORDER_STATUS_TEXT.get(status or "", "확인 필요")


# 조회 범위: BE가 통화 번호(call_session_seq)로 지금 전화한 고객의 주문만 준다. 다른 번호·다른 고객의 접수는 조회·안내하지 않는다
# (2026-11-06 사용자 결정, 운영 통화 c156341e: 다른 번호 조회 요청에 본인 주문을 '그 번호로 접수된 건'이라 안내함).
# 지시문이 아니라 도구 결과에 둔다(ORDER_STATUS_TEXT와 같은 이유).
SCOPE = "지금 전화하신 번호로 접수된 택배만 조회됨. 다른 번호·다른 고객의 접수 정보는 안내할 수 없음"
OTHER_CUSTOMER = "다른 고객의 접수 정보는 안내드릴 수 없음. 지금 전화하신 번호로 접수된 택배만 조회 가능"


class LookupArgs(Args):
    receiver_name: str | None = Field(None, max_length=30, description="받는 분 성함(조사·호칭 빼고). 기억하지 못하면 null")
    other_customer: bool = Field(False, description="고객이 다른 전화번호로 접수된 택배나 다른 사람(다른 고객)이 접수한 택배를 "
                                                     "찾으면 true. 받는 분 성함은 다른 사람이어도 false")


@model_tool("lookup_orders", "지금 전화한 번호의 기존 주문과 이번 통화에서 저장한 택배를 받는 분 성함으로 찾는다. "
                             "다른 번호·다른 고객의 접수는 조회할 수 없다(other_customer=true로 부르면 안내할 사실을 준다).",
            LookupArgs)
async def lookup_orders(ctx: ToolContext, args: LookupArgs) -> ToolOutcome:
    if args.other_customer:  # BE를 부르지 않는다: 본인 주문을 다른 번호의 결과처럼 안내하지 않게
        return ToolOutcome("rejected", "ORDER_OTHER_CUSTOMER", {"found": 0, "scope": OTHER_CUSTOMER})
    seq = ctx.state.customer.call_session_seq
    if not seq:
        return ToolOutcome("unavailable", "CALL_NOT_REGISTERED")  # 2단계 고객 확인 전·실패: 고객 범위 없음
    api = ctx.backend.api
    failed = []
    if ctx.draft_intake:
        budget = ctx.tool_budget_sec * 0.8
        pending = ctx.pending_drafts and ctx.pending_drafts()
        results = await asyncio.gather(
            ctx.backend.read("find_parcels", api.find_parcels, seq, ctx.lookup_limit, budget_sec=budget), *(
            ctx.backend.read("list_drafts", api.list_drafts, seq, status, same_call=True, budget_sec=budget)
            for status in DRAFT_STATUS_TEXT), return_exceptions=True)
        for source, result in zip(("order", "ready_drafts", "editing_drafts"), results):
            if isinstance(result, BackendFailure):
                failed.append(source)
            elif isinstance(result, BaseException):
                raise result
        orders = [] if "order" in failed else results[0]
        order_parcels = {(order.get("order_seq"), order.get("order_parcel_seq")) for order in orders}
        drafts = {}
        for rows in results[1:]:
            if not isinstance(rows, BackendFailure):
                for row in rows:
                    mapped = row.get("orderSeq"), row.get("orderParcelSeq")
                    if (row["callSessionSeq"] == seq and row["status"] in DRAFT_STATUS_TEXT
                            and not (all(mapped) and mapped in order_parcels)):
                        previous = drafts.get(row["draftSeq"])
                        if previous is None or previous["version"] < row["version"]:
                            drafts[row["draftSeq"]] = row
        orders = orders + [_draft_result(row) for row in drafts.values()]
        if pending or (ctx.pending_drafts and ctx.pending_drafts()):
            failed.append("draft_save_pending")
    else:
        orders = await ctx.backend.read("find_parcels", api.find_parcels, seq, ctx.lookup_limit)
    if args.receiver_name:
        said = "".join(words(args.receiver_name))
        orders = [o for o in orders if said and said in "".join(words(o.get("receiver_name")))]
    scope = ("지금 전화하신 번호의 주문과 이번 통화에서 저장한 택배만 조회됨. "
             "다른 번호·다른 고객의 정보는 안내할 수 없음") if ctx.draft_intake else SCOPE
    facts = {"found": len(orders), "scope": scope}
    if failed:
        facts["unavailable_sources"] = failed
        facts["guidance"] = "조회에 실패한 범위의 내역은 확인하지 못했다고 안내한다. 없다고 단정하지 않는다."
    labels = [f"{i}번 {o.get('receiver_name') or '받는 분 미상'}님 택배"
              + (" (이번 통화)" if "draft_seq" in o else " (기존 주문)" if ctx.draft_intake else "")
              for i, o in enumerate(orders, 1)]
    async with ctx.lock:
        pending_cancel = ctx.state.pending
        current_cancel = (pending_cancel and pending_cancel.kind == "cancel"
                          and "client_parcel_id" in pending_cancel.snapshot)
        if not current_cancel:
            ctx.state.selected_order = None
            if pending_cancel and pending_cancel.kind == "cancel":
                ctx.state.pending = None
            if len(orders) == 1:  # 하나면 바로 대상으로(취소는 확인 관문을 거친다)
                ctx.state.selected_order, ctx.state.candidates = orders[0], None
                ctx.state.bump()
            elif orders:
                offer(ctx.state, "order", tuple(labels), tuple(orders))
            elif ctx.state.candidates and ctx.state.candidates.kind == "order":
                ctx.state.candidates = None
                ctx.state.bump()
    if not orders:
        return ToolOutcome("unavailable" if failed else "needs_input",
                           "ORDER_LOOKUP_PARTIAL" if failed else "ORDER_NOT_FOUND_BY_NAME", facts)
    facts["orders"] = [{"label": label, "status": o.get("status"), "status_text": status_text(o.get("status")),
                        **({"source": "draft" if "draft_seq" in o else "order"} if ctx.draft_intake else {})}
                       for label, o in zip(labels, orders)]
    if len(orders) == 1 and not current_cancel and ctx.state.intent != "cancel":
        facts["lookup_order"] = lookup_order_facts(orders[0])
    return ToolOutcome("needs_choice" if len(orders) > 1 else "ok", None,
                       facts)


def _draft_result(row: dict) -> dict:
    parcel = row["parcel"] or {}
    return {"draft_seq": row["draftSeq"], "version": row["version"], "status": row["status"],
            "receiver_name": (parcel.get("destination") or {}).get("name"), "details": parcel_lookup_details(parcel)}


def lookup_order_facts(order: dict) -> dict:
    status = order.get("status")
    details = dict(order.get("details") or {})
    if details.get("item_price") == DOCUMENT_ITEM_PRICE and Items(**(details.get("items") or {})).documents_only():
        details.pop("item_price")
    return {"receiver_name": order.get("receiver_name"), "status": status,
            "status_text": "접수된 택배" if status == "ACCEPTED" else status_text(status),
            "source": "draft" if "draft_seq" in order else "order", **details}


# --- search_manual ---

class ManualQuery(Args):
    question: str = Field(min_length=1, max_length=500, description="고객 질문의 조건·부정·규격을 유지한 검색 질문")


@model_tool("search_manual", "FAQ·이용 정책·포장·요금·배송·취소 조건을 검색. 실제 주문 조회나 취소 실행에는 쓰지 않음.",
            ManualQuery, budget="rag", timeout_code="KB_TIMEOUT")
async def search_manual(ctx: ToolContext, args: ManualQuery) -> ToolOutcome:
    if ctx.rag is None:
        return ToolOutcome("unavailable", "KB_UNAVAILABLE")
    try:
        result = await ctx.rag(args.question)
    except Exception:
        log.exception("매뉴얼 검색 실패 %s", ctx.session_id)
        return ToolOutcome("unavailable", "KB_UNAVAILABLE")
    payload = result["context"]
    context = SearchContext(question=payload["question"], status=payload["status"], evidence=tuple(
        Evidence(**{key: doc[key] for key in ("chunk_id", "source_id", "title", "content")})
        for doc in payload["evidence"]))
    if context.status != "found":
        return ToolOutcome("ok", "KB_NO_EVIDENCE", {"answerable": False, "context": context.llm_payload()})
    scores = [row.get("reranker_score") for row in result.get("reranked") or []]
    floor = ctx.rag_min_score
    low = floor is not None and scores and scores[0] is not None and scores[0] < floor
    return ToolOutcome("ok", "KB_LOW_SCORE" if low else None,
                       {"answerable": not low, "context": context.llm_payload()})


# --- get_state ---

class StateArgs(Args):
    include_values: bool = Field(False, description="고객이 진행 중인 택배에 기록된 값이나 제시된 받는 곳 후보의 "
                                                    "주소·상세주소·연락처를 물었을 때만 true")


@model_tool("get_state", "지금까지 기록된 항목의 상태와 빠진 항목을 본다(아무것도 바꾸지 않음). include_values=true면 "
                         "진행 중인 택배에 기록된 값과 제시 중인 받는 곳 후보의 값도 준다.", StateArgs)
async def get_state(ctx: ToolContext, args: StateArgs) -> ToolOutcome:
    async with ctx.lock:
        values = order_values(ctx.state, ctx.policy) if args.include_values else {}
        return ToolOutcome("ok", facts=values, summary=state_summary(ctx.state, ctx.policy))

