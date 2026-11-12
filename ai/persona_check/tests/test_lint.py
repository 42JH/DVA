"""페르소나 글 검사: 모델 답 거르기(check) · 정답 표본 읽기. 실제 OpenAI는 부르지 않는다."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from persona_check import lint

PERSONA = """# 페르소나

## 역할
당신은 상담사 '디바'입니다.
보내는 분 성함부터 묻습니다.

## 발화 스타일
### 속도
- 매우 빠르게 말합니다.
- 모든 문장을 느리게 말합니다.

## 맞장구
- 날씨를 물으면   짧게 답해 줍니다.
"""
RULES = "## 무관한 요청\n- 택배 업무와 무관한 질문에는 일부라도 답하거나 추천하지 않고, 상담 범위를 짧게 안내합니다."


def finding(kind, quote, other="", why="사유"):
    return {"kind": kind, "quote": quote, "other": other, "why": why}


class FakeClient:
    def __init__(self, reply):
        self.reply, self.sent = reply, None
        self.responses = SimpleNamespace(create=self.create)

    async def create(self, **kwargs):
        self.sent = kwargs
        return SimpleNamespace(output_text=self.reply)


def test_check_keeps_only_verbatim_quotes_and_names_the_section():
    raw = {"findings": [
        finding("BUSINESS", "보내는 분 성함부터 묻습니다.", other="버려질 글"),
        finding("BUSINESS", "받는 분 주소부터 묻습니다."),                      # 원문에 없는 인용
        finding("RULE_CONFLICT", "날씨를 물으면 짧게 답해 줍니다.", "일부라도 답하거나 추천하지 않고"),  # 원문은 공백 여러 칸
        finding("RULE_CONFLICT", "당신은 상담사 '디바'입니다.", "AI임을 숨기지 않습니다"),  # 규칙에 없는 구절
        finding("SELF_CONFLICT", "매우 빠르게 말합니다.", "모든 문장을 느리게 말합니다."),
        finding("SELF_CONFLICT", "모든 문장을 느리게 말합니다.", "매우 빠르게 말합니다."),  # 같은 모순의 반대 방향
        finding("SELF_CONFLICT", "매우 빠르게 말합니다.", "매우 빠르게 말합니다."),      # 자기 자신
        finding("STYLE", "당신은 상담사 '디바'입니다."),                         # 없는 종류
        finding("BUSINESS", "디바"),                                          # 너무 짧은 인용
        "글자",
    ]}
    got = lint.check(raw, PERSONA, RULES)
    assert [(f["kind"], f["section"], f["other"]) for f in got] == [
        ("BUSINESS", "역할", ""),
        ("RULE_CONFLICT", "맞장구", "일부라도 답하거나 추천하지 않고"),
        ("SELF_CONFLICT", "속도", "모든 문장을 느리게 말합니다."),
    ]
    assert lint.check({"findings": None}, PERSONA, RULES) == lint.check("글자", PERSONA, RULES) == []


def test_lint_sends_rules_then_persona_and_tells_failure_from_clean():
    client = FakeClient(json.dumps({"findings": [finding("BUSINESS", "보내는 분 성함부터 묻습니다.")]}))
    got = asyncio.run(lint.lint(client, PERSONA, RULES))
    assert [f["quote"] for f in got] == ["보내는 분 성함부터 묻습니다."]
    assert client.sent["input"].index("[업무 규칙]") < client.sent["input"].index("[페르소나]")
    assert asyncio.run(lint.lint(FakeClient('{"findings": []}'), PERSONA, RULES)) == []
    assert asyncio.run(lint.lint(FakeClient("깨진 답"), PERSONA, RULES)) is None


def test_prompt_and_rules_file_match_the_code():
    prompt = lint.PROMPT.read_text("utf-8")
    assert all(f"`{k}`" in prompt for k in lint.KINDS)
    assert "페르소나보다 우선" in lint.RULES.read_text("utf-8")  # 실시간 서버가 쓰는 그 규칙 파일


def test_samples_carry_valid_answers():
    paths = sorted(Path(lint.__file__).with_name("samples").glob("*.md"))
    wants = {p.name: lint.split_expect(p.read_text("utf-8")) for p in paths}
    assert len(paths) >= 6 and all(want is not None and "expect" not in text for want, text in wants.values())
    assert wants["good_default.md"][0] == set() and wants["bad_self.md"][0] == {"SELF_CONFLICT"}
    assert lint.split_expect("# 그냥 글") == (None, "# 그냥 글")
    with pytest.raises(ValueError):
        lint.split_expect("<!-- expect: BUISNESS -->\n글")


def test_verdict():
    hit = [{"kind": "BUSINESS"}, {"kind": "RULE_CONFLICT"}]
    assert lint.verdict({"BUSINESS"}, hit) == "OK" and lint.verdict({"SELF_CONFLICT"}, hit) == "MISS"
    assert lint.verdict(set(), []) == "OK" and lint.verdict(set(), hit) == "MISS"
    assert lint.verdict(None, hit) == "" and lint.verdict({"BUSINESS"}, None) == "오류"
