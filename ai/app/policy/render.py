"""정책 → Live 지시문·Backend 지시문·Decision 질문. 같은 Policy 객체에서 서버 판정(app/domain/assess.py)도 나온다.

Live 지시문 = [페르소나: BE promptText, 없으면 policy/persona_default.md] + [업무 규칙: policy/business_rules.md
+ 정책 렌더링(절차·위임·금지·서버 결과 읽는 법)] + [통화 정보]. 업무 규칙이 페르소나보다 우선(business_rules.md 첫머리).
Backend 지시문 = policy/backend_rules.md. 문장은 파일에 두고 코드는 이어 붙이기만 한다(docs/architecture/prompt-layout-plan.md).
"""

from app.config import ROOT
from app.policy.model import Policy
from app.policy.inputs import render_input_rules

POLICY_DIR = ROOT / "policy"


def _read(name: str) -> str:
    return (POLICY_DIR / name).read_text(encoding="utf-8").strip()


def default_persona() -> str:
    """BE 페르소나가 없을 때(연동 꺼짐·ACTIVE 없음, P2)."""
    return _read("persona_default.md")


def business_rules(*, live_led: bool = False) -> str:
    return _read("business_rules.md" if live_led else "business_rules_legacy.md")


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
              f"- 고객이 {', '.join(['예/아니요', '후보 고르기', *_labels(policy, choice)])}처럼 고르는 답을 할 때(서버가 직접 듣고 판단합니다)",
              "- 인사, 맞장구, 대기 요청, 이미 받은 결과로 답할 수 있는 말", "",
              "Do not guess the result while waiting.",
              "- 결과를 기다리는 동안 채우는 말은 정해진 문장 없이, 고객이 방금 한 말에 이어지는 자연스러운 한마디로 그때그때 짓습니다. "
              "짧게 하고, 앞에서 한 말을 되풀이하지 않습니다. 바로 답할 수 있으면 채우는 말 없이 답합니다.",
              "- 채우는 말에는 결과·판단·되읽기·다음 질문을 넣지 않습니다. 결과는 서버 결과가 온 뒤에 말합니다.",
              "- 고객이 말을 시작하면 하던 말을 바로 멈추고 고객 말을 먼저 받습니다. 기다리던 결과가 뒤늦게 오면 "
              "고객이 방금 한 말에 맞춰 필요한 것만 이어서 안내합니다(이미 지나간 이야기를 다시 꺼내지 않습니다).", "",
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
                tools: tuple[tuple[str, str], ...] = (), *, live_led: bool = False) -> str:
    """페르소나(교체 가능) → 업무 규칙(고정) → 정책 절차 → 통화 정보. 페르소나가 비면 기본 페르소나(P2)."""
    persona = prompt_text.strip() if prompt_text and prompt_text.strip() else default_persona()
    if live_led:
        order = [policy.fields[n].label for stage in policy.collect_stages() for n in stage.required]
        parts = [persona, "", business_rules(live_led=True), "", render_input_rules(policy), "",
                 "## 기본 수집 순서\n" + " → ".join(order),
                 "## Delegation policy\nBackend tools:"]
        parts += [f"- {name}: {desc}" for name, desc in tools]
        parts += ["Generate <|SpawnThinking|> when:\n"
                  "- 규칙에 맞는 값을 기록하거나 정정할 때, 실제 조회·검색이 필요할 때.\n"
                  "- 동의·후보·출발지·저장·콜백·업무 전환·추가 택배·종료 의사를 서버에 반영할 때. "
                  "manage_conversation으로 요청한 행동을 전달합니다.\n"
                  "Do not generate <|SpawnThinking|> when:\n"
                  "- 범위 밖이거나 불명확해 고객에게 다시 물어야 할 때. 간단한 규칙 판단을 백엔드에 묻지 않습니다.\n"
                  "- 인사·맞장구·이미 받은 사실의 반복.\n"
                  "Do not guess the result while waiting.\n"
                  "- 단순 기록 중에는 이미 들은 항목을 다시 묻지 않고 다음 독립 항목을 물을 수 있습니다. "
                  "주소 조회 중에는 다음 작업으로 넘어가지 않습니다. 실제 결과·최종 확인은 필요한 처리가 끝난 뒤 안내합니다."]
        meanings = dict(policy.results) | {
            "readback": "서버가 기록한 확인 내용. 직접 말한 상세주소를 포함해 읽습니다. 고객이 의미상 수락하면 읽기를 끝내고 확인 ID로 전달합니다.",
            "confirmation": "최신 확인 ID와 종류 또는 재확인 사유. 접수와 취소의 대상을 구분합니다. cancel_ask_again은 취소할지 묻습니다.",
            "missing": "서버 기록 기준의 누락 항목. 이미 들었고 기록 중인 값은 다시 묻지 않습니다. 실제 실패한 항목은 복구합니다.",
        }
        parts += ["## 서버 결과 읽는 법"] + [f"- {key}: {value}" for key, value in meanings.items()]
        parts += [f"같은 항목을 {policy.reask.max_attempts}회 받지 못하면 표현·방법을 바꾸고 상담원 연결을 권합니다."]
    else:
        parts = [persona, "", business_rules(), "", render_policy(policy, tools)]
    if call_info:
        parts += ["", "# 통화 정보"] + [f"- {k}: {v}" for k, v in call_info.items()]
    return "\n".join(parts)


