"""값 기록/PIN/등록 정보 적용 후 동일한 확인본을 준비한다. 잠금 안에서 호출."""
from app.domain.address_book import save_offer
from app.domain.assess import assess, readback_facts
from app.domain.confirm import issue_parcel_confirmation
from app.domain.pickup import default_pickup, rule_of, describe
from app.domain.state import Source


def prepare_confirmation(ctx) -> dict:
    state, policy = ctx.state, ctx.policy
    if state.order_submitted or not assess(state, policy).readback_ready:
        return {}
    if ctx.live_led and (ctx.address_pending or state.current.sender_geo is None or state.current.receiver_geo is None):
        return {}
    moved = False
    if not state.pickup_at.valid:
        iso, moved = default_pickup(ctx.now(), rule_of(policy.pickup))
        state.record("pickup_at", iso, Source.SERVER)
    pending = issue_parcel_confirmation(state, policy, ctx.clock())
    if pending is None:
        return {}
    sources = {n: f.source for n, f in state.current.fields.items()}
    state.address_offer, state.address_consent = save_offer(state) or None, None
    return {"readback": readback_facts(pending.snapshot, sources, policy),
            "confirmation_id": pending.id, "confirmation_kind": pending.kind,
            "pickup": {"at": state.pickup_at.value, "today_unavailable": moved,
                       "allowed": describe(rule_of(policy.pickup))}}
