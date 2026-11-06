"""전화 접수 물품 판정. 정책과 고객 발화만 사용하며 외부 조회를 하지 않는다."""

import re
from dataclasses import dataclass

from app.policy.model import ParcelItems


@dataclass(frozen=True)
class ItemIssue:
    code: str
    guidance: str


def mentions(policy: ParcelItems, text: str) -> list[str]:
    text = re.sub(r"현금(?:으로(?:는)?)?\s*(?:결제|납부)", "", text)
    heard = re.sub(r"\s+", "", text)
    return [key for key, rule in policy.rules.items()
            if any(re.sub(r"\s+", "", term) in heard for term in rule.terms)]


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


def mention_issue(policy: ParcelItems, key: str) -> ItemIssue:
    return ItemIssue("ITEM_MENTION_UNCLEAR", policy.rules[key].guidance)


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
    return {key: mention_issue(policy, key) for key in mentions(policy, text)} | size_issues(policy, measurements(text))
