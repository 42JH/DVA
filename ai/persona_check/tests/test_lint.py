"""페르소나 글 검사(persona_check.lint): 모델을 부르지 않는 순수 함수(정답 줄 읽기 · 판정 · 모델 답 거르기)를 확인한다."""

import pytest

from persona_check.lint import check, split_expect, verdict

PERSONA = "# 성격\n차분하고 친절하게 말한다.\n# 속도\n천천히 또박또박 말한다. 빠르게 말한다.\n"
RULES = "주소는 반드시 끝까지 다시 확인한다."


def test_split_expect_reads_first_line():
    """첫 줄 정답 → 종류 집합과 본문. none은 빈 집합, 정답 줄이 없거나 맨 앞이 아니면 None."""
    assert split_expect("<!-- expect: BUSINESS, RULE_CONFLICT -->\n# 본문") == ({"BUSINESS", "RULE_CONFLICT"}, "# 본문")
    assert split_expect("<!--expect:none-->\n본문") == (set(), "본문")
    assert split_expect("본문만") == (None, "본문만")
    assert split_expect("\n<!-- expect: BUSINESS -->\n본문")[0] is None  # 첫 줄이 아니면 정답 아님
    with pytest.raises(ValueError):
        split_expect("<!-- expect: BUSINES -->\n본문")  # 오타 난 종류


def test_verdict():
    """정답 종류가 모두 나오면 OK(더 나와도 OK), none은 아무것도 없어야 OK, 호출 실패는 정답과 상관없이 오류."""
    found = [{"kind": "BUSINESS"}, {"kind": "SELF_CONFLICT"}]
    assert verdict({"BUSINESS"}, found) == "OK"
    assert verdict({"BUSINESS", "RULE_CONFLICT"}, found) == "MISS"
    assert verdict(set(), []) == "OK"
    assert verdict(set(), found) == "MISS"
    assert verdict(None, found) == ""  # 정답 없는 글
    assert verdict(None, None) == "오류"
    assert verdict(set(), None) == "오류"  # 실패를 '문제 없음'으로 보지 않음


def f(kind, quote, other="", why="이유"):
    return {"kind": kind, "quote": quote, "other": other, "why": why}


def test_check_keeps_only_grounded_findings():
    """원문에 글자 그대로 있는 인용만 남기고, 모순은 A↔B를 한 번만 센다."""
    raw = {"findings": [
        f("BUSINESS", "차분하고  친절하게", other="버려질 값", why="가" * 300),  # 공백 차이는 무시
        f("BUSINESS", "지어낸 구절입니다"),  # 원문에 없음
        f("BUSINESS", "말한"),  # 너무 짧음
        f("TONE", "천천히 또박또박"),  # 모르는 종류
        f("RULE_CONFLICT", "천천히 또박또박", other="주소는 반드시 끝까지"),
        f("RULE_CONFLICT", "천천히 또박또박", other="규칙에 없는 구절"),
        f("SELF_CONFLICT", "천천히 또박또박", other="빠르게 말한다"),
        f("SELF_CONFLICT", "빠르게 말한다", other="천천히 또박또박"),  # 위와 같은 모순
        f("SELF_CONFLICT", "빠르게 말한다", other="빠르게 말한다"),  # 자기 자신
        "문자열",
    ]}
    out = check(raw, PERSONA, RULES)
    assert [(x["kind"], x["section"], x["quote"], x["other"]) for x in out] == [
        ("BUSINESS", "성격", "차분하고 친절하게", ""),
        ("RULE_CONFLICT", "속도", "천천히 또박또박", "주소는 반드시 끝까지"),
        ("SELF_CONFLICT", "속도", "천천히 또박또박", "빠르게 말한다"),
    ]
    assert len(out[0]["why"]) == 200
    assert check({"findings": None}, PERSONA, RULES) == []
    assert check("깨진 답", PERSONA, RULES) == []
