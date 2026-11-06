"""읽기 도구: find_destination(받는 곳 찾기) · lookup_orders(보낸 택배 조회) · search_manual(FAQ) · get_state.
원본 match_pins·lookup_orders·search_manual을 새 상태 모델로. 찾은 후보는 state.candidates에 두고 결과에는 이름표만 준다
(상세주소·연락처는 먼저 읽어 주지 않는다). 후보 선택은 고객 발화 끝 Decision pick → app.domain.candidates.apply_pick.
"""

import logging

from pydantic import Field

from app.domain.candidates import offer
from app.domain.state import Place, Source
from app.rag.schemas import Evidence, SearchContext
from app.tools.context import ToolContext
from app.tools.executor import Args, model_tool
from app.tools.outcome import ToolOutcome, state_summary
from backend_client.order import Place as BEPlace
from backend_client.order import match_places, pin_labels, words

log = logging.getLogger(__name__)


# --- find_destination ---

class DestinationArgs(Args):
    name: str | None = Field(None, max_length=30, description="고객이 말한 받는 분 이름(조사·호칭 빼고)")
    place: str | None = Field(None, max_length=80, description="고객이 말한 지역·도로명·건물명(조사 빼고)")
    detail: str | None = Field(None, max_length=40, description="고객이 말한 층·동·호수")
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
            "주소록·이전 도착지와 기업·사원 배송지에서 고객이 말한 받는 곳을 찾는다. 기업명은 organization, 부서는 department. "
            "고객이 말한 문자열만 채우고 나머지는 null.", DestinationArgs)
async def find_destination(ctx: ToolContext, args: DestinationArgs) -> ToolOutcome:
    said = {k: v.strip() for k, v in args.model_dump().items() if v and v.strip()}
    if not said:
        return ToolOutcome("needs_input", "NOTHING_TO_RECORD")
    name, place, detail = said.get("name"), said.get("place"), said.get("detail")
    places = list(ctx.state.customer.places)
    if not said.get("organization") and not said.get("department"):
        be = [_to_be(p) for p in places]
        found = match_places(be[:ctx.pin_recent_count], name, place, detail) or match_places(be, name, place, detail)
        if found:  # 최근 N개에서 먼저
            return await _offer(ctx, [places[be.index(p)] for p in found])
    query = " ".join(said[k] for k in ("organization", "department", "name", "place", "detail") if k in said)
    page = await ctx.backend.read("company_search", ctx.backend.api.search_company_places, query,
                                  limit=ctx.max_pin_options + 1)
    if page.has_next or page.total_count > ctx.max_pin_options:
        return ToolOutcome("needs_input", "DEST_TOO_MANY", {"found": page.total_count},
                           [{"field": "receiver_place", "reason": "DEST_TOO_MANY"}])
    if page.places:
        return await _offer(ctx, [_from_be(p, Source.COMPANY) for p in page.places], page.places)
    ask = "receiver_place" if name and not place else "receiver_name" if place and not name else None
    return ToolOutcome("needs_input", "DEST_NONE", {"found": 0},
                       [{"field": ask, "reason": "DEST_NONE"}] if ask else [])


async def _offer(ctx: ToolContext, found: list[Place], be_places: list | None = None) -> ToolOutcome:
    chosen = found[:ctx.max_pin_options]
    labels = pin_labels(be_places[:ctx.max_pin_options] if be_places else [_to_be(p) for p in chosen])
    if len(set(labels)) != len(labels):  # 구별되지 않는 이름표는 번호로
        labels = [f"{i}번 {label}" for i, label in enumerate(labels, 1)]
    async with ctx.lock:
        offer(ctx.state, "destination", tuple(labels), tuple(chosen))
    return ToolOutcome("needs_choice", "DEST_MANY" if len(chosen) > 1 else None,
                       {"found": len(found), "labels": labels})


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


def status_text(status: str | None) -> str:
    """모르는 상태는 추측하지 않는다."""
    return ORDER_STATUS_TEXT.get(status or "", "확인 필요")


# 조회 범위: BE가 통화 번호(call_session_seq)로 지금 전화한 고객의 주문만 준다. 다른 번호·다른 고객의 접수는 조회·안내하지 않는다
# (2026-11-06 사용자 결정, 운영 통화 c156341e: 다른 번호 조회 요청에 본인 주문을 '그 번호로 접수된 건'이라 안내함).
# 지시문이 아니라 도구 결과에 둔다(ORDER_STATUS_TEXT와 같은 이유).
SCOPE = "지금 전화하신 번호로 접수된 택배만 조회됨. 다른 번호·다른 고객의 접수 정보는 안내할 수 없음"
OTHER_CUSTOMER = "다른 고객의 접수 정보는 안내드릴 수 없음. 지금 전화하신 번호로 접수된 택배만 조회 가능"


class LookupArgs(Args):
    receiver_name: str | None = Field(None, max_length=30, description="받는 분 성함(조사·호칭 빼고). 기억하지 못하면 null")
    other_customer: bool = Field(False, description="고객이 다른 전화번호로 접수된 택배나 다른 사람(다른 고객)이 접수한 택배를 "
                                                     "찾으면 true. 받는 분 성함은 다른 사람이어도 false")


@model_tool("lookup_orders", "이 발신번호로 접수된 택배를 받는 분 성함으로 찾는다(가장 최근 것부터).", LookupArgs)
async def lookup_orders(ctx: ToolContext, args: LookupArgs) -> ToolOutcome:
    if args.other_customer:  # BE를 부르지 않는다: 본인 주문을 다른 번호의 결과처럼 안내하지 않게
        return ToolOutcome("rejected", "ORDER_OTHER_CUSTOMER", {"found": 0, "scope": OTHER_CUSTOMER})
    seq = ctx.state.customer.call_session_seq
    if not seq:
        return ToolOutcome("unavailable", "CALL_NOT_REGISTERED")  # 2단계 고객 확인 전·실패: 고객 범위 없음
    orders = await ctx.backend.read("find_parcels", ctx.backend.api.find_parcels, seq, ctx.lookup_limit)
    if args.receiver_name:
        said = "".join(words(args.receiver_name))
        orders = [o for o in orders if said and said in "".join(words(o.get("receiver_name")))]
    if not orders:
        return ToolOutcome("needs_input", "ORDER_NOT_FOUND_BY_NAME", {"found": 0, "scope": SCOPE})
    labels = [f"{i}번 {o.get('receiver_name') or '받는 분 미상'}님 택배" for i, o in enumerate(orders, 1)]
    async with ctx.lock:
        if len(orders) == 1:  # 하나면 바로 대상으로(취소는 확인 관문을 거친다)
            ctx.state.selected_order, ctx.state.candidates = orders[0], None
            ctx.state.bump()
        else:
            offer(ctx.state, "order", tuple(labels), tuple(orders))
    return ToolOutcome("needs_choice" if len(orders) > 1 else "ok", None,
                       {"found": len(orders), "scope": SCOPE, "orders": [{"label": lb, "status": o.get("status"),
                                                         "status_text": status_text(o.get("status"))}
                                                        for lb, o in zip(labels, orders)]})


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

class NoArgs(Args):
    pass


@model_tool("get_state", "지금까지 기록된 항목의 상태와 빠진 항목을 본다(맥락 복구용, 아무것도 바꾸지 않음).", NoArgs)
async def get_state(ctx: ToolContext, args: NoArgs) -> ToolOutcome:
    async with ctx.lock:
        return ToolOutcome("ok", summary=state_summary(ctx.state, ctx.policy))

