"""그림자 측정(2026-11-10 1단계): Decision의 value(이 발화에 새 접수 값이 있는가)와 Live의 실제 위임을 통화 기록으로 대조한다.

서버는 아직 아무것도 바꾸지 않는다. 이 수치로 "서버가 발화 끝에 백엔드를 직접 불렀다면" 얼마나 맞았을지 본다.
  - 구제: value=yes인데 Live 위임이 없던 발화(지금 누락되는 값 발화)
  - 헛 호출: value=yes인데 위임도 없고 실제 값도 아닌 발화 → 목록을 사람이 보고 가린다
  - 놓침: value=no인데 Live가 위임한 발화(거름망이 빠뜨릴 발화)

사용: python -X utf8 -m scripts.delegation_shadow <통화 기록 JSON 폴더> [--gap-ms 800] [--min-confidence 0.6]
      python -X utf8 -m scripts.delegation_shadow --selftest
입력: 운영 서버 ai_logs 볼륨의 calls/{trace_id}.json(events·transcript·tool_calls). value 질문이 없는 옛 기록은 건너뛴다.
"""

import argparse
import json
import sys
from pathlib import Path

GAP_MS = 800


def delegations(events: list[dict]) -> list[dict]:
    return [e.get("data") or {} for e in events if e.get("kind") == "위임 시작"]


def bound(decision: dict, dls: list[dict], gap_ms: int) -> bool:
    """이 발화(Decision 이벤트의 구간)에 묶인 위임이 있는가. 1순위 offset_ms가 [start, end+gap] 안(R1), 2순위 마지막 고객 발화 글자 일치."""
    start, end = decision.get("start_ms"), decision.get("end_ms")
    text = (decision.get("input") or "").rsplit("고객 발화: ", 1)[-1].strip()
    windowed = start is not None and end is not None
    for d in dls:
        off = d.get("offset_ms")
        if windowed and off is not None:
            if start <= off <= end + gap_ms:
                return True
        elif text and (d.get("last_customer") or "").strip() == text:  # 구간이 없는 기록(재생·옛 로그)은 글자 일치로
            return True
    return False


def rows_of(record: dict, gap_ms: int, min_conf: float) -> list[dict]:
    events = record.get("events") or []
    dls = delegations(events)
    out = []
    for e in events:
        if e.get("kind") != "Decision":
            continue
        d = e.get("data") or {}
        v = (d.get("answers") or {}).get("value")
        if not v:
            continue
        said = (d.get("input") or "").rsplit("고객 발화: ", 1)[-1].strip()
        p_yes = (v.get("probabilities") or {}).get("yes")
        if p_yes is None:  # 확률이 없는 기록: choice로 대신
            p_yes = 1.0 if v["choice"] == "yes" else 0.0
        out.append({"stage": d.get("stage"), "text": said, "value": v["choice"], "confidence": p_yes,
                    # confidence가 아니라 p(yes)로 거른다: 재생에서 choice=yes·confidence 0.1대인 값 발화가 흔했다(2026-11-10)
                    "server_yes": p_yes >= min_conf, "delegated": bound(d, dls, gap_ms)})
    return out


def summarize(rows: list[dict]) -> dict:
    both = sum(r["server_yes"] and r["delegated"] for r in rows)
    rescue = sum(r["server_yes"] and not r["delegated"] for r in rows)
    missed = sum((not r["server_yes"]) and r["delegated"] for r in rows)
    neither = sum((not r["server_yes"]) and not r["delegated"] for r in rows)
    return {"utterances": len(rows), "server_yes_and_delegated": both, "server_yes_not_delegated(구제 후보)": rescue,
            "server_no_but_delegated(놓침)": missed, "neither": neither,
            "agreement": round((both + neither) / len(rows), 3) if rows else None}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", nargs="?")
    ap.add_argument("--gap-ms", type=int, default=GAP_MS)
    ap.add_argument("--min-confidence", type=float, default=0.5, help="p(yes) 하한")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.folder:
        ap.error("통화 기록 폴더가 필요합니다")
    rows, skipped = [], 0
    for path in sorted(Path(a.folder).glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            skipped += 1
            continue
        got = rows_of(record, a.gap_ms, a.min_confidence)
        if not got:
            skipped += 1
        rows += [r | {"call": path.stem[:8]} for r in got]
    print(json.dumps(summarize(rows) | {"calls_skipped(value 질문 없음·읽기 실패)": skipped}, ensure_ascii=False, indent=1))
    print("\n구제 후보(서버 yes, 위임 없음) — 실제 값 발화인지 사람이 확인:")
    for r in rows:
        if r["server_yes"] and not r["delegated"]:
            print(f"  {r['call']} [{r['stage']}] {r['confidence']:.2f} {r['text'][:60]!r}")
    print("\n놓침(서버 no, Live 위임함):")
    for r in rows:
        if not r["server_yes"] and r["delegated"]:
            print(f"  {r['call']} [{r['stage']}] {r['confidence']:.2f} {r['text'][:60]!r}")
    return 0


def selftest() -> int:
    ev = [{"kind": "Decision", "data": {"stage": "receiver", "input": "직전 AI 발화: 성함?\n고객 발화: 신지환이요",
                                         "start_ms": 1000, "end_ms": 2000, "answers": {"value": {"choice": "yes", "confidence": 0.9, "probabilities": {"yes": 0.9, "no": 0.1}}}}},
          {"kind": "위임 시작", "data": {"offset_ms": 2500, "last_customer": "신지환이요"}},
          {"kind": "Decision", "data": {"stage": "receiver", "input": "직전 AI 발화: 맞나요?\n고객 발화: 네",
                                         "start_ms": 5000, "end_ms": 5300, "answers": {"value": {"choice": "no", "confidence": 0.95}}}},
          {"kind": "Decision", "data": {"stage": "receiver", "input": "직전 AI 발화: 주소?\n고객 발화: 전주시 금암동",
                                         "start_ms": 9000, "end_ms": 9900, "answers": {"value": {"choice": "yes", "confidence": 0.8}}}},
          {"kind": "Decision", "data": {"stage": "intent", "input": "직전 AI 발화: ?\n고객 발화: 옛 기록",  # 구간 없음 → 글자 일치
                                         "answers": {"value": {"choice": "no", "confidence": 0.7}}}},
          {"kind": "위임 시작", "data": {"offset_ms": None, "last_customer": "옛 기록"}}]
    rows = rows_of({"events": ev}, GAP_MS, 0.6)
    s = summarize(rows)
    assert [r["delegated"] for r in rows] == [True, False, False, True], rows
    assert s["server_yes_and_delegated"] == 1 and s["server_yes_not_delegated(구제 후보)"] == 1
    assert s["server_no_but_delegated(놓침)"] == 1 and s["neither"] == 1 and s["agreement"] == 0.5
    print("selftest ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
