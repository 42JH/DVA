"""페르소나 글 검사 (저장 전, 통화 없음): 관리자가 쓴 말투 글에서 문제 되는 구절을 찾는다.

    BUSINESS       말투가 아닌 업무 지시(순서 · 확인 · 고정 문구 · 서버 결과 언급) — 11/04 운영 통화처럼 질문 순서를 흐린다
    RULE_CONFLICT  업무 규칙(policy/business_rules.md)과 반대
    SELF_CONFLICT  페르소나 안의 두 구절이 서로 모순

실시간 상담 경로(app/)와 따로 돈다. app을 import하지 않고 업무 규칙 파일만 읽는다. 표준 라이브러리와 OpenAI SDK만 쓴다.
모델 결과는 미신뢰 입력이라 check()가 원문에 글자 그대로 있는 인용만 남긴다(지어낸 인용 · 규칙은 버림).

    # ai/ 폴더에서. 키는 실시간 상담과 다른 것(PERSONA_CHECK_OPENAI_API_KEY)
    python -m persona_check.lint 페르소나.md [...]
    python -m persona_check.lint persona_check/samples/*.md     # 정답 붙은 표본 — 검사 글을 고칠 때마다 이 줄로 확인

표본 파일 첫 줄 `<!-- expect: BUSINESS, RULE_CONFLICT -->`(또는 none)는 정답이다. 정답 종류가 모두 나오면 OK, none은 아무것도 안 나와야 OK.
"""

import asyncio
import json
import logging
import os
import re
import sys
from pathlib import Path

import openai

log = logging.getLogger(__name__)

MODEL = "gpt-6-luna"  # call_analysis와 같은 모델
EFFORT = "medium"
TIMEOUT_SEC = 120.0
MAX_WHY, MIN_QUOTE = 200, 4  # 너무 짧은 인용("네")은 어디에나 있어 근거가 못 됨
KINDS = ("BUSINESS", "RULE_CONFLICT", "SELF_CONFLICT")
PROMPT = Path(__file__).with_name("lint.md")
# ponytail: 업무 규칙 글만 본다. 받는 순서(policy/workflow.toml)와의 충돌은 BUSINESS로 잡히므로 따로 넣지 않음
# — 놓치는 게 보이면 render_policy 결과를 더한다
RULES = Path(__file__).parents[1] / "policy" / "business_rules.md"
EXPECT = re.compile(r"\A<!--\s*expect:\s*(.*?)\s*-->\s*")
HEADING = re.compile(r"^#+\s*(.+?)\s*$")

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["findings"], "properties": {
    "findings": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["kind", "quote", "other", "why"],
        "properties": {"kind": {"type": "string", "enum": list(KINDS)}, "quote": {"type": "string"},
                       "other": {"type": "string"}, "why": {"type": "string"}}}}}}


def _flat(text) -> str:
    return " ".join(str(text or "").split())


def sections(persona: str) -> list[tuple[str, str]]:
    """제목 줄(#) 기준으로 나눈 (제목, 본문). BE가 합친 글이면 제목이 화면 칸 이름이다(역할 · 성격 · 톤 · 속도 · 맞장구 · 끼어들기)."""
    out, title, body = [], "", []
    for line in persona.splitlines():
        m = HEADING.match(line)
        if m:
            out.append((title, _flat(" ".join(body))))
            title, body = m.group(1), []
        else:
            body.append(line)
    out.append((title, _flat(" ".join(body))))
    return out


