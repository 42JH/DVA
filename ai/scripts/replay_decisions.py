"""통화 기록의 Decision 발화를 기존 입력·지침과 새 입력·지침으로 다시 돌려 비교한다(decision-input-plan.md §4-1·§5).

통화 기록에는 상태가 없어 열린 질문은 그때 물은 질문 이름(answers)·단계·직전 서버 결과로 추정한다(부록 B).
새 입력의 최근 AI 발화·이어 붙인 고객 발화도 전사 시작 시각만으로 근사한다. 실제 통화의 입력은 app/calls/decision_input.py가 만든다.

  uv run python -m scripts.replay_decisions extract --calls <통화 기록 폴더> --out rows.jsonl
  uv run python -m scripts.replay_decisions run --rows rows.jsonl --old-policy <기존 workflow.toml> --out results.jsonl \
      [--labels evaluation/datasets/decision_v1.json]     # 정답 표에 있는 발화만 돌린다. OPENAI_API_KEY 필요
  uv run python -m scripts.replay_decisions score --results results.jsonl --labels evaluation/datasets/decision_v1.json
"""

import argparse
import asyncio
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

from app.calls import decision_input
from app.calls.turn import ACTION_CONFIDENCE, EXITS
from app.config import CallConfig
from app.domain.confirm import asks
from app.policy.model import load_policy
from app.policy.render import decision_questions

NEUTRAL = ("none", "not_answer", "chit_chat", "unclear", "other")
JOIN_SEC, LOOKBACK_SEC = 5.0, 30.0   # 전사에는 발화 끝 시각이 없어 시작 시각 차이로 본다


def _facts(record: dict, before: float) -> list[tuple[float, dict]]:
    """before 이전에 서버가 Live에 준 결과(도구 출력·전달)를 시간순으로."""
    rows = [(c["done_at"], c["output"]) for c in record.get("tool_calls") or []
            if c.get("done_at") and isinstance(c.get("output"), dict)]
    rows += [(e["at"], e["data"]["content"]) for e in record.get("events") or []
             if e["kind"].startswith("전달") and isinstance((e.get("data") or {}).get("content"), dict)]
    return sorted((row for row in rows if row[0] < before), key=lambda row: row[0])


def _open_question(asked: list[str], data: dict, facts: list[tuple[float, dict]], since: float) -> tuple[str | None, str]:
    """(종류, 문구) 추정. 문구는 decision_input.open_question과 같은 것을 쓴다."""
    stage = data.get("stage")
    summary = next(({**f.get("summary", {}), **f} for _, f in reversed(facts) if "missing" in f or "summary" in f), {})
    recent = [f for at, f in facts if at >= since]
    labels = [k for k in (data.get("answers", {}).get("pick", {}).get("probabilities") or {})
              if k not in ("none", "not_answer")]
    if any(f.get("end_confirmation") for f in recent):
        return "end", "통화 종료 여부(yes=통화 종료)"
    if "callback" in asked:
        return "callback", "담당자 연락 동의(yes=연락 받음)"
    if "confirm" in asked and stage in ("cancel", "lookup"):
        return "cancel", "취소 대상 확인(yes=취소 진행)"
    if "pick" in asked and labels:
        what = ("조회한 택배 선택" if stage in ("cancel", "lookup") else
                "고칠 택배 선택" if any(f.get("edit_parcel") == "choose" for _, f in facts[-3:]) else "받는 곳 후보 선택")
        return "pick", f"{what}: {', '.join(labels)}"
    if stage == "intent":
        if "origin" in asked:
            return "greeting", "첫 인사: 택배 접수 시작과 안내한 발송 주소 사용 여부(yes=접수 시작, 안내한 주소에서 발송)"
        return "greeting", "첫 인사: 택배 접수 시작 여부(yes=접수 시작)"
    if summary.get("sender_change_next") == "ask_name_save":
        return "name_save", "등록 이름도 바꿀지(yes=등록 이름 변경, no=이번 택배만)"
    if summary.get("sender_change_next") == "ask_address_change":
        return "address_change", "발송 주소도 바꿀지(yes=새 주소로 바꿈, no=등록 주소 그대로)"
    if summary.get("sender_change_next"):
        return None, ""
    if "origin" in asked and (summary.get("origin_confirm") or any("origin_confirm" in f for f in recent)):
        return "origin", "등록된 발송 주소 사용 여부(yes=등록 주소 사용, no=다른 주소에서 발송)"
    if "box" in asked:
        label = next((f["box_proposal"]["label"] for _, f in reversed(facts)
                      if isinstance(f.get("box_proposal"), dict)), "박스 후보")
        return "box", f"박스 후보 확인: {label}(yes=이 크기·개수로 기록)"
    if "confirm" in asked:
        return "readback", "되읽은 접수 내용 확인(yes=이대로 접수, change=내용 고침)"
    if stage == "more_parcels":
        return "more", "추가로 보낼 택배 여부(yes=더 있음)"
    return None, ""


