"""정책 → 지시문·판정·Decision 질문의 일관성(overview.md §5 S2 완료 기준)."""

import tomllib

import pytest
from pydantic import ValidationError

from app.domain.assess import assess
from app.domain.state import ConversationState
from app.policy.model import ROOT, Policy, load_policy
from app.policy.render import business_rules, decision_questions, default_persona, render_backend, render_live

POLICY = load_policy()


def raw() -> dict:
    with (ROOT / "policy" / "workflow.toml").open("rb") as f:
        return tomllib.load(f)


def test_receive_order_matches_call_flow_rule():
    """README '반드시 지킬 것' 1: 보내는 분 성함 → 주소 → 상세 → 받는 분 성함 → 연락처 → 주소 → 상세 → 물품 → 가액 → 수거 일시."""
    order = [n for s in POLICY.collect_stages() for n in s.required]
    # 수거 일시는 묻지 않는다(사용자 결정 2026-11-03, BE가 결제 완료 + 1시간으로 정함)
    assert order == ["sender_name", "sender_address", "sender_address_detail", "receiver_name", "receiver_phone",
                     "receiver_address", "receiver_address_detail", "items", "item_price"]
    assert POLICY.fields["sender_phone"].kind == "auto" and "sender_phone" not in order  # 발신번호, 묻지 않음


def test_live_instructions_carry_policy_order_forbid_and_delegation():
    text = render_live(None, POLICY)
    labels = [POLICY.fields[n].label for s in POLICY.collect_stages() for n in s.required]
    procedure = text[text.index("## 택배 정보 받는 순서"):]
    positions = [procedure.index(label) for label in labels]
    assert positions == sorted(positions)  # 지시문 속 순서 = 서버 판정 순서
    assert all(item in text for item in POLICY.forbid.items)
    delegate = text.split("Generate <|SpawnThinking|> when:")[1].split("Do not generate")[0]
    assert all(POLICY.fields[n].label in delegate for n in POLICY.free_fields())  # 자유형은 전부 위임 규칙에(S0 U7)
    assert "payment" not in POLICY.fields and "결제 방식" not in procedure.split("## 하지 않는 것")[0]  # 결제는 묻지 않는다
    assert "수거 시각은 먼저 묻지 않는다" in text and text.startswith(default_persona()[:20])


def test_persona_first_then_fixed_business_rules_and_fallback_on_blank():
    text = render_live("페르소나 지시문", POLICY, {"고객 성함": "김철수"})
    assert text.startswith("페르소나 지시문")
    rules = business_rules()
    assert rules in text and text.index(rules) < text.index("# 상담 절차")  # 페르소나 → 업무 규칙 → 절차 → 통화 정보
    assert "페르소나보다 우선" in rules and "페르소나 지시를 따르되" not in text  # 업무 규칙이 우선(예전 문장 없음)
    assert text.rstrip().endswith("- 고객 성함: 김철수")
    for blank in (None, "", "   "):  # P2: 페르소나 없음 → 기본 페르소나, 업무 규칙은 그대로
        out = render_live(blank, POLICY)
        assert out.startswith(default_persona()) and rules in out


def test_business_rules_explain_every_server_result_key_they_mention():
    """규칙 파일이 서버 결과 신호(call_started·closing·agent suggest·phones_to_read)를 쓰는 대로 설명한다."""
    rules = business_rules()
    for key in ("call_started", "closing", "phones_to_read", "suggest", "missing"):
        assert key in rules
    assert all(k in POLICY.results for k in ("call_started", "closing", "agent"))


def test_backend_instructions_list_free_fields_and_no_choice_judgment():
    text = render_backend(POLICY)
    assert all(f"({n})" in text for n in POLICY.free_fields())
    assert "예/아니요" in text and "하지 않습니다" in text and "{fields}" not in text
    assert "그 부분만 바꾼 전체 번호" in text  # 번호 부분 정정(업무 규칙 d)
    assert "들은 그대로 기록" in text and "312동 403호" in text  # 주소 기록 규칙(기존 서버 backend.md에서 옮김)


def test_server_missing_uses_same_order_as_instructions():
    state = ConversationState(intent="order")
    a = assess(state, POLICY)
    assert list(a.missing) == [n for s in POLICY.collect_stages() for n in s.required]


@pytest.mark.parametrize("stage, pending, expected", [
    ("intent", False, ["task"]), ("receiver", False, ["switch"]), ("readback", True, ["confirm"]),
    ("readback", False, []), ("more_parcels", True, ["confirm", "more", "switch"]),
    ("closing", False, ["switch"]),
])
def test_decision_questions_per_stage(stage, pending, expected):
    qs = decision_questions(POLICY, stage, pending=pending)
    assert [q["name"] for q in qs] == expected
    assert all(q["type"] in ("choice", "predicate", "score") for q in qs)  # 자유형 추출 질문 없음(D1)
    assert all(2 <= len(q["choices"]) <= 255 for q in qs if q["type"] == "choice")


def test_pick_question_is_built_from_candidate_labels():
    qs = decision_questions(POLICY, "receiver", pick_labels=("집", "회사"))
    assert [c["value"] for c in qs[-1]["choices"]] == ["집", "회사", "none", "not_answer"]


@pytest.mark.parametrize("breakage, message", [
    (lambda d: d["stage"][1].update(required=["unknown_field"]), "모르는 필드"),
    (lambda d: d["stage"][2]["required"].append("sender_name"), "두 단계"),
    (lambda d: next(s for s in d["stage"] if s["id"] == "readback").update(required=["items"]), "gate"),
    (lambda d: d["decision"].pop("collect"), "질문 세트"),
    (lambda d: d["decision"]["intent"]["questions"][0].update(choices=["only"]), "선택지"),
    (lambda d: d["decision"]["intent"]["questions"][0].update(type="text"), "type"),
])
def test_invalid_policy_is_rejected(breakage, message):
    d = raw()
    breakage(d)
    with pytest.raises(ValidationError, match=message):
        Policy.model_validate(d)