def check(raw, persona: str, rules: str) -> list[dict]:
    """모델 답에서 믿을 수 있는 것만: 정해진 종류, 페르소나 원문에 있는 인용, (반대 · 모순이면) 원문에 있는 상대 구절."""
    flat_p, flat_r, parts = _flat(persona), _flat(rules), sections(persona)
    out, seen = [], set()
    for f in (raw.get("findings") if isinstance(raw, dict) else None) or []:
        if not isinstance(f, dict):
            continue
        kind, quote, other = f.get("kind"), _flat(f.get("quote")), _flat(f.get("other"))
        if kind not in KINDS or len(quote) < MIN_QUOTE or quote not in flat_p:
            continue
        if kind == "RULE_CONFLICT" and (len(other) < MIN_QUOTE or other not in flat_r):
            continue
        if kind == "SELF_CONFLICT" and (len(other) < MIN_QUOTE or other == quote or other not in flat_p):
            continue
        if kind == "BUSINESS":
            other = ""
        key = (kind, *sorted((quote, other)))  # 모순은 A↔B와 B↔A가 같은 것
        if key in seen:
            continue
        seen.add(key)
        out.append({"kind": kind, "section": next((t for t, body in parts if quote in body), ""),
                    "quote": quote, "other": other, "why": _flat(f.get("why"))[:MAX_WHY]})
    return out


# ponytail: 한 판만 돌린다. 표본에서 판마다 결과가 흔들리면 call_analysis처럼 3판 다수결(vote)로 올린다
async def lint(client, persona: str, rules: str | None = None, effort: str = EFFORT) -> list[dict] | None:
    """문제 목록(없으면 []). 모델 호출 · 응답이 깨지면 None — '문제 없음'과 구분한다."""
    rules = RULES.read_text("utf-8") if rules is None else rules
    try:
        resp = await asyncio.wait_for(client.responses.create(
            model=MODEL, instructions=PROMPT.read_text("utf-8"),
            input=f"[업무 규칙]\n{rules}\n\n[페르소나]\n{persona}",  # 안 바뀌는 규칙을 앞에(프롬프트 캐시)
            reasoning={"effort": effort},
            text={"format": {"type": "json_schema", "name": "persona_lint", "strict": True, "schema": SCHEMA}},
        ), TIMEOUT_SEC)
        return check(json.loads(resp.output_text), persona, rules)
    except (asyncio.TimeoutError, json.JSONDecodeError, openai.OpenAIError, AttributeError) as e:
        log.warning("페르소나 검사 실패: %s", type(e).__name__)
        return None


def split_expect(text: str) -> tuple[set[str] | None, str]:
    """표본 첫 줄의 정답 → (정답 종류 | None, 검사할 글). none = 빈 집합."""
    m = EXPECT.match(text)
    if not m:
        return None, text
    want = {k for k in re.split(r"[,\s]+", m.group(1)) if k}
    if want - {*KINDS, "none"}:
        raise ValueError(f"모르는 정답 종류: {sorted(want - {*KINDS, 'none'})}")
    return want - {"none"}, text[m.end():]


def verdict(want: set[str] | None, found: list[dict] | None) -> str:
    if found is None:
        return "오류"
    if want is None:
        return ""
    kinds = {f["kind"] for f in found}
    return "OK" if (want <= kinds if want else not kinds) else "MISS"


async def main(paths: list[str]) -> int:
    client = openai.AsyncOpenAI(api_key=os.environ["PERSONA_CHECK_OPENAI_API_KEY"])
    samples = [split_expect(text) for text in await asyncio.to_thread(lambda: [Path(p).read_text("utf-8") for p in paths])]
    results = await asyncio.gather(*(lint(client, text) for _, text in samples))
    bad = 0
    for path, (want, _), found in zip(paths, samples, results, strict=True):
        mark = verdict(want, found)
        bad += mark in ("MISS", "오류")
        print(f"{Path(path).name}  {mark}  문제 {len(found or [])}건" + (f"  정답 {sorted(want) or 'none'}" if want is not None else ""))
        for f in found or []:
            pair = f'  <> "{f["other"]}"' if f["other"] else ""
            print(f'  {f["kind"]} [{f["section"]}] "{f["quote"]}"{pair}\n      {f["why"]}')
    return 1 if bad else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 콘솔(cp949)에서 한글 · 기호가 깨지지 않게
    sys.exit(asyncio.run(main(sys.argv[1:])))
