"""통화 기록의 Decision 입력을 재생해 value(이 발화에 새 접수 값이 있는가) 답만 얻는다(S0c와 같은 재생 방식).

실통화를 며칠 모을 시간이 없을 때 쓴다: 기록된 Decision 이벤트의 입력(직전 AI 발화 + 고객 발화)과 단계를 그대로 넣고
현재 정책의 질문 세트(value 포함)로 POST /v1/decisions를 1회씩 부른다. 결과는 원본 기록에 answers.value를 끼운 사본으로
저장하고, 집계는 scripts/delegation_shadow.py가 한다. OPENAI_API_KEY가 있는 곳(운영 AI 컨테이너)에서 돌린다.

사용: PYTHONPATH=/app python -X utf8 scripts/replay_decision_value.py --calls /app/logs/calls --since <epoch> \
        --policy /tmp/replay/workflow.toml --out /tmp/replay/out [--concurrency 4]
"""

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

from openai import AsyncOpenAI

from app.policy.model import load_policy
from app.policy.render import decision_questions


def questions_for(policy, data: dict) -> list[dict]:
    """기록된 답 이름으로 당시 질문 세트를 복원하고 value를 더한다(pick 후보 이름표는 복원 불가 → 생략)."""
    asked = set((data.get("answers") or {}).keys())
    return decision_questions(policy, data.get("stage") or "intent", pending="confirm" in asked,
                              callback="callback" in asked, origin="origin" in asked,
                              box_label="박스 후보" if "box" in asked else None)


async def replay_call(client, policy, record: dict, sem: asyncio.Semaphore, stats: dict) -> dict:
    async def one(e: dict):
        d = e.get("data") or {}
        if e.get("kind") != "Decision" or not d.get("input") or "answers" not in d:
            return
        qs = questions_for(policy, d)
        if not any(q["name"] == "value" for q in qs):
            return
        async with sem:
            t0 = time.monotonic()
            try:
                r = await asyncio.wait_for(client.decisions.create(model="gpt-6-luna", input=d["input"], questions=qs), 15)
            except Exception as ex:  # 재생 실패는 그 발화만 건너뛴다(집계에서 빠짐)
                stats["failed"] += 1
                d["value_replay_error"] = type(ex).__name__
                return
            ms = round((time.monotonic() - t0) * 1000)
        a = next((x for x in r.answers if x.type == "choice" and x.name == "value"), None)
        if a is None:
            stats["failed"] += 1
            return
        d["answers"]["value"] = {"choice": str(a.choice), "confidence": round(float(a.confidence or 0), 3),
                                 "probabilities": {str(p.value): p.probability for p in (a.probabilities or [])},
                                 "replayed_ms": ms}
        stats["replayed"] += 1
        stats["ms"].append(ms)

    await asyncio.gather(*(one(e) for e in record.get("events") or []))
    return record


async def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--calls", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--policy", default=None)
    ap.add_argument("--since", type=float, default=0.0, help="snapshot.started_at(epoch) 이후 기록만")
    ap.add_argument("--concurrency", type=int, default=4)
    a = ap.parse_args(argv)
    policy = load_policy(Path(a.policy) if a.policy else None)
    client = AsyncOpenAI()
    sem = asyncio.Semaphore(a.concurrency)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stats = {"calls": 0, "replayed": 0, "failed": 0, "ms": []}
    for path in sorted(Path(a.calls).glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if (record.get("snapshot") or {}).get("started_at", 0) < a.since:
            continue
        stats["calls"] += 1
        record = await replay_call(client, policy, record, sem, stats)
        (out / path.name).write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    ms = sorted(stats.pop("ms"))
    stats["decision_ms_p50"] = ms[len(ms) // 2] if ms else None
    stats["decision_ms_p90"] = ms[int(len(ms) * 0.9)] if ms else None
    print(json.dumps(stats, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
