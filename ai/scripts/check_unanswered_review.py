"""가상 통화로 실제 종료 검토 모델을 평가한다. 백엔드·RAG·전화에는 요청하지 않는다."""

import argparse
import asyncio
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from openai import AsyncOpenAI

from app.calls.unanswered import UnansweredReviewer, apply_review
from app.config import load_server_config, prompts_dir


def utter(speaker, text, t):
    return {"speaker": speaker, "text": text, "t": t}


def search(t, question, status="ok"):
    return {"at": t, "arguments": json.dumps({"question": question}, ensure_ascii=False),
            "output": {"status": status, "code": "KB_UNAVAILABLE" if status == "unavailable" else None,
                       "facts": {"answerable": status == "ok"}}}


def cases():
    q = "기사님 성별을 지정할 수 있나요?"
    refusal = "기사님 성별 지정 가능 여부는 확인할 수 없습니다. 확인 후 안내드리겠습니다."
    for status, reason in [("ok", "KB_NO_ANSWER"), ("unavailable", "KB_UNAVAILABLE")]:
        yield {"id": reason, "transcript": [utter("customer", q, 1001), utter("agent", refusal, 1003)],
               "searches": [search(1002, q, status)], "expected": {"unanswered": [reason], "answered": 0}}
    q = "착불로 보낼 수 있나요?"
    answer = "착불은 불가하고 선결제 주문만 발송할 수 있습니다."
    yield {"id": "negative_but_answered", "transcript": [utter("customer", q, 1001), utter("agent", answer, 1003)],
           "searches": [search(1002, q)], "expected": {"unanswered": [], "answered": 1}}
    yield {"id": "resolved_after_failure", "transcript": [
        utter("customer", q, 1001), utter("agent", "지금 확인이 어렵습니다. 다시 확인하겠습니다.", 1003),
        utter("customer", "한번 더 확인해 주세요.", 1004), utter("agent", answer, 1006)],
        "searches": [search(1002, q, "unavailable"), search(1005, q)],
        "expected": {"unanswered": [], "answered": 1}}
    yield {"id": "checking_then_answered", "transcript": [
        utter("customer", q, 1001), utter("agent", "잠시 확인해 보겠습니다.", 1003), utter("agent", answer, 1005)],
        "searches": [search(1002, q)], "expected": {"unanswered": [], "answered": 1}}
    yield {"id": "clarification", "transcript": [
        utter("customer", "거기는 언제까지 열어요?", 1001), utter("agent", "어느 지점을 말씀하시나요?", 1003)],
        "searches": [search(1002, "지점 이용 시간")], "expected": {"unanswered": [], "answered": 0}}
    yield {"id": "checking_only", "transcript": [
        utter("customer", q, 1001), utter("agent", "잠시 확인해 보겠습니다.", 1003)],
        "searches": [search(1002, q)], "expected": {"unanswered": [], "answered": 0}}
    yield {"id": "two_inquiries", "transcript": [
        utter("customer", q, 1001), utter("agent", answer, 1003),
        utter("customer", "기사님 성별을 지정할 수 있나요?", 1004), utter("agent", refusal, 1006)],
        "searches": [search(1002, q), search(1005, "기사님 성별 지정")],
        "expected": {"unanswered": ["KB_NO_ANSWER"], "answered": 1}}


async def evaluate(model: str, output: Path) -> bool:
    cfg = load_server_config().unanswered_review
    results = []
    async with AsyncOpenAI() as client:
        reviewer = UnansweredReviewer(client, model, (prompts_dir() / "unanswered_review.md").read_text(encoding="utf-8"),
                                      timeout_sec=cfg.timeout_sec, max_input_chars=cfg.max_input_chars,
                                      max_output_tokens=cfg.max_output_tokens)
        for case in cases():
            evidence = {k: case[k] for k in ("transcript", "searches")}
            row = {"id": case["id"], "expected": case["expected"], "evidence": evidence}
            started = time.perf_counter()
            try:
                verdict = await reviewer.review(evidence)
                payload = apply_review(case["id"], 1000, evidence, {"analysis": {}}, verdict)
                actual = {"unanswered": sorted(u["reason"] for u in payload["unanswered"]),
                          "answered": payload["analysis"]["faqAnswerCount"]}
                row.update(verdict=verdict, actual=actual, passed=actual == case["expected"])
            except Exception as e:
                # 평가 실행기는 실패를 결과로 남긴다. 예외 본문에 인증 정보가 섞이지 않게 종류만 기록한다.
                row.update(passed=False, error=type(e).__name__)
            row["seconds"] = round(time.perf_counter() - started, 3)
            results.append(row)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps({"model": model, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"{case['id']}: {'PASS' if row['passed'] else 'FAIL'} / {row['seconds']}s", flush=True)
    passed = sum(r["passed"] for r in results)
    print(f"{passed}/{len(results)} passed; results: {output}")
    return passed == len(results)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model", default=os.environ.get("BACKEND_MODEL"))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    p.add_argument("--output", type=Path, default=Path("output") / "unanswered-review" / f"{stamp}.json")
    args = p.parse_args()
    if not args.model:
        p.error("BACKEND_MODEL 또는 --model이 필요합니다.")
    raise SystemExit(0 if asyncio.run(evaluate(args.model, args.output)) else 1)


if __name__ == "__main__":
    main()
