"""전화 접수 물품 판정. 정책과 고객 발화만 사용하며 외부 조회를 하지 않는다."""

import re
from dataclasses import dataclass

from app.policy.model import ItemRestriction, ParcelItems


@dataclass(frozen=True)
class ItemIssue:
    code: str
    guidance: str
    utterance_id: int | None = None


def mentions(policy: ParcelItems, text: str) -> list[str]:
    text = re.sub(r"현금(?:으로(?:는)?)?\s*(?:결제|납부)", "", text)
    heard = _compact(text)
    return [key for key, rule in policy.rules.items() if _matches(rule, _without_exclusions(rule, heard))]


def _compact(text: str) -> str:
    return "".join(text.split())


def _without_exclusions(rule: ItemRestriction, text: str) -> str:
    for term in rule.excluded_terms:
        if compact := _compact(term):
            text = text.replace(compact, " ")
    return text


def _matches(rule: ItemRestriction, text: str) -> bool:
    return any(_compact(term) in text for term in rule.terms)


def excluded_evidence(rule: ItemRestriction, quote: str, text: str) -> bool:
    """제외 단어만 근거로 낸 분류를 막고, 함께 언급된 제한 품목은 유지한다."""
    if not rule.excluded_terms:
        return False
    quote, heard = _compact(quote), _compact(text)
    remainder = _without_exclusions(rule, quote)
    if remainder != quote:
        return not _matches(rule, remainder)
    return quote in heard and quote not in _without_exclusions(rule, heard)


def contextual_keyword(rule: ItemRestriction, quote: str) -> bool:
    """문맥 제외는 실제 단어가 포함된 구절에만 적용한다. 금지 단어 자체는 남긴다."""
    quote = _compact(quote)
    keywords = sorted({_compact(term) for term in rule.terms} - {""}, key=len, reverse=True)
    if not keywords:
        return False
    pattern = "|".join(map(re.escape, keywords))
    return len(re.findall(pattern, quote)) == 1 and not re.fullmatch(
        rf"(?:{pattern})(?:은|는|이|가|을|를|도|만|요)?", quote)


def supported_box_correction(quote: str) -> bool:
    """포장 정정은 박스 포장이나 규격을 답한 구절을 근거로 받는다."""
    quote = _compact(quote).rstrip(".,!?")
    if re.search(r"(?:안|못)(?:들어|넣|담|포장)|않|없이|수없|박스(?:가|는)?아니", quote):
        return False
    return bool(re.fullmatch(r"(?:소형|중형|대형)(?:이?요|입니다)?", quote)
                or re.search(r"(?:소형|중형|대형|[소중대])박스|박스(?:에|로)|규격에맞(?:게|춰)포장", quote))


def measurements(text: str) -> dict[str, float]:
    sizes: dict[str, float] = {}
    for amount, unit in re.findall(r"(\d+(?:\.\d+)?)\s*(센티미터|센티|cm|미터|m|킬로그램|킬로|kg)(?![a-z])",
                                   text.lower()):
        value = float(amount)
        if unit in ("킬로그램", "킬로", "kg"):
            sizes["weight_kg"] = max(sizes.get("weight_kg", 0), value)
        elif re.search(r"한\s*변|가로|세로|높이|길이", text) and not re.search(r"세\s*변.*합", text):
            side = value * 100 if unit in ("미터", "m") else value
            sizes["side_cm"] = max(sizes.get("side_cm", 0), side)
    return sizes


def mention_issue() -> ItemIssue:
    return ItemIssue("ITEM_MENTION_UNCLEAR", "제한 품목 자체를 함께 보낸다는 뜻인지 확인해 주세요.")


def size_issues(policy: ParcelItems, sizes: dict[str, float]) -> dict[str, ItemIssue]:
    limits = {"side_cm": (policy.max_side_cm, "한 변", "cm"),
              "weight_kg": (policy.max_weight_kg, "무게", "kg")}
    return {key: ItemIssue("ITEM_SIZE_EXCEEDED", f"{label} {limit}{unit}을 넘으면 접수할 수 없습니다.")
            for key, (limit, label, unit) in limits.items() if sizes.get(key, 0) > limit}


def unclassified_mentions(policy: ParcelItems, text: str) -> dict[str, ItemIssue]:
    # 가능 여부만 묻는 발화는 현재 택배의 내용물로 취급하지 않는다.
    if (re.search(r"(?:보내도|보낼 수|접수|배송|가능).{0,16}(?:되나요|있나요|있어요\?|될까요|인가요|한가요|해요\?)|돼요\?\s*$", text)
            and not re.search(r"넣었|담았|들어\s*있|포장했", text)):
        return {}
    return dict.fromkeys(mentions(policy, text), mention_issue()) | size_issues(policy, measurements(text))
