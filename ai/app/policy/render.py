"""정책 → Live 지시문·Backend 지시문·Decision 질문. 같은 Policy 객체에서 서버 판정(app/domain/assess.py)도 나온다.

Live 지시문 = [페르소나: BE promptText, 없으면 policy/persona_default.md] + [업무 규칙: policy/business_rules.md
+ 정책 렌더링(절차·위임·금지·서버 결과 읽는 법)] + [통화 정보]. 업무 규칙이 페르소나보다 우선(business_rules.md 첫머리).
Backend 지시문 = policy/backend_rules.md. 문장은 파일에 두고 코드는 이어 붙이기만 한다(docs/architecture/prompt-layout-plan.md).
"""

from app.config import ROOT
from app.domain.pickup import describe, rule_of
from app.policy.model import Policy

POLICY_DIR = ROOT / "policy"


def _read(name: str) -> str:
    return (POLICY_DIR / name).read_text(encoding="utf-8").strip()


def default_persona() -> str:
    """BE 페르소나가 없을 때(연동 꺼짐·ACTIVE 없음, P2)."""
    return _read("persona_default.md")


def business_rules() -> str:
    return _read("business_rules.md")


def render_input_rules(policy: Policy) -> str:
    """Live·Responses 양쪽에 같은 입력 제한을 제공한다."""
    limits, phone = policy.input_limits, policy.phone
    return "\n".join([
        "## 공통 입력 제한(페르소나·검색 자료의 다른 제한보다 우선)",
        f"- 물품 가액: {limits.item_price_min:,}원~{limits.item_price_max:,}원(양 끝 포함). "
        "서류를 제외한 물품에 이 범위를 적용합니다.",
        f"- 현재 받는 곳별 접수 묶음(parcel)마다 소형·중형·대형 박스 합계 최대 {limits.box_total_max}개.",
        f"- 서류는 같은 묶음에서 박스와 별도로 최대 {limits.document_max}개. 서류를 박스 합계에 더하지 않습니다.",
        "- 수거 가능 범위: " + describe(rule_of(policy.pickup)) + ". 시간대는 한국 시간입니다.",
        f"- 전화번호: 한글 숫자·국가번호 +82·구분 기호를 정리한 뒤 0으로 시작하는 정확히 {phone.digits}자리 휴대전화 번호만 받습니다. "
        "유선·대표번호는 받지 않습니다. 번호를 추측해 채우거나 자릿수를 맞추려고 숫자를 더하거나 빼지 않습니다.",
        "- 허용 범위 밖 값은 임의로 줄이거나 상한으로 바꾸지 않고 허용 범위를 설명한 뒤 다시 받습니다.",
    ])


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
             "- 접수 정보를 수집할 때만 현재 택배의 최신 서버 결과(또는 summary)에 있는 missing의 첫 항목을 하나만 묻습니다. "
             "fields에서 valid인 항목은 건너뛰고, missing이 비어 있으면 새 수집 질문을 하지 않습니다.",
             "- 서버가 needs, 선택 확인, 되읽기를 요청하면 수집 질문보다 먼저 처리합니다. 고객의 정정은 해당 항목을 다룹니다.",
             "- 순서 밖의 값이나 한 번에 말한 값도 함께 맡기고, 결과를 기다리는 동안 같은 값을 다시 묻지 않습니다."]
    lines += [f"- {policy.fields[n].label}: {s.rule}" for s in collect for n in s.required if s.rule]
    lines += ["", render_input_rules(policy), "", "## 단계"]
    lines += [f"- {s.goal}" + (" (서버가 확인 내용이나 결과를 줄 때만 합니다)" if s.gate else "") for s in policy.stage]
    lines += ["", "## 백엔드에 맡기기", "Generate <|SpawnThinking|> when:",
              f"- 고객이 다음 정상 범위의 값을 말하거나 고칠 때: {', '.join(_labels(policy, policy.free_fields()))}",
              "- 고객이 처음 또는 추가로 물건 이름을 말하면 박스 후보를 제안할 근거가 있을 때 box_suggestion으로, "
              "크기나 개수가 애매할 때 box_size_needed로 맡깁니다.",
              "- 수거 시각 변경은 서버의 현재 시각 기준 최종 검사를 거치도록 맡깁니다. 통화 시작 시각만으로 허용 여부를 확정하지 않습니다.",
              "- 정상 정보와 잘못된 값이 섞이면 정상 정보는 버리지 않고 맡기고, 잘못된 항목은 다시 묻습니다. "
              "기록 성공은 서버 결과로만 안내합니다."]
    if tools:
        lines += ["", "Backend tools:"] + [f"- {name}: {desc}" for name, desc in tools]
    lines += ["", "Do not generate <|SpawnThinking|> when:",
              "- 고객이 말한 수량·전화번호 또는 서버가 요청한 물품 가액이 공통 입력 제한을 명백히 벗어나고 다른 정상 정보는 없을 때. "
              "도구 거절을 기다리지 말고 허용 범위를 설명해 해당 항목만 다시 묻습니다. 애매한 값은 추측하지 않고 확인합니다.",
              f"- 고객이 {', '.join(['예/아니요', '후보 고르기', *_labels(policy, choice)])}처럼 고르는 답을 할 때(서버가 직접 듣고 판단합니다)",
              "- 첫 인사의 접수 질문에 동의할 때. 서버 결과가 오면 그때 안내를 이어갑니다.",
              "- 고객이 상담원 연결이나 통화 종료만 명확하게 요청할 때(서버가 직접 듣고 처리합니다).",
              "- 인사, 맞장구, 대기 요청, 이미 받은 결과로 답할 수 있는 말", "",
              "Do not guess the result while waiting.",
              "- 결과를 기다리는 동안 채우는 말은 정해진 문장 없이, 고객이 방금 한 말에 이어지는 자연스러운 한마디로 그때그때 짓습니다. "
              "짧게 하고, 앞에서 한 말을 되풀이하지 않습니다. 바로 답할 수 있으면 채우는 말 없이 답합니다.",
              "- 채우는 말에는 저장 결과·되읽기·다음 접수 질문을 넣지 않습니다. "
              "명백한 입력 제한 위반의 설명과 재질문은 바로 할 수 있습니다. 저장 결과는 서버 결과가 온 뒤에 말합니다.",
              "- 고객이 말을 시작하면 하던 말을 바로 멈추고 고객 말을 먼저 받습니다. 기다리던 결과가 뒤늦게 오면 "
              "고객이 방금 한 말에 맞춰 필요한 것만 이어서 안내합니다(이미 지나간 이야기를 다시 꺼내지 않습니다).", "",
              "## 하지 않는 것"]
    lines += [f"- {item}" for item in policy.forbid.items]
    lines += ["", "## 읽기 규칙"] + [f"- {v}" for v in policy.speech.values()]
    if policy.results:
        lines += ["", "## 서버 결과 읽는 법",
                  "- 도구 결과와 '[서버 결과]'로 시작하는 알림은 서버가 확인한 사실(JSON)이다. 결과에 없는 사실은 추측하지 않고, 결과는 뜻대로 안내한다."]
        lines += [f"- {k}: {v}" for k, v in policy.results.items()]
    lines += ["", "## 다시 묻기",
              f"- 같은 항목을 {policy.reask.max_attempts}번 받지 못하면 다른 방법을 제안합니다."
              + (" 다시 물을 때는 표현을 바꿉니다." if policy.reask.vary_wording else "")]
    return "\n".join(lines)


