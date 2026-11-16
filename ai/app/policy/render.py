"""정책 → Live 지시문·Backend 지시문·Decision 질문. 같은 Policy 객체에서 서버 판정(app/domain/assess.py)도 나온다.

Live 지시문 = [페르소나: BE promptText, 없으면 policy/persona_default.md] + [위임 정책] + [업무 규칙: policy/business_rules.md
+ 정책 렌더링(절차·금지·서버 결과 읽는 법)] + [통화 정보]. 업무 규칙이 페르소나보다 우선(business_rules.md 첫머리).
Backend 지시문 = policy/backend_rules.md. 문장은 파일에 두고 코드는 이어 붙이기만 한다(docs/architecture/prompt-layout-plan.md).
"""

from app.config import ROOT
from app.domain.candidates import destination_changes
from app.domain.pickup import describe, rule_of
from app.domain.state import CandidateSet
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
        f"- 받는 분 연락처: 서버가 한글 숫자·국가번호 +82·구분 기호를 정리해 휴대전화 {phone.mobile.min_digits}자리, "
        f"02는 {phone.seoul.min_digits}~{phone.seoul.max_digits}자리, 기타 지역번호는 "
        f"{phone.regional.min_digits}~{phone.regional.max_digits}자리, 070은 {phone.internet.min_digits}자리를 받습니다. "
        "번호를 추측해 채우지 않습니다.",
        "- 허용 범위 밖 값은 임의로 줄이거나 상한으로 바꾸지 않고 허용 범위를 설명한 뒤 다시 받습니다.",
    ])


def _labels(policy: Policy, names) -> list[str]:
    return [policy.fields[n].label for n in names]


