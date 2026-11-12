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


def test_direct_box_count_wins_and_restricted_items_cannot_be_suggested():
    c = ctx()
    c.state = filled()
    c.state.clear("items")
    suggestion = {"size": "small", "count": 1, "quote": "신발"}
    result = record(c, "신발을 중형 박스 하나에 담아요", medium_box_count=1, box_suggestion=suggestion)
    assert c.state.current["items"].value == Items(medium_box_count=1)
    assert "box_proposal" not in result["facts"] and c.state.current.box_proposal is None

    c.state.clear("items")
    result = record(c, "신발과 수표를 보내요", "cash_equivalents", turn=2, box_suggestion=suggestion)
    assert result["code"] == "PROHIBITED_ITEM" and c.state.current.box_proposal is None


@pytest.mark.parametrize("quote", ["미니 냉장고", "냉장", "미니 냉장고 하나 보내려고요"])
def test_appliance_is_not_classified_as_refrigerated_food(quote):
    c = ctx()
    c.state = filled()
    c.state.clear("items")
    text = "미니 냉장고 하나 보내려고요"
    assert not hold_unclassified_items(c.state, P.parcel_items, 1, text)
    out = record(c, text, big_box_count=1, item_evidence=[{
        "rule": "perishables", "quote": quote, "status": "included",
    }])
    assert out["status"] == "ok" and c.state.current["items"].value == Items(big_box_count=1)

    assert record(c, "미니 냉장고와 냉동식품을 보낼게요", "perishables", turn=2)["code"] == "PROHIBITED_ITEM"
    out = record(c, "미니 냉장고 한 변 170cm예요", "size", turn=3)
    assert any(need["reason"] == "ITEM_SIZE_EXCEEDED" for need in out["needs"])


def test_contextual_evidence_clears_only_the_matching_keyword_mention():
    c = ctx()
    c.state = filled()
    c.state.clear("items")
    evidence = [{"rule": "cash_equivalents", "quote": "현금 영수증", "status": "not_applicable"}]
    text = "현금 영수증을 보내려고요"
    review = hold_unclassified_items(c.state, P.parcel_items, 1, text)
    assert review["code"] == "ITEM_MENTION_UNCLEAR"
    assert "접수할 수 없" not in review["guidance"][0]
    assert record(c, text, document_count=1, item_evidence=evidence)["status"] == "ok"
    assert not c.state.current.item_issues

    assert record(c, "보조배터리 파우치", "batteries", "not_applicable", turn=2)["status"] == "ok"

    out = record(c, "현금과 현금 영수증을 같이 보낼게요", turn=3, item_evidence=evidence)
    assert out["code"] == "ITEM_MENTION_UNCLEAR"
    assert record(c, "현금과 현금 영수증", "cash_equivalents", "not_applicable", turn=4)["code"] == "ITEM_MENTION_UNCLEAR"
    assert record(c, text, turn=5, item_evidence=evidence)["code"] == "ITEM_MENTION_UNCLEAR"
    assert record(c, "현금", "cash_equivalents", "not_applicable", turn=6)["code"] == "ITEM_MENTION_UNCLEAR"


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


def test_watch_denial_does_not_block_readback_after_price():
    c = ctx()
    c.state = filled()
    c.state.clear("items")
    c.state.clear("item_price")
    result = record(c, "시계 하나 보내려고요", "valuables", "inquiry",
                    box_suggestion={"size": "small", "count": 1, "quote": "시계 하나"})
    assert "box_proposal" in result["facts"]
    record(c, "네, 맞습니다", turn=2, small_box_count=1)
    result = record(c, "아닙니다", "valuables", "condition_unmet", turn=3)
    assert result["missing"] == ["item_price"] and not c.state.current.item_issues

    result = record(c, "이십만 원이요", turn=4, item_price=200000)
    assert result["status"] == "ok" and "readback" in result["facts"]

    result = record(c, "보석 시계예요", "valuables", turn=5)
    assert result["code"] == "PROHIBITED_ITEM" and "readback" not in result.get("facts", {})
    summary = call(c, "get_state", {})
    assert summary["item_review"]["code"] == "PROHIBITED_ITEM"
    assert "next_field" not in summary and not summary["can_proceed"]
    result = record(c, "삼십만 원이요", turn=6, item_price=300000)
    assert result["item_review"]["code"] == "PROHIBITED_ITEM"
    assert "readback" not in result.get("facts", {})


