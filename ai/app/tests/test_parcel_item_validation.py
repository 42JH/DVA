"""FAQ의 물품 제한이 실제 기록·확인·제출 경로에 적용되는지 확인한다."""

import pytest

from app.domain.confirm import commit_parcel, issue_parcel_confirmation
from app.domain.outcome import decide_outcome
from app.domain.state import Items
from app.domain.store import hold_unclassified_items, open_for_edit
from app.tests.test_domain import NOW, P, confirm_once, fare, filled
from app.tests.test_tools import call, ctx


def record(c, text, rule=None, status="included", turn=1, **fields):
    c.item_utterance = (turn, text)
    if rule:
        fields["item_evidence"] = [{"rule": rule, "quote": text, "status": status}]
    return call(c, "record_fields", fields)


@pytest.mark.parametrize(("rule", "item"), [
    ("cash_equivalents", "수표"), ("dangerous_goods", "농약"), ("animals", "동물 사체"),
    ("valuables", "귀금속"), ("flammables", "부탄가스"), ("perishables", "냉동식품"),
    ("restricted_goods", "처방약"),
])
def test_faq_prohibited_categories_block_even_when_box_is_valid(rule, item):
    c = ctx()
    c.state = filled()
    pending = issue_parcel_confirmation(c.state, P, 100)
    result = record(c, f"소형 박스에 {item}을 넣었어요", rule, small_box_count=1)
    assert result["code"] == "PROHIBITED_ITEM" and not result["can_proceed"]
    assert commit_parcel(c.state, P, pending.id) is None
    outcome = decide_outcome(c.state, P, NOW, fare)
    assert outcome.kind == "INCOMPLETE" and not outcome.parcels


@pytest.mark.parametrize(("rule", "first", "answer"), [
    ("batteries", "배터리가 들어 있어요", "기기에 장착했어요"),
    ("liquids", "음료가 들어 있어요", "누수 방지 포장을 했어요"),
    ("fragile", "유리컵이 들어 있어요", "완충 포장했어요"),
])
def test_only_explicit_condition_answer_releases_conditional_item(rule, first, answer):
    c = ctx()
    c.state = filled()
    assert record(c, first, rule)["code"] == "NEEDS_CONDITION"
    assert record(c, "아직 안 했어요", rule, "condition_unmet", turn=2)["code"] == "CONDITION_UNMET"
    assert record(c, "소형 박스 하나요", turn=3, small_box_count=1)["code"] == "CONDITION_UNMET"
    assert record(c, answer, rule, "condition_met", turn=4)["can_proceed"]
    confirm_once(c.state)
    assert decide_outcome(c.state, P, NOW, fare).kind == "COMPLETE"


def test_format_changes_and_numeric_faq_limits():
    c = ctx()
    c.state = filled()
    assert record(c, "쇼핑백 그대로예요", "format")["code"] == "UNSUPPORTED_FORMAT"
    assert record(c, "중형 박스 하나에 담았어요", turn=2, medium_box_count=1)["can_proceed"]
    assert c.state.current["items"].value == Items(medium_box_count=1)
    assert record(c, "가로 161cm에 무게 30kg이에요", turn=3, medium_box_count=1)["code"] == "ITEM_SIZE_EXCEEDED"
    c.item_utterance = (4, "한 변 160cm, 무게 30kg이에요")
    assert call(c, "record_fields", {"item_evidence": [
        {"rule": "size", "status": "included", "quote": c.item_utterance[1], "side_cm": 160, "weight_kg": 30},
    ]})["can_proceed"]
    assert record(c, "무게 31kg이에요", turn=5, medium_box_count=1)["code"] == "ITEM_SIZE_EXCEEDED"


def test_weight_correction_does_not_clear_oversized_side():
    c = ctx()
    c.state = filled()
    assert record(c, "한 변 170cm에 무게 35kg이에요", medium_box_count=1)["code"] == "ITEM_SIZE_EXCEEDED"
    out = record(c, "무게는 20kg이에요", "size", turn=2)
    assert out["code"] == "ITEM_SIZE_EXCEEDED"
    assert list(c.state.current.item_issues) == ["side_cm"]


def test_raw_turn_catches_missing_evidence_after_confirmation_and_requires_reconfirmation():
    c = ctx()
    c.state = filled()
    parcel_id = confirm_once(c.state)
    review = hold_unclassified_items(c.state, P.parcel_items, 1, "아까 박스에 폭죽도 있어요")
    assert review["code"] == "ITEM_MENTION_UNCLEAR"
    open_for_edit(c.state, parcel_id)  # 뒤이어 들어온 수정 의도가 차단 상태를 지우면 안 된다
    assert record(c, "아까 박스에 폭죽도 있어요", small_box_count=1)["code"] == "ITEM_MENTION_UNCLEAR"
    assert not decide_outcome(c.state, P, NOW, fare).parcels
    assert record(c, "폭죽은 빼고 보내요", "dangerous_goods", "removed", turn=2)["can_proceed"]
    assert c.state.parcels[0].confirmed_snapshot is None
    assert decide_outcome(c.state, P, NOW, fare).kind == "INCOMPLETE"
    confirm_once(c.state)
    assert decide_outcome(c.state, P, NOW, fare).kind == "COMPLETE"


def test_inquiry_and_removal_do_not_block_but_mixed_prohibited_items_do():
    c = ctx()
    c.state = filled()
    assert not hold_unclassified_items(c.state, P.parcel_items, 1, "현금도 보낼 수 있나요?")
    assert not hold_unclassified_items(c.state, P.parcel_items, 1, "현금으로 결제되나요?")
    assert record(c, "현금은 빼고 옷만 보내요", "cash_equivalents", "removed", turn=2, small_box_count=1)["can_proceed"]
    c.item_utterance = (3, "수표는 뺐고 현금은 넣었어요")
    result = call(c, "record_fields", {"small_box_count": 1, "item_evidence": [
        {"rule": "cash_equivalents", "status": "included", "quote": "현금은 넣었어요"},
        {"rule": "cash_equivalents", "status": "removed", "quote": "수표는 뺐고"},
    ]})
    assert result["code"] == "PROHIBITED_ITEM"
    assert record(c, "현금은 빼고 옷만 보내요", "cash_equivalents", "removed", turn=2)["code"] == "RESULT_SUPERSEDED"


def test_unclear_parcel_holds_submission_until_target_is_identified_and_omitted():
    c = ctx()
    c.state = filled()
    first = confirm_once(c.state)
    c.state.current = filled(receiver="박영수").current
    second = confirm_once(c.state)
    assert hold_unclassified_items(c.state, P.parcel_items, 1, "박스에 수표가 들어 있어요")["code"] == "ITEM_PARCEL_UNCLEAR"
    assert not decide_outcome(c.state, P, NOW, fare).parcels
    open_for_edit(c.state, second)
    outcome = decide_outcome(c.state, P, NOW, fare)
    assert outcome.kind == "INCOMPLETE" and len(outcome.parcels) == 1
    assert record(c, "두 번째 택배는 빼 주세요", turn=2,
                  omit_blocked_parcel="두 번째 택배는 빼 주세요")["facts"]["blocked_parcel_omitted"]
    assert [parcel.parcel_id for parcel in c.state.parcels] == [first]
    assert decide_outcome(c.state, P, NOW, fare).kind == "COMPLETE"