def render_live(prompt_text: str | None, policy: Policy, call_info: dict[str, str] | None = None,
                tools: tuple[tuple[str, str], ...] = ()) -> str:
    """페르소나(교체 가능) → 업무 규칙(고정) → 정책 절차 → 통화 정보. 페르소나가 비면 기본 페르소나(P2)."""
    persona = prompt_text.strip() if prompt_text and prompt_text.strip() else default_persona()
    parts = [persona, "", business_rules(), "", render_policy(policy, tools)]
    if call_info:
        parts += ["", "# 통화 정보"] + [f"- {k}: {v}" for k, v in call_info.items()]
    return "\n".join(parts)


def render_backend(policy: Policy) -> str:
    free = ", ".join(f"{policy.fields[n].label}({n})" for n in policy.free_fields())
    rules = "\n".join(f"- {key}: {rule.guidance}" +
                      (f" {', '.join(rule.excluded_terms)} 자체는 이 규칙에 해당하지 않습니다."
                       if rule.excluded_terms else "")
                      for key, rule in policy.parcel_items.rules.items())
    return (_read("backend_rules.md").replace("{fields}", free).replace("{parcel_item_rules}", rules)
            + "\n\n" + render_input_rules(policy))


def decision_questions(policy: Policy, stage_id: str, *, pending: bool = False,
                       pick_labels: tuple[str, ...] = (),
                       callback: bool = False, origin: bool = False, cancel_current: bool = False,
                       box_label: str | None = None) -> list[dict]:
    """발화 끝 Decision 호출에 넣을 질문(SDK `questions` 모양). 선택형 판단이 없으면 빈 목록(호출하지 않음)."""
    stage = next((s for s in policy.stage if s.id == stage_id), None)
    sets = [d for d in stage.decision if d not in ("off", "confirm", "pick")] if stage else []
    if stage is None and stage_id == "intent":
        sets = ["intent"]
    elif stage is None and stage_id in ("inquiry", "lookup", "cancel", "agent"):
        # 접수 밖 업무에도 끝내기·업무 전환을 듣는다(없으면 문의·조회 뒤 '끊을게요'를 못 들어 무음 종료만 남음, 운영 통화 8df5dd7f)
        sets = ["collect"]
    if pending:
        sets.insert(0, "confirm")  # confirm은 확인 대기가 있을 때만(delegation.md §3.2)
    if callback:
        sets.insert(0, "callback")  # 콜백 제안에 답을 기다릴 때만(업무 규칙 e)
    if origin:
        sets.insert(0, "origin")  # 기존 고객에게 출발지를 물었고 답을 기다릴 때만
    if box_label:
        sets.insert(0, "box")
    out = []
    for name in dict.fromkeys(sets):
        for q in policy.decision[name].questions:
            item = {"type": q.type, "name": q.name, "instructions": q.instructions}
            if q.name == "box" and box_label:
                item["instructions"] += f" 현재 확인할 후보는 '{box_label}'이다."
            if q.type == "choice":
                item["choices"] = [{"value": c} for c in q.choices]
                if q.name == "switch" and cancel_current:
                    item["choices"].append({"value": "cancel_current"})
                    item["instructions"] += (" 고객이 지금 정보를 받는 중인 택배만 빼 달라고 명확히 말하면 cancel_current. "
                                             "이미 담은 다른 택배를 취소하거나 대상이 불분명하면 cancel을 고른다.")
            out.append(item)
    if pick_labels:
        out.append({"type": "choice", "name": "pick", "instructions":
                    "직전 AI 발화가 후보 중 하나를 고르라고 했고 고객이 골랐으면 그 후보를, 모두 아니라고 하면 none, 답이 아니면 not_answer.",
                    "choices": [{"value": v} for v in (*pick_labels, "none", "not_answer")]})
    return out