def extract(calls: Path, policy) -> list[dict]:
    rows = []
    for path in sorted(calls.glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        transcript = record.get("transcript") or []
        for event in record.get("events") or []:
            data = event.get("data") or {}
            if event.get("kind") != "Decision" or "\n고객 발화: " not in (data.get("input") or ""):
                continue
            asked = list(data.get("answers") or {}) or list(data.get("questions") or [])
            said = data["input"].split("\n고객 발화: ", 1)[1].strip()
            at = next((i for i in range(len(transcript) - 1, -1, -1) if transcript[i]["speaker"] == "customer"
                       and transcript[i]["t"] <= event["at"] and transcript[i]["text"].strip() == said), None)
            if at is None or not asked:
                continue
            first = at  # 사이에 AI 발화 없이 곧 이어진 앞 조각을 붙인다
            if at and transcript[at - 1]["speaker"] == "customer" and transcript[at]["t"] - transcript[at - 1]["t"] <= JOIN_SEC:
                first = at - 1
            before = next((i for i in range(first - 1, -1, -1) if transcript[i]["speaker"] == "customer"), -1)
            chunks = [r["text"].strip() for r in transcript[before + 1:first]]
            if not any(asks(text) for text in chunks):
                chunks = [r["text"].strip() for r in transcript[:before + 1] if r["speaker"] == "agent" and asks(r["text"])
                          and transcript[first]["t"] - r["t"] <= LOOKBACK_SEC][-1:] + chunks
            ai_text = " ".join(chunks)
            if len(ai_text) > decision_input.RECENT_AI_MAX:
                ai_text = "…" + ai_text[-decision_input.RECENT_AI_MAX:]
            facts = _facts(record, transcript[at]["t"])
            kind, line = _open_question(asked, data, facts, transcript[before]["t"] if before >= 0 else 0.0)
            summary = next(({**f.get("summary", {}), **f} for _, f in reversed(facts) if "missing" in f or "summary" in f), {})
            item = next(iter(summary.get("missing") or []), None) if data.get("stage") not in ("intent", "lookup", "cancel", "inquiry") else None
            lines = [decision_input.RULES, "", f"열린 질문: {line or '없음'}"]
            if not kind and item in policy.fields:
                lines.append(f"지금 받는 항목: {policy.fields[item].label}")
            lines += [f"최근 AI 발화: {ai_text or '(없음)'}",
                      f"고객 발화: {' '.join(r['text'].strip() for r in transcript[first:at + 1])}"]
            sender_stage = kind in ("greeting", "origin", "address_change")
            rows.append({
                "key": f"{path.stem[:8]}#{transcript[at]['id']}", "at": event["at"], "stage": data.get("stage"),
                "kind": kind, "asked": asked, "old_input": data["input"], "new_input": "\n".join(lines),
                "recorded": data.get("answers"), "pick_labels": [
                    k for k in ((data.get("answers") or {}).get("pick", {}).get("probabilities") or {})
                    if k not in ("none", "not_answer")],
                "new_flags": {"pending": kind in ("readback", "cancel"), "callback": kind == "callback",
                              "origin": kind in ("origin", "address_change") or kind == "greeting" and "origin" in asked,
                              "sender_change": sender_stage and "sender_change" in asked,
                              "sender_name_scope": "sender_name_scope" in asked and (
                                  sender_stage or kind == "name_save" or item == "sender_name" or data.get("stage") == "sender")},
                "box": kind == "box"})
    return rows


def _questions(policy, row: dict, new: bool) -> list[dict]:
    asked = row["asked"]
    flags = row["new_flags"] if new else {
        "pending": "confirm" in asked, "callback": "callback" in asked, "origin": "origin" in asked,
        "sender_change": "sender_change" in asked, "sender_name_scope": "sender_name_scope" in asked}
    pick = tuple(row["pick_labels"]) if "pick" in asked else ()
    box = "box" in asked if not new else row["box"]
    return decision_questions(policy, row["stage"] or "intent", pick_labels=pick,
                              box_label="박스 후보" if box else None, **flags)


async def _ask(client, text: str, questions: list[dict]) -> dict:
    started = time.monotonic()
    response = await asyncio.wait_for(client.decisions.create(model="gpt-6-luna", input=text, questions=questions), 20)
    return {"ms": round((time.monotonic() - started) * 1000), "chars": len(text), "answers": {
        a.name: {"choice": str(a.choice), "confidence": round(float(a.confidence or 0), 3),
                 "probabilities": {str(p.value): p.probability for p in (a.probabilities or [])}}
        for a in response.answers if a.type == "choice"}}


async def run(rows: list[dict], old_policy, new_policy, out: Path, concurrency: int) -> None:
    from openai import AsyncOpenAI
    client, gate = AsyncOpenAI(), asyncio.Semaphore(concurrency)

    async def one(row: dict) -> dict:
        async with gate:
            for name, text, policy, new in (("old", row["old_input"], old_policy, False),
                                            ("new", row["new_input"], new_policy, True)):
                questions = _questions(policy, row, new)
                try:
                    row[name] = await _ask(client, text, questions) if questions else {"answers": {}}
                except Exception as exc:  # 재생 실패는 그 발화만 표시하고 집계에서 뺀다
                    row[name] = {"error": type(exc).__name__}
        return row

    done = await asyncio.gather(*(one(row) for row in rows))
    out.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in done), encoding="utf-8")