@pytest.mark.parametrize(("rule", "item"), [("valuables", "보석"), ("dangerous_goods", "농약"), ("perishables", "냉동식품")])
def test_short_denial_cannot_be_recorded_as_prohibited_item(rule, item):
    c = ctx()
    c.state = filled()
    result = record(c, "아, 아닙니다.", rule, "included")
    assert result["can_proceed"] and not c.state.current.item_issues

    result = record(c, f"아닙니다. {item}은 같이 넣었어요.", rule, "included", turn=2)
    assert result["code"] == "PROHIBITED_ITEM" and not result["can_proceed"]


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
    assert record(c, "중형 박스 하나에 담았어요", turn=2, medium_box_count=1, small_box_count=0)["can_proceed"]
    assert c.state.current["items"].value == Items(medium_box_count=1)
    assert record(c, "가로 161cm에 무게 30kg이에요", turn=3, medium_box_count=1)["code"] == "ITEM_SIZE_EXCEEDED"
    c.item_utterance = (4, "한 변 160cm, 무게 30kg이에요")
    assert call(c, "record_fields", {"item_evidence": [
        {"rule": "size", "status": "included", "quote": c.item_utterance[1], "side_cm": 160, "weight_kg": 30},
    ]})["can_proceed"]
    assert record(c, "무게 31kg이에요", turn=5, medium_box_count=1)["code"] == "ITEM_SIZE_EXCEEDED"


def test_box_correction_clears_only_the_packing_issue():
    c = ctx()
    c.state = filled()
    c.state.clear("items")
    assert record(c, "냉장고 하나 보낼게요", "format")["code"] == "ITEM_UNSPECIFIED"
    assert record(c, "쇼핑백 그대로예요", "format", turn=2)["code"] == "UNSUPPORTED_FORMAT"
    assert record(c, "접수 규격에 맞습니다", "format", "condition_met", turn=3)["code"] == "UNSUPPORTED_FORMAT"
    assert record(c, "대형 박스에 안 들어가요", "format", "condition_met", turn=4)["code"] == "UNSUPPORTED_FORMAT"
    out = record(c, "대형 박스에 담고 다른 물건은 쇼핑백에 담아요", turn=5, big_box_count=1,
                 item_evidence=[{"rule": "format", "quote": "대형 박스에 담고", "status": "condition_met"}])
    assert out["code"] == "UNSUPPORTED_FORMAT" and "format" in c.state.current.item_issues
    record(c, "무게 31kg에 현금도 넣었어요", "cash_equivalents", turn=6)
    out = record(c, "대형이요", "format", "condition_met", turn=7, big_box_count=1)
    assert {need["reason"] for need in out["needs"]} == {"ITEM_SIZE_EXCEEDED", "PROHIBITED_ITEM"}
    assert "format" not in c.state.current.item_issues


def test_explicit_packing_correction_allows_a_new_box_candidate():
    c = ctx()
    c.state = filled()
    c.state.clear("items")
    record(c, "쇼핑백으로 보낼게요", "format")
    out = record(c, "쇼핑백 대신 박스로 포장할게요. 신발 한 켤레예요", turn=2,
                 item_evidence=[{"rule": "format", "quote": "쇼핑백 대신", "status": "removed"},
                                {"rule": "format", "quote": "박스로 포장할게요", "status": "condition_met"}],
                 box_suggestion={"size": "small", "count": 1, "quote": "신발 한 켤레"})
    assert out["facts"]["box_proposal"]["label"] == "소형 박스 1개"
    assert not c.state.current.item_issues and not c.state.current["items"].valid


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
    text = "현금 영수증도 보낼게요"
    hold_unclassified_items(c.state, P.parcel_items, 2, text)
    record(c, text, turn=2, item_evidence=[{
        "rule": "cash_equivalents", "quote": "현금 영수증", "status": "not_applicable",
    }])
    assert c.state.unassigned_item_issues["cash_equivalents"].utterance_id == 1
    assert not decide_outcome(c.state, P, NOW, fare).parcels
    open_for_edit(c.state, second)
    outcome = decide_outcome(c.state, P, NOW, fare)
    assert outcome.kind == "INCOMPLETE" and len(outcome.parcels) == 1
    assert record(c, "두 번째 택배는 빼 주세요", turn=3,
                  omit_blocked_parcel="두 번째 택배는 빼 주세요")["facts"]["blocked_parcel_omitted"]
    assert [parcel.parcel_id for parcel in c.state.parcels] == [first]
    assert decide_outcome(c.state, P, NOW, fare).kind == "COMPLETE"