def render_backend(policy: Policy, *, live_led: bool = False) -> str:
    free = ", ".join(f"{policy.fields[n].label}({n})" for n in policy.free_fields())
    name = "backend_rules_live.md" if live_led else "backend_rules.md"
    return _read(name).replace("{fields}", free)


def decision_questions(policy: Policy, stage_id: str, *, pending: bool = False,
                       pick_labels: tuple[str, ...] = (),
                       callback: bool = False, save: bool = False, origin: bool = False) -> list[dict]:
    """발화 끝 Decision 호출에 넣을 질문(SDK `questions` 모양). 선택형 판단이 없으면 빈 목록(호출하지 않음)."""
    stage = next((s for s in policy.stage if s.id == stage_id), None)
    sets = [d for d in stage.decision if d not in ("off", "confirm", "pick")] if stage else []
    if stage is None:
        sets = ["intent"] if stage_id == "intent" else ["collect"]
    if pending:
        sets.insert(0, "confirm")  # confirm은 확인 대기가 있을 때만(delegation.md §3.2)
    if callback:
        sets.insert(0, "callback")  # 콜백 제안에 답을 기다릴 때만(업무 규칙 e)
    if save:  # 담은 뒤 주소 저장을 물었고 답을 기다릴 때만(업무 규칙 g)
        sets.insert(0, "save")
        # 저장 질문에 답하는 동안 "더 없음"은 듣지 않는다: 저장에 대한 "아니요"가 더 없음으로 읽히면 결과가 바로 전송된다
        sets = [d for d in sets if d != "more"]
    if origin:
        sets.insert(0, "origin")  # 기존 고객에게 출발지를 물었고 답을 기다릴 때만
    out = []
    for name in dict.fromkeys(sets):
        for q in policy.decision[name].questions:
            item = {"type": q.type, "name": q.name, "instructions": q.instructions}
            if q.type == "choice":
                item["choices"] = [{"value": c} for c in q.choices]
            out.append(item)
    if pick_labels:
        out.append({"type": "choice", "name": "pick", "instructions":
                    "직전 AI 발화가 후보 중 하나를 고르라고 했고 고객이 골랐으면 그 후보를, 모두 아니라고 하면 none, 답이 아니면 not_answer.",
                    "choices": [{"value": v} for v in (*pick_labels, "none", "not_answer")]})
    return out