def render_delegation(policy: Policy, tools: tuple[tuple[str, str], ...] = ()) -> str:
    """위임 정책. 페르소나 바로 뒤에 둔다 — 지시문 끝 쪽에 있을 때 Live가 값을 받고도 위임하지 않는 통화가 이어져서."""
    choice = [n for n, f in policy.fields.items() if f.kind == "choice"]
    regular_values = (n for n in policy.free_fields() if n != "receiver_phone")
    lines = ["# 백엔드 위임(<|SpawnThinking|>)", "Generate <|SpawnThinking|> when:",
              "- 고객이 새 발송 기본주소나 상세주소를 말할 때, 또는 발송 상세주소가 없다고 답할 때. "
              "동의와 주소를 한 발화에서 함께 말해도 주소 값으로 생성합니다. 서버 기록 결과가 오기 전에는 "
              "그 주소를 확인했다고 말하거나 받는 분 정보를 묻지 않습니다.",
              f"- 고객이 다음 정상 범위의 새 값을 제공하거나 기존 값을 고칠 때: {', '.join(_labels(policy, regular_values))}",
              "- 고객이 받는 분 연락처를 말하거나 고칠 때. 자릿수가 모호해 보여도 들은 표현으로 기록을 요청합니다.",
              "- 고객이 처음 또는 추가로 물건 이름을 말하면 박스 후보를 제안할 근거가 있을 때 box_suggestion, "
              "크기나 개수가 애매할 때 box_size_needed로 기록을 요청합니다.",
              "- 고객이 수거 시각을 바꾸려 할 때. 허용 여부는 서버가 현재 시각 기준으로 최종 검사합니다. 통화 시작 시각만으로 허용 여부를 확정하지 않습니다.",
              "- 정상 정보와 잘못된 값이 섞이면 정상 정보는 버리지 않고 기록을 요청하고, 잘못된 항목은 다시 묻습니다. "
              "기록 성공은 서버 결과로만 안내합니다.",
              "- 고객이 진행 중인 택배에 기록된 값(받는 분·주소·상세주소·연락처·물품 등)이나 안내한 받는 곳 후보의 "
              "주소·상세주소·연락처를 물었고 최신의 유효한 서버 결과에 답이 없을 때. 대화에서 들은 값으로 추측하지 않습니다.",
              "- 기존 주문의 취소 대상을 새로 찾아야 할 때 lookup_orders로 조회합니다. 이번 통화와 직전 통화 구분도 함께 전달합니다.",
              "- 받는 곳 후보에 답하면서 새 주소나 새 받는 분 정보를 같이 말하면 새 값의 기록을 요청합니다. "
              "후보 답변만 했으면 서버 결과를 기다린 뒤 그 결과가 정한 질문을 합니다."]
    if tools:
        lines += ["", "Backend tools:"] + [f"- {name}: {desc}" for name, desc in tools]
    lines += ["", "Do not generate <|SpawnThinking|> when:",
              "- 고객이 되읽기 접수 질문에 '네, 그렇게 접수해 주세요'처럼 동의만 했거나 추가 도움이 없다고만 답했을 때. "
              "서버가 그 답을 직접 처리하므로 다음 안내를 기다립니다. 고객이 접수 값도 새로 말하거나 고치면 그 값만 기록하도록 요청합니다.",
              "- 고객이 방금 선택한 택배를 가리켜 취소를 요청하거나 서버의 취소 확인 질문에 답할 때. 서버가 다음 결과를 전달합니다.",
              "- 고객이 말한 수량 또는 서버가 요청한 물품 가액이 공통 입력 제한을 명백히 벗어나고 다른 정상 정보는 없을 때. "
              "도구 거절을 기다리지 말고 허용 범위를 설명해 해당 항목만 다시 묻습니다. 애매한 값은 추측하지 않고 확인합니다.",
              f"- 고객이 {', '.join(['예/아니요', '후보 고르기', *_labels(policy, choice)])}처럼 고르는 답을 할 때(서버가 직접 듣고 판단합니다). "
              "제시된 이름·주소·수량을 그대로 되풀이해 선택하는 답도 새 값이 아닙니다. 실제 새 값이나 정정이 함께 있으면 그 부분만 위임합니다. 상세주소가 없다는 답은 기록할 값이므로 생성합니다.",
              "- 첫 인사에 답하면서 접수에 동의하거나 새 성함·주소를 말하지 않고 보내는 분 성함이나 발송 주소를 바꾸겠다고만 할 때. "
              "서버 결과가 오면 그때 안내를 이어갑니다. 새 성함·주소 또는 다른 접수 값을 함께 말하면 그 값으로 생성합니다.",
              "- 고객이 상담원 연결이나 통화 종료만 명확하게 요청할 때(서버가 직접 듣고 처리합니다).",
              "- 인사, 맞장구, 대기 요청, 최신 서버 결과에 답이 있고 그 뒤 관련 정보나 조회 범위가 바뀌지 않은 질문·반복 요청", "",
              "- 새 정보 없는 일반 수긍('네', '알겠습니다')이나 추가 도움이 있다는 짧은 답에는 위임하지 않고 바로 이어갑니다. "
              "접수 정보를 받는 중이면 최신 서버 결과가 정한 질문 하나를 하고, 조회·문의·취소 안내가 끝난 뒤면 "
              "'더 도와드릴 일이 있을까요?'라고 한 번 묻습니다. 도움이 있다고만 답했으면 '어떤 도움이 필요하신가요?'라고 묻고, "
              "조회·취소할 택배가 아직 정해지지 않았으면 그 택배의 받는 분 성함을 묻습니다. 용건이 아직 없으면 어떤 업무를 도와드릴지 묻습니다. "
              "이미 안내한 결과를 반복하지 않고, 수긍만으로 저장·접수·취소를 확정하지 않습니다. "
              "위임한 결과나 위에서 서버가 직접 처리한다고 한 답의 결과를 기다리는 중이면 그 결과가 올 때까지 다음 질문을 하지 않습니다.", "",
              "Do not guess the result while waiting.",
              "- 접수 동의와 추가 도움에 대한 종료 답변을 받은 뒤에는 서버 안내를 기다리며 채우는 말을 생략합니다. "
              "다른 백엔드 결과를 기다리는 동안 안내가 필요하면 ‘네, 잠시만요.’, ‘확인해 보겠습니다.’, "
              "‘잠시만 기다려 주세요.’ 중 하나를 골라 그 문장만 한 번 말합니다. "
              "바로 답하거나 다음 질문을 할 수 있으면 대기 멘트를 생략합니다.",
              "- 대기 멘트에 고객이 방금 말한 내용, 저장 결과, 확인 질문이나 다음 접수 질문을 덧붙이지 않습니다. "
              "어떤 질문을 하려 했는지나 질문 순서를 바꾼 이유를 말하지 않습니다. "
              "명백한 입력 제한 위반의 설명과 재질문은 바로 할 수 있습니다. 저장 결과는 서버 결과가 온 뒤에 말합니다.",
              "", "## 공통 끼어들기 규칙",
              "- 고객이 말을 시작하면 하던 말을 바로 멈추고 고객 말을 끝까지 듣습니다. "
              "접수 확인을 읽는 중에도 문장 중간에서 멈춥니다. "
              "고객이 정정하거나 새 질문을 하면 그 내용을 먼저 처리합니다.",
              "- 끊긴 문장을 그대로 이어 읽지 않습니다. 기다리던 결과가 뒤늦게 오면 "
              "고객이 방금 한 말에 맞춰 최신 서버 결과에서 필요한 내용만 안내합니다."]
    return "\n".join(lines)


