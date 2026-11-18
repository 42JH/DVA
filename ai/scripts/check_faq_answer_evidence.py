"""공개 내용의 가상 통화로 FAQ 근거 판정을 검증한다. 백엔드에는 전송하지 않는다."""

import argparse
import asyncio
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from openai import AsyncOpenAI

from app.calls.unanswered import ReviewError, UnansweredReviewer, apply_review
from app.config import load_server_config, prompts_dir

DEFAULT_DATASET = Path(__file__).resolve().parents[1] / "evaluation/datasets/faq_evidence_v1.json"


def utterance_payload(case):
    events = []
    for row in case["evidence"]["transcript"]:
        if not row["text"].strip():
            continue
        order = len(events) + 1
        events.append({"eventId": str(uuid.uuid5(uuid.NAMESPACE_URL, f"{case['id']}:{order}")),
                       "eventOrder": order, "kind": "UTTERANCE", "payload": {
                           "utteranceOrder": order, "speaker": "CUSTOMER" if row["speaker"] == "customer" else "AI",
                           "utteranceText": row["text"][:20000], "lastSentenceSeq": 1}})
    return {"events": events, "analysis": {}}


async def evaluate(model, dataset, output):
    cases = json.loads(dataset.read_text(encoding="utf-8"))["cases"]
    cfg = load_server_config().unanswered_review
    rows = []
    async with AsyncOpenAI() as client:
        judge = UnansweredReviewer(client, model, (prompts_dir() / "unanswered_review.md").read_text(encoding="utf-8"),
                                   timeout_sec=cfg.timeout_sec, max_input_chars=cfg.max_input_chars,
                                   max_output_tokens=cfg.max_output_tokens)
        for case in cases:
            started = time.perf_counter()
            row = {"id": case["id"], "evidence": case["evidence"], "expected": case["expected"]}
            try:
                result = await judge.review(case["evidence"])
                prepared = apply_review(case["id"], 1000, case["evidence"], utterance_payload(case), result,
                                        faq_answered_enabled=True)
                answers = [e for e in prepared["events"] if e["payload"].get("action") == "FAQ_ANSWERED"]
                actual = {"faq_arrays": sorted(e["payload"]["faqEntrySeqs"] for e in answers),
                          "unanswered_reasons": sorted(u["reason"] for u in prepared["unanswered"])}
                row.update(result=result, faq_events=answers, actual=actual, passed=actual == case["expected"])
            except Exception as e:
                # 평가 실행기: 실패를 숨기지 않고 남기며 외부 예외 본문·인증값은 출력하지 않는다.
                row.update(passed=False, error=str(e) if isinstance(e, ReviewError) else type(e).__name__)
            row["seconds"] = round(time.perf_counter() - started, 3)
            rows.append(row)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps({"model": model, "dataset": str(dataset), "results": rows},
                                         ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"{case['id']}: {'PASS' if row['passed'] else 'FAIL'} / {row['seconds']}s", flush=True)
    passed = sum(r["passed"] for r in rows)
    print(f"{passed}/{len(rows)} passed; results: {output}")
    return passed == len(rows)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model", default=os.environ.get("BACKEND_MODEL"))
    p.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    p.add_argument("--output", type=Path, default=Path("output/faq-evidence") / f"{stamp}.json")
    args = p.parse_args()
    if not args.model:
        p.error("BACKEND_MODEL 또는 --model이 필요합니다.")
    raise SystemExit(0 if asyncio.run(evaluate(args.model, args.dataset, args.output)) else 1)


if __name__ == "__main__":
    main()
