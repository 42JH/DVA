"""현재 고객 기본주소와 통화 중 보내는 분 정정의 회귀 검증."""
from conftest import CALLER, GEO, FakeBackend, make_call, run
from test_backend_api import PIN, REGISTERED, api, context
from test_flow import ORIGIN

from app.flow.stages.order import order_answer


def ready(db=None):
    db = db or FakeBackend()
    db.add_customer(CALLER, "현재이름", default_origin=ORIGIN)
    call = make_call(db)
    run(order_answer(call, "yes"))
    return call


def test_default_origin_is_independent_of_old_pins_and_history():
    db = FakeBackend()
    old = ORIGIN.model_copy(update={"name": "옛이름", "address": "이전 주소"})
    db.add_customer(CALLER, "현재이름", pins=[old], recent=(old, old), default_origin=ORIGIN)
    call = make_call(db)
    assert call.origin_offer.address == ORIGIN.address
    call.order.sender_name = "통화에서고친이름"
    run(order_answer(call, "yes"))
    assert call.order.sender_name == "통화에서고친이름"
    assert call.order.sender_phone == CALLER
    assert db.pins[CALLER][0] == old


def test_no_default_origin_does_not_automatically_use_history_or_pin():
    db = FakeBackend()
    db.add_customer(CALLER, "현재이름", pins=[ORIGIN], recent=(ORIGIN, ORIGIN))
    call = make_call(db)
    assert call.recent_place("origin") is None and call.origin_offer is None
    assert call.flow.stage == "HUB"


def test_default_origin_without_any_pin_or_order_and_placeholder_coordinates():
    data = {**REGISTERED, "personalPins": [], "companyPins": [], "callSessionSeq": None,
            "customer": {"customerSeq": 12, "name": "현재이름", "phoneNumber": CALLER,
                         "address": {k: v for k, v in {**PIN, "latitude": 1, "longitude": 1}.items()
                                     if k not in ("name", "phoneNumber")}}}
    backend, seen = api(context(data))
    call = make_call(backend)
    assert call.origin_offer.name == "현재이름" and call.origin_offer.geo is None
    run(order_answer(call, "yes"))
    assert call.order.sender_geo == GEO and call.order.sender_name == "현재이름"
    assert len(seen) == 1


def test_next_parcel_keeps_corrected_sender_and_reuses_previous_origin():
    call = ready()
    call.order.sender_name = "통화정정이름"
    call.order.sender_phone = "01088889999"
    call.parcels.append(call.order)
    call.new_parcel()
    call.start_parcel()
    assert call.order.sender_name == "통화정정이름" and call.order.sender_phone == "01088889999"
    assert call.order.sender_address == ORIGIN.address and call.origin_offer is None