def render_policy(policy: Policy) -> str:
    collect = policy.collect_stages()
    order = [n for s in collect for n in s.required]
    auto = [n for n, f in policy.fields.items() if f.kind == "auto"]
    lines = [f"# 상담 절차 (정책 {policy.version})", "",
             "## 택배 정보 받는 순서(한 번에 하나씩)",
             " → ".join(f"{i}. {label}" for i, label in enumerate(_labels(policy, order), 1)),
             f"- {', '.join(_labels(policy, auto))}는 서버가 채웁니다. 묻지 않습니다.",
             "- 접수 정보를 수집할 때만 현재 택배의 최신 서버 결과(또는 summary)가 지정한 next_field를 묻습니다. next_field가 없으면 기존 확인 질문이나 누락 항목 안내를 따릅니다. "
             "fields에서 valid인 항목은 건너뛰고, missing이 비어 있으면 새 수집 질문을 하지 않습니다. "
             "origin_confirm이나 sender_change_next가 있으면 그 확인 또는 질문만 먼저 합니다. 발송 기본주소와 상세주소가 기록된 뒤 최신 결과에 "
             "destination_change_question이 있으면 그 질문만 합니다. 그 외에는 destination_choices가 있으면 missing보다 먼저 확인합니다.",
             "- 서버가 needs, item_review, 선택 확인, 되읽기를 요청하면 수집 질문보다 먼저 처리합니다. "
             "서버가 readback을 준 경우에만 접수 내용을 직접 읽고 최종 접수 확인 질문을 합니다. "
             "접수 내용을 확인해 드릴지 따로 묻지 않습니다. "
             "발송 주소 변경 중에는 발송 주소의 재질문을 먼저 처리하고 받는 분 질문과 주소록 확인은 발송 주소 수집 뒤에 합니다.",
             "- 순서 밖의 값이나 한 번에 말한 값도 함께 기록을 요청하고, 결과를 기다리는 동안 같은 값을 다시 묻지 않습니다."]
    lines += [f"- {policy.fields[n].label}: {s.rule}" for s in collect for n in s.required if s.rule]
    lines += ["", render_input_rules(policy), "", "## 단계"]
    lines += [f"- {s.goal}" + (" (서버가 확인 내용이나 결과를 줄 때만 합니다)" if s.gate else "") for s in policy.stage]
    lines += ["", "## 하지 않는 것"]
    lines += [f"- {item}" for item in policy.forbid.items]
    lines += ["", "## 읽기 규칙"] + [f"- {v}" for v in policy.speech.values()]
    if policy.results:
        lines += ["", "## 서버 결과 읽는 법",
                  "- 도구 결과와 '[서버 결과]'로 시작하는 알림은 서버가 확인한 사실(JSON)이다. 결과에 없는 사실은 추측하지 않고, 결과는 뜻대로 안내한다.",
                  "- 택배 접수·주문 접수 완료·취소 완료·상담원 연결은 서버 결과로 온 뒤 아래에 정한 문장으로만 말한다. "
                  "그 결과가 오지 않았으면 일어난 일처럼 말하지 않는다. 결제가 끝났다고는 말하지 않는다."]
        lines += [f"- {k}: {v}" for k, v in policy.results.items()]
    lines += ["", "## 다시 묻기",
              f"- 같은 항목을 {policy.reask.max_attempts}번 받지 못하면 다른 방법을 제안합니다."
              + (" 다시 물을 때는 표현을 바꿉니다." if policy.reask.vary_wording else "")]
    return "\n".join(lines)


def render_live(prompt_text: str | None, policy: Policy, call_info: dict[str, str] | None = None,
                tools: tuple[tuple[str, str], ...] = ()) -> str:
    """페르소나(교체 가능) → 위임 정책 → 업무 규칙(고정) → 정책 절차 → 통화 정보. 페르소나가 비면 기본 페르소나(P2)."""
    persona = prompt_text.strip() if prompt_text and prompt_text.strip() else default_persona()
    parts = [persona, "", render_delegation(policy, tools), "", business_rules(), "", render_policy(policy)]
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
            .replace("{readback_rule}", policy.results.get("readback", ""))
            + "\n\n" + render_input_rules(policy))


