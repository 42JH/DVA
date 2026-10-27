"""단계 정의들이 같이 쓰는 조건(guard). 통화 상태·임시 주문만 보는 작은 순수 함수."""

from app.flow import engine
from app.flow.engine import Transition

COMMON_TOOLS = ("get_state", "search_manual")


def is_registered(ctx) -> bool:
    return ctx.customer_type == "registered"


def is_new(ctx) -> bool:
    return not is_registered(ctx)


def registered_with_recent(ctx) -> bool:
    return is_registered(ctx) and ctx.recent is not None


def registered_without_recent(ctx) -> bool:
    return is_registered(ctx) and ctx.recent is None


def complete(ctx) -> bool:
    return ctx.order.complete()


def incomplete(ctx) -> bool:
    return not complete(ctx)


def origin_due(ctx) -> bool:
    """등록 고객, 다음 항목이 출발지, 저장된 출발지 있음, 이번 주문에서 아직 안 물음."""
    if not is_registered(ctx) or ctx.origin_checked or not ctx.places["origin"]:
        return False
    missing = engine.missing(ctx)
    return bool(missing) and missing[0] == "sender_address"


def no_saved_destinations(ctx) -> bool:
    return not ctx.places["destination"]


def address_pending(ctx) -> bool:
    return bool(ctx.address_pending)


def has_save_candidates(ctx) -> bool:
    return bool(ctx.save_candidates)


def reset_for_new_order(ctx, prev: str) -> None:
    if prev == "after_order":
        ctx.reset_order_flags()


def place_text(p) -> str:
    return f"{p.name}, {p.address} {p.address_detail}".strip()


# 새 주문의 첫 단계(통화 시작과 같은 규칙)
NEW_ORDER = (
    Transition("intent.new_order", "collecting", is_new),
    Transition("intent.new_order", "recent_offer", registered_with_recent),
    Transition("intent.new_order", "find_destination", registered_without_recent),
)
