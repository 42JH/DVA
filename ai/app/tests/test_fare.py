"""배송비: 원본 요금표·규칙 그대로(config/server.toml [fare], app/domain/fare.py)."""

from functools import partial

import pytest

from app.config import load_server_config
from app.domain.fare import parcel_fare
from app.domain.outcome import decide_outcome
from app.domain.state import Items
from app.integrations.backend.mapping import submit_body
from app.tests.test_domain import NOW, P, confirm_once, filled

TABLE = load_server_config().fare.model_dump()


def test_table_is_original_values():
    assert TABLE == {"document": 3850, "small_box": 4950, "medium_box": 6050, "big_box": 7150}  # 2026-10-31 결정


@pytest.mark.parametrize("items, fare", [
    (Items(small_box_count=1), 4950),
    (Items(document_count=2, medium_box_count=1, big_box_count=3), 2 * 3850 + 6050 + 3 * 7150),
    (Items(), None),                                      # 물품 없음
    (Items(other_item="이불"), None),                      # 기타 물품만
    (Items(small_box_count=1, other_item="이불"), None),   # 기타 물품이 섞이면 모른다
    (None, None),
])
def test_parcel_fare_rules(items, fare):
    assert parcel_fare({"items": items}, TABLE) == fare


def test_missing_size_price_means_unknown():
    assert parcel_fare({"items": Items(big_box_count=1)}, TABLE | {"big_box": None}) is None


def test_outcome_complete_with_config_fare_and_body_amounts():
    s = filled()
    confirm_once(s)
    first = s.parcels[0].draft
    for name, f in first.fields.items():  # 두 번째 택배: 같은 보내는 곳, 다른 받는 분·물품
        s.record(name, f.value, f.source)
    s.record("items", Items(medium_box_count=2))
    s.record("receiver_name", "최지우")
    s.current.sender_geo = s.current.receiver_geo = first.sender_geo
    confirm_once(s, t=300.0)
    o = decide_outcome(s, P, NOW, partial(parcel_fare, table=TABLE))
    assert (o.kind, o.fares) == ("COMPLETE", (4950, 12100))
    call = {"providerCallId": "live_1", "callerPhoneNumber": "01012345678", "incomingAt": "2026-11-03T01:00:00Z"}
    body = submit_body(o, call, 12, None, "01012345678")
    assert [p["notifiedPrice"] for p in body["parcels"]] == [4950, 12100] and body["totalAmount"] == 17050


def test_other_item_parcel_goes_incomplete():
    s = filled(items=Items(other_item="이불"))
    confirm_once(s)
    o = decide_outcome(s, P, NOW, partial(parcel_fare, table=TABLE))
    assert o.kind == "INCOMPLETE" and "FARE_UNKNOWN" in o.reasons