def passes_new(name: str, answer: dict, kind: str | None, cfg: CallConfig) -> bool:
    """app/calls/turn.py TurnPipeline._passes와 같은 기준."""
    choice, probabilities = answer["choice"], answer["probabilities"]
    p = probabilities.get(choice, answer["confidence"])
    if name == "pick":
        return p >= ACTION_CONFIDENCE
    if name in decision_input.ANSWERED_BY.get(kind, ()) and not (name == "task" and choice in ("end", "agent")):
        second = max((v for k, v in probabilities.items() if k != choice), default=0.0)
        return p >= cfg.decision_open_min_p and p - second >= cfg.decision_open_margin
    if name in ("switch", "task") and choice in EXITS and not (name == "task" and choice == "cancel"):
        return p >= cfg.decision_exit_min_p
    if name == "switch":
        return p >= cfg.decision_switch_min_p
    return p >= ACTION_CONFIDENCE


def score(results: list[dict], labels: dict, cfg: CallConfig, yes_min: float) -> dict:
    """질문별 정확도·적용된 오판·놓친 답. 기존 = 기존 입력·지침에 confidence 하한, 새 = 새 입력·지침에 확률 하한."""
    table = defaultdict(lambda: defaultdict(int))
    wrong = []
    for row in results:
        expected = {k: v for k, v in (labels.get(row["key"]) or {}).items() if k != "note"}
        if not expected or "error" in row.get("old", {}) or "error" in row.get("new", {}):
            continue
        for side in ("old", "new"):
            for name, want in expected.items():
                answer = row[side]["answers"].get(name)
                choice = answer["choice"] if answer else None
                if answer and name == "confirm" and choice in ("yes", "proceed"):
                    # 접수 확인의 동의는 두 쪽 모두 확인 관문(G4)이 선택지 확률로 본다.
                    applied = answer["probabilities"].get(choice, 0.0) >= yes_min
                else:
                    applied = bool(answer) and (passes_new(name, answer, row["kind"], cfg) if side == "new"
                                                else answer["confidence"] >= ACTION_CONFIDENCE)
                wants = want if isinstance(want, list) else [want]  # 정답이 여럿이면 그중 하나, pick은 후보 순번(#n)
                if side == "old" and name == "origin" and row["kind"] == "address_change":
                    # 정답 표는 열린 질문의 뜻(yes=주소를 바꿈)으로 적는다. 기존 지침에서는 그 반대였다.
                    wants = [{"yes": "no", "no": "yes"}.get(w, w) for w in wants]
                wants = [row["pick_labels"][int(w[1:]) - 1] if name == "pick" and w.startswith("#") else w for w in wants]
                right = choice in wants or choice is None and wants[0] in NEUTRAL
                cell = table[f"{name}:{side}"]
                cell["n"] += 1
                # 묻지 않은 질문은 아무것도 적용하지 않는다: 정답이 '해당 없음'이면 맞은 것으로 센다.
                cell["correct"] += right
                harmful = applied and not right and choice not in NEUTRAL
                cell["applied_wrong"] += harmful
                cell["missed"] += wants[0] not in NEUTRAL and not (applied and right)
                if harmful or side == "new" and not right:
                    p = answer["probabilities"].get(choice, 0) if answer else 0
                    wrong.append({"key": row["key"], "side": side, "question": name, "want": want,
                                  "got": choice if name != "pick" or choice in NEUTRAL else "(다른 후보)",
                                  "p": round(p, 2), "applied": applied})
        for side in ("old", "new"):
            if "ms" in row[side]:
                table[f"_latency:{side}"]["ms"] += row[side]["ms"]
                table[f"_latency:{side}"]["chars"] += row[side]["chars"]
                table[f"_latency:{side}"]["n"] += 1
    return {"table": {k: dict(v) for k, v in sorted(table.items())}, "wrong": wrong}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("extract", "run", "score"))
    parser.add_argument("--calls")
    parser.add_argument("--rows")
    parser.add_argument("--results")
    parser.add_argument("--labels")
    parser.add_argument("--old-policy")
    parser.add_argument("--out")
    parser.add_argument("--concurrency", type=int, default=6)
    a = parser.parse_args(argv)
    policy = load_policy()
    read = lambda path: [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line]  # noqa: E731
    labels = json.loads(Path(a.labels).read_text(encoding="utf-8")) if a.labels else None
    if a.command == "extract":
        rows = extract(Path(a.calls), policy)
        Path(a.out).write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows), encoding="utf-8")
        print(len(rows))
    elif a.command == "run":
        rows = [row for row in read(a.rows) if labels is None or row["key"] in labels]
        asyncio.run(run(rows, load_policy(Path(a.old_policy)), policy, Path(a.out), a.concurrency))
        print(len(rows))
    else:
        print(json.dumps(score(read(a.results), labels, CallConfig(), policy.confirm.yes_min), ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
