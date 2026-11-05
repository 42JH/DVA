"""정책 한 곳의 변경이 실제 세션·도구 검증·수거 계산에 일관되게 적용되는지 검사한다."""

from datetime import datetime, timedelta

import pytest
from pydantic import ValidationError

from app.domain.pickup import check_pickup, default_pickup, describe, rule_of
from app.domain.rules import normalize_phone
from app.domain.state import Items
from app.policy.model import ROOT, Policy, load_policy
from app.policy.render import render_backend, render_live
from app.tests.test_calls import service
from app.tests.test_tools import NOW, call, ctx
from app.tools import function_specs


@pytest.mark.parametrize("args, accepted", [
    ({"item_price": 0}, False), ({"item_price": 1}, True),
    ({"item_price": 99_999_999}, True), ({"item_price": 100_000_000}, False),
    ({"item_price": 200_000_000}, False),
    ({"document_count": 100}, True), ({"document_count": 101}, False),
    ({"small_box_count": 10}, True), ({"big_box_count": 11}, False),
    ({"small_box_count": 4, "medium_box_count": 3, "big_box_count": 3}, True),
    ({"small_box_count": 4, "medium_box_count": 4, "big_box_count": 3}, False),
    ({"document_count": 100, "small_box_count": 10}, True),
    ({"small_box_count": -1}, False), ({"document_count": -1}, False),
    ({"item_price": 1.5}, False), ({"small_box_count": True}, False),
])
def test_input_boundaries_are_enforced_by_executor(args, accepted):
    c = ctx()
    c.state.record("item_price", 1000)
    c.state.record("items", Items(small_box_count=1))
    out = call(c, "record_fields", args)
    assert (out["status"] == "ok") == accepted
    if not accepted:
        assert out["code"] == "TOOL_ARGS_INVALID" and out["needs"]
        assert c.state.field_of("item_price").value == 1000
        assert c.state.field_of("items").value == Items(small_box_count=1)
    elif "item_price" in args:
        assert c.state.field_of("item_price").value == args["item_price"]
    else:
        assert c.state.field_of("items").value == Items(**args)


def test_toml_change_reaches_prompts_session_schema_and_executor(tmp_path):
    # 기존 숫자를 다른 값으로 바꿔도 코드에 남은 예전 상한·캐시를 쓰지 않아야 한다.
    text = (ROOT / "policy/workflow.toml").read_text(encoding="utf-8")
    replacements = {"item_price_min = 1": "item_price_min = 2",
                    "item_price_max = 99_999_999": "item_price_max = 123_456",
                    "box_total_max = 10": "box_total_max = 7", "document_max = 100": "document_max = 80",
                    "min_lead_minutes = 60": "min_lead_minutes = 90",
                    "max_days_ahead = 3": "max_days_ahead = 2",
                    "mobile_digits = 11": "mobile_digits = 12"}
    for old, new in replacements.items():
        assert old in text
        text = text.replace(old, new)
    path = tmp_path / "workflow.toml"
    path.write_text(text, encoding="utf-8")
    p = load_policy(path)
    for rendered in (render_live("test", p), render_backend(p)):
        assert "2원~123,456원" in rendered
        assert "최대 7개" in rendered and "최대 80개" in rendered
        assert "90분 이후" in rendered and "2일(48시간)" in rendered
        assert "정확히 12자리" in rendered
        assert "99,999,999" not in rendered and "{pickup_allowed}" not in rendered

    svc = service()
    svc.d.policy = p
    from app.calls.session import CallSession
    c = ctx()
    c.policy = p
    s = CallSession("policy", "policy", "01012345678", "2026-11-03T01:00:00Z", c)
    config = svc.session_config(s, None)
    spec = next(t for t in config["delegation"]["responses"]["tools"] if t["name"] == "record_fields")
    props = spec["parameters"]["properties"]
    integer = lambda name: next(v for v in props[name]["anyOf"] if v["type"] == "integer")
    assert integer("item_price")["minimum"] == 2
    assert integer("item_price")["maximum"] == 123_456
    assert integer("small_box_count")["maximum"] == 7
    assert integer("document_count")["maximum"] == 80
    assert "123,456원" in config["instructions"]
    assert "123,456원" in config["delegation"]["responses"]["instructions"]
    assert call(c, "record_fields", {"item_price": 1})["code"] == "TOOL_ARGS_INVALID"
    assert call(c, "record_fields", {"item_price": 123_456, "document_count": 80,
                                      "small_box_count": 3, "big_box_count": 4})["status"] == "ok"
    assert call(c, "record_fields", {"small_box_count": 4, "big_box_count": 4})["code"] == "TOOL_ARGS_INVALID"
    assert call(c, "record_fields", {"document_count": 81})["code"] == "TOOL_ARGS_INVALID"
    assert call(c, "record_fields", {"receiver_phone": "01012345678"})["code"] == "PHONE_INVALID_DIGITS"
    assert call(c, "record_fields", {"receiver_phone": "010123456789"})["status"] == "ok"
    rule = rule_of(p.pickup)
    assert check_pickup((NOW + timedelta(minutes=89)).isoformat(), NOW, rule) == "PICKUP_TOO_SOON"
    assert check_pickup((NOW + timedelta(days=2, seconds=1)).isoformat(), NOW, rule) == "PICKUP_TOO_FAR"
    # 다른 정책의 스키마가 기본 정책으로 새지 않아야 한다.
    default_spec = next(t for t in function_specs() if t["name"] == "record_fields")
    default_price = default_spec["parameters"]["properties"]["item_price"]["anyOf"][0]
    assert default_price["maximum"] == 99_999_999


@pytest.mark.parametrize("lead, code", [(timedelta(minutes=59, seconds=59), "PICKUP_TOO_SOON"),
                                        (timedelta(hours=1), None), (timedelta(days=3), None),
                                        (timedelta(days=3, seconds=1), "PICKUP_TOO_FAR")])
def test_pickup_window_is_inclusive_and_measured_from_now(lead, code):
    rule = rule_of(load_policy().pickup)
    assert check_pickup((NOW + lead).isoformat(), NOW, rule) == code


@pytest.mark.parametrize("hour, second, microsecond", [(10, 30, 0), (10, 0, 1), (16, 30, 0)])
def test_default_pickup_never_rounds_below_minimum(hour, second, microsecond):
    rule = rule_of(load_policy().pickup)
    now = NOW.replace(hour=hour, second=second, microsecond=microsecond)
    at, _ = default_pickup(now, rule)
    assert datetime.fromisoformat(at) >= now + timedelta(minutes=rule.min_lead_minutes)
    assert check_pickup(at, now, rule) is None


@pytest.mark.parametrize("section, change", [
    ("input_limits", {"item_price_min": 100_000_000}),
    ("input_limits", {"box_total_max": 0}),
    ("pickup", {"open": "18:00"}), ("pickup", {"close": "25:00"}),
    ("pickup", {"min_lead_minutes": 5000}),
    ("phone", {"domestic_min_digits": 12}),
])
def test_inconsistent_limit_config_is_rejected(section, change):
    data = load_policy().model_dump()
    data[section].update(change)
    with pytest.raises(ValidationError):
        Policy.model_validate(data)


def test_phone_existing_formats_and_rendered_pickup_range_agree():
    p = load_policy()
    for raw, expected in [("+82 10 1234 5678", "01012345678"), ("02-123-4567", "021234567"),
                          ("1588-1234", "15881234"), ("0101234567", None)]:
        assert normalize_phone(raw, p.phone) == expected
    assert describe(rule_of(p.pickup)) in render_live("test", p)
    assert describe(rule_of(p.pickup)) in render_backend(p)
