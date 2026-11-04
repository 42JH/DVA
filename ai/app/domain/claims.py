"""결과 문구 검사(delegation.md §6.2-5, workflow-policy.md 층 5). LLM 없이 정책 문구와 서버 상태를 대조한다.

AI 발화 하나(발화 끝에 묶은 출력 전사)에 고위험 업무 결과 문구가 있는데 서버 상태에 그 결과가 없으면 N3 대상이다.
문장 단위로 보고, 정책 claim_skip(부정·미래·물음 표지)이 있는 문장은 단정이 아니라고 본다.
shortcut: 표지 목록 기반 — 실통화 사례가 쌓이면 목록을 조정한다(S5: "접수 완료 결과는 확인되지 않았습니다" 오탐).
"""

import re

from app.domain.state import ConversationState
from app.policy.model import Policy


def _holds(state: ConversationState, condition: str) -> bool:
    return {"result_accepted": state.result_accepted, "cancel_done": state.cancel_done,
            "no_pending": state.pending is None, "never": False}[condition]


def unverified_claims(text: str, state: ConversationState, policy: Policy) -> list[str]:
    """걸린 문구(정책에 적힌 첫 형태). 띄어쓰기는 무시한다."""
    sentences = [x for x in re.split(r"[.?!…\n]+", text) if x.strip()]
    skip = policy.forbid.claim_skip
    out = []
    for claim in policy.forbid.claims:
        if _holds(state, claim.unless):
            continue
        for sentence in sentences:
            squeezed = "".join(sentence.split())
            if any("".join(p.split()) in squeezed for p in claim.phrases) and                     not (claim.use_skip and any(w in sentence for w in skip)):
                out.append(claim.phrases[0])
                break
    return out


def truth(state: ConversationState) -> dict:
    """N3에 붙이는 사실(무엇이 맞는지). 서버 상태에서만."""
    return {"parcels_added": len(state.parcels), "order_submitted": state.result_accepted,
            "cancel_done": state.cancel_done, "submit_when": "더 보낼 택배가 없다고 확인되면 서버가 접수한다(그 전까지 담은 택배는 고칠 수 있다)",
            "awaiting_confirmation": state.pending is not None}
