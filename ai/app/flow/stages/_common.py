"""단계 정의들이 같이 쓰는 조건(guard). 통화 상태·임시 주문만 보는 작은 순수 함수."""

# 접수 중에 끼어들 수 있는 단계(수정·취소·조회 하위 흐름의 진입점)
MAIN_STAGES = ("collecting_new", "collecting_registered", "confirming", "after_order")
SUBFLOWS = ("modify", "cancel", "lookup")


def complete(ctx) -> bool:
    return ctx.order.complete()


def is_registered(ctx) -> bool:
    return ctx.customer_type == "registered"


def is_new(ctx) -> bool:
    return not is_registered(ctx)


def incomplete_new(ctx) -> bool:
    return not complete(ctx) and is_new(ctx)


def incomplete_registered(ctx) -> bool:
    return not complete(ctx) and is_registered(ctx)


def has_save_candidates(ctx) -> bool:
    return bool(ctx.save_candidates)
