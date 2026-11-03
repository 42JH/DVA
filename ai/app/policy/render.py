"""정책 → Live 지시문·Backend 지시문·Decision 질문. 같은 Policy 객체에서 서버 판정(app/domain/assess.py)도 나온다.

Live 지시문 = 페르소나 promptText(우선, P2) 또는 서버 기본 프롬프트 + 아래 정책 렌더링(절차·위임·금지).
"""

from app.config import ROOT
from app.policy.model import Policy

DEFAULT_PROMPT_PATH = ROOT / "policy" / "default_prompt.md"


def default_prompt() -> str:
    return DEFAULT_PROMPT_PATH.read_text(encoding="utf-8")


def _labels(policy: Policy, names) -> list[str]:
    return [policy.fields[n].label for n in names]


def render_policy(policy: Policy, tools: tuple[tuple[str, str], ...] = ()) -> str:
    collect = policy.collect_stages()
    order = [n for s in collect for n in s.required]
    auto = [n for n, f in policy.fields.items() if f.kind == "auto"]
    choice = [n for n, f in policy.fields.items() if f.kind == "choice"]
    lines = [f"# 상담 절차 (정책 {policy.version})", "",
             "## 택배 정보 받는 순서(고정, 한 번에 하나씩)",
             " → ".join(f"{i}. {label}" for i, label in enumerate(_labels(policy, order), 1)),
             f"- {', '.join(_labels(policy, auto))}는 서버가 채웁니다. 묻지 않습니다.",
             "- 이미 기록된 항목은 다시 묻지 않습니다. 서버 결과의 missing이 아직 받지 못한 항목입니다.",
             "- 순서 밖에서 말한 값과 정정도 버리지 않고 맡깁니다. 그다음 질문은 여전히 이 순서에서 빠진 첫 항목입니다."]
    lines += [f"- {policy.fields[n].label}: {s.rule}" for s in collect for n in s.required if s.rule]
    lines += ["", "## 단계"]
    lines += [f"- {s.goal}" + (" (서버가 확인 내용이나 결과를 줄 때만 합니다)" if s.gate else "") for s in policy.stage]
    lines += ["", "## 백엔드에 맡기기", "Generate <|SpawnThinking|> when:",
              f"- 고객이 다음 값을 말하거나 고칠 때: {', '.join(_labels(policy, policy.free_fields()))}"]
    if tools:
        lines += ["", "Backend tools:"] + [f"- {name}: {desc}" for name, desc in tools]
    lines += ["", "Do not generate <|SpawnThinking|> when:",
              f"- 고객이 예/아니요, 후보 고르기, {', '.join(_labels(policy, choice))}처럼 고르는 답을 할 때(서버가 직접 듣고 판단합니다)",
              "- 인사, 맞장구, 대기 요청, 이미 받은 결과로 답할 수 있는 말", "",
              "Do not guess the result while waiting. 결과가 오기 전에는 짧은 대기 안내만 합니다.", "",
              "## 하지 않는 것"]
    lines += [f"- {item}" for item in policy.forbid.items]
    lines += ["", "## 읽기 규칙"] + [f"- {v}" for v in policy.speech.values()]
    if policy.results:
        lines += ["", "## 서버 결과 읽는 법",
                  "- 도구 결과와 '[서버 결과]'로 시작하는 알림은 서버가 확인한 사실(JSON)이다. 그대로 읽지 않고 뜻대로 안내한다."]
        lines += [f"- {k}: {v}" for k, v in policy.results.items()]
    lines += ["", "## 다시 묻기",
              f"- 같은 항목을 {policy.reask.max_attempts}번 받지 못하면 다른 방법을 제안합니다."
              + (" 다시 물을 때는 표현을 바꿉니다." if policy.reask.vary_wording else "")]
    return "\n".join(lines)


def render_live(prompt_text: str | None, policy: Policy, call_info: dict[str, str] | None = None,
                tools: tuple[tuple[str, str], ...] = ()) -> str:
    """P2: 페르소나 promptText 우선, 없으면(조회 실패·빈 값) 서버 기본 프롬프트. 정책 절차는 뒤에 붙는다."""
    base = prompt_text.strip() if prompt_text and prompt_text.strip() else default_prompt()
    parts = [base, "", "페르소나 지시와 아래 절차가 충돌하면 페르소나 지시를 따르되, '하지 않는 것'은 항상 지킵니다.", "",
             render_policy(policy, tools)]
    if call_info:
        parts += ["", "# 통화 정보"] + [f"- {k}: {v}" for k, v in call_info.items()]
    return "\n".join(parts)


def render_backend(policy: Policy) -> str:
    free = ", ".join(f"{policy.fields[n].label}({n})" for n in policy.free_fields())
    return ("음성 상담의 백엔드입니다. 고객 발화(음성 전사)에서 값을 뽑아 알맞은 도구를 호출합니다.\n"
            f"뽑는 값: {free}. 말하지 않은 항목은 null입니다. 들은 숫자는 한 자리씩 빠짐없이 그대로 넣습니다.\n"
            "예/아니요·후보 선택·용건 분류·결제 방식 판단은 하지 않습니다(서버가 합니다). 다음 절차도 정하지 않습니다.\n"
            "물품을 기록할 때는 바뀐 규격만이 아니라 지금 보낼 물품 전체(규격별 개수)를 넣습니다(정정 포함).\n"
            "도구 결과의 facts·fields·missing만 근거로 Live가 말할 내용을 한두 문장으로 돌려줍니다. 결과를 지어내지 않습니다.")


def decision_questions(policy: Policy, stage_id: str, *, pending: bool = False,
                       pick_labels: tuple[str, ...] = (), pay_methods: tuple[str, ...] = ()) -> list[dict]:
    """발화 끝 Decision 호출에 넣을 질문(SDK `questions` 모양). 선택형 판단이 없으면 빈 목록(호출하지 않음)."""
    stage = next((s for s in policy.stage if s.id == stage_id), None)
    sets = [d for d in stage.decision if d not in ("off", "confirm", "pick")] if stage else []
    if stage is None and stage_id == "intent":
        sets = ["intent"]
    if pending:
        sets.insert(0, "confirm")  # confirm은 확인 대기가 있을 때만(delegation.md §3.2)
    out = []
    for name in dict.fromkeys(sets):
        for q in policy.decision[name].questions:
            item = {"type": q.type, "name": q.name, "instructions": q.instructions}
            if q.type == "choice":
                choices = q.choices
                if q.name == "pay" and pay_methods:  # 고객의 실제 가능 방식만(S6: 카드를 고를 수 없던 버그 B)
                    choices = tuple(c for c in q.choices if c in pay_methods) + ("not_answer",)
                item["choices"] = [{"value": c} for c in choices]
            out.append(item)
    if pick_labels:
        out.append({"type": "choice", "name": "pick", "instructions":
                    "직전 AI 발화가 후보 중 하나를 고르라고 했고 고객이 골랐으면 그 후보를, 모두 아니라고 하면 none, 답이 아니면 not_answer.",
                    "choices": [{"value": v} for v in (*pick_labels, "none", "not_answer")]})
    return out