def decision_questions(policy: Policy, stage_id: str, *, pending: bool = False,
                       pick_labels: tuple[str, ...] = (),
                       destination_candidates: CandidateSet | None = None,
                       callback: bool = False, origin: bool = False, sender_change: bool = False,
                       sender_name_scope: bool = False, sender_address_save: bool = False,
                       cancel_current: bool = False,
                       cancel_selected: bool = False, cancel_selected_order: bool = False,
                       cancel_confirmation: bool = False,
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
    if sender_change:
        sets.insert(0, "sender_change")
    if sender_name_scope:
        sets.append("sender_name_scope")
    if sender_address_save:
        sets.append("sender_address_save")  # 서버가 등록 주소 변경 여부를 물었을 때만
    if box_label:
        sets.insert(0, "box")
    out = []
    for name in dict.fromkeys(sets):
        for q in policy.decision[name].questions:
            item = {"type": q.type, "name": q.name, "instructions": q.instructions}
            if q.name == "box" and box_label:
                item["instructions"] += f" 현재 확인할 후보는 '{box_label}'이다."
            if q.name == "confirm" and cancel_confirmation:
                item["instructions"] = (
                    "직전 AI의 취소 확인 질문에 대한 답만 판단한다. '네, 취소해 주세요'는 yes, "
                    "취소하지 말라는 답은 no, 다른 택배나 범위로 바꾸면 change, 그 밖은 not_answer다.")
            if q.name == "switch" and stage_id in ("inquiry", "lookup", "cancel", "agent"):
                item["instructions"] += " 직전 AI가 추가 도움이 필요한지 물었고 고객이 추가 도움이 없다고 답하면 end다."
            if q.type == "choice":
                item["choices"] = [{"value": c} for c in q.choices]
                if q.name == "switch" and cancel_current:
                    item["choices"].append({"value": "cancel_current"})
                    item["instructions"] += (" 고객이 지금 정보를 받는 중인 택배만 빼 달라고 명확히 말하면 cancel_current. "
                                             "이미 담은 다른 택배를 취소하거나 대상이 불분명하면 cancel을 고른다.")
                if q.name == "switch" and cancel_selected:
                    item["choices"].append({"value": "cancel_selected"})
                    item["instructions"] += (" 방금 조회·선택한 택배 한 건을 '그거 취소해 주세요'처럼 가리키면 cancel_selected. "
                                             "새 이름, 다른 택배 또는 다른 통화 범위를 지정하면 cancel.")
                if q.name == "switch" and cancel_selected_order:
                    item["choices"].append({"value": "cancel_selected_order"})
                    item["instructions"] += (" 방금 선택한 택배가 속한 기존 주문의 모든 택배를 취소하라고 "
                                             "명시한 경우에만 cancel_selected_order.")
                if q.name == "switch" and cancel_confirmation:
                    item["instructions"] += " 취소 확인 질문에 동의하거나 거절하는 답은 none이다."
            out.append(item)
    if pick_labels:
        instructions = "직전 AI 발화가 후보 중 하나를 고르라고 했고 고객이 골랐으면 그 후보를, 모두 아니라고 하면 none, 답이 아니면 not_answer."
        changes = destination_changes(destination_candidates)
        clarifications = ()
        if changes:
            clarifications = ("clarify_recipient", "clarify_address") if len(pick_labels) == 1 else ("clarify_candidate",)
            instructions += (
                " 받는 곳 후보는 사람과 주소를 구분한다. 사람과 주소를 모두 그대로 쓸 때만 후보 이름표를 직접 고른다. "
                "고객 표현이 달라도 어떤 정보를 유지하겠다는 뜻인지 판정한다. "
                "'그분 맞고 주소만 바꿀게요', '같은 사람인데 딴 데로요'는 아래 주소 변경 선택지, "
                "'주소는 맞고 받는 분만 바꿀게요'는 아래 받는 분 변경 선택지다. "
                "새 주소나 새 성함을 같은 답에서 말해도 그대로 둘 항목이 명확하면 해당 변경 선택지를 고른다. "
                "사람과 주소를 모두 바꾸거나 후보와 무관한 새 배송지라고 하면 none이다. "
                "후보가 한 명이고 '다른 주소예요'만으로 같은 사람인지 불분명하면 clarify_recipient, "
                "'다른 사람이에요'만으로 같은 주소인지 불분명하면 clarify_address다. "
                "후보가 여럿이고 어느 후보의 정보를 유지할지 불분명하면 clarify_candidate다. "
                "조회·취소·종료나 다른 질문의 답은 not_answer다. 변경 선택지: "
                + " / ".join(f"{key} = '{pick_labels[index]}'의 {'주소만' if change == 'address' else '받는 분만'} 변경"
                             for key, (index, change) in changes.items())
            )
            if destination_candidates.destination_clarification == "recipient":
                instructions += " 지금은 주소가 다르다는 답을 받아 받는 분만 확인 중이다. 그 질문에 동의하면 new_address_1, 거절하면 none이다."
            elif destination_candidates.destination_clarification == "address":
                instructions += " 지금은 받는 분이 다르다는 답을 받아 주소만 확인 중이다. 그 질문에 동의하면 new_recipient_1, 거절하면 none이다."
        out.append({"type": "choice", "name": "pick", "instructions": instructions,
                    "choices": [{"value": v} for v in (*pick_labels, *changes, *clarifications, "none", "not_answer")]})
    return out
