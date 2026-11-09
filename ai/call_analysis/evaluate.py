"""정답 묶음과 비교한 정밀도 · 재현율 — 판정을 바꿀 때마다 이 숫자로 좋아졌는지 본다 (한 유형만 막는 땜질 방지).

    python -m call_analysis.evaluate gold.json run1.txt [run2.txt ...]

gold.json = {"calls": [통화 번호...], "labels": [{"seq", "from", "to", "verdict": issue|none|check, "type"}]}
  issue = 불만 맞음(유형까지) · none = 판정이 잡으면 틀림 · check = 사람도 애매 → 셈에서 뺌
  정답에 없는 통화는 셈하지 않는다. 정답 통화의 라벨 없는 구간은 '불만 없음'으로 본다.
run.txt = try_live가 찍은 줄 ("통화 261  발화 109  TYPE@[24, 25] · ...  되묻기 ..."). 여러 판이면 판마다 따로 센다.
정답 · 결과 파일에는 대본 글이 섞이므로 저장소에 넣지 않는다 (이 파일만 넣음).
"""

import json
import re
import sys
from collections import Counter

LINE = re.compile(r"통화 (\d+)\s+발화 \d+\s+(.*?)\s+되묻기")


def parse_run(text: str) -> tuple[set[int], list[tuple[int, str, int, int]]]:
    """try_live 출력 → (판정된 통화, [(통화, 유형, 시작, 끝)]). 오류 줄(판정 실패)은 통화에서도 뺌."""
    seen, out = set(), []
    for line in text.splitlines():
        m = LINE.match(line)
        if not m:
            continue
        seen.add(int(m.group(1)))
        if m.group(2) == "불만 없음":
            continue
        for part in m.group(2).split(" · "):
            t, orders = re.match(r"(\w+)@\[(.*)\]", part).groups()
            o = [int(x) for x in orders.split(",")]
            out.append((int(m.group(1)), t, min(o), max(o)))
    return seen, out


def score(gold: dict, judged: set[int], found: list[tuple[int, str, int, int]]) -> dict:
    """구간이 한 발화라도 겹치면 같은 장면. 유형 같음 = 맞음, 다름 = 유형 틀림(오탐으로도 셈)."""
    calls = set(gold["calls"]) & judged
    labels = [g for g in gold["labels"] if g["seq"] in calls]
    found = [f for f in found if f[0] in calls]

    def hits(f, g):
        return f[0] == g["seq"] and not (f[3] < g["from"] or f[2] > g["to"])

    tp, fp, fn, wrong, unknown = Counter(), Counter(), Counter(), [], []
    for f in found:
        near = [g for g in labels if hits(f, g)]
        if any(g["verdict"] == "issue" and g["type"] == f[1] for g in near):
            tp[f[1]] += 1
        elif any(g["verdict"] == "check" for g in near) and not any(g["verdict"] == "issue" for g in near):
            continue  # 사람도 애매 — 셈에서 뺌
        elif not near:
            unknown.append(f)  # 정답에 없는 구간 — 새로 봐야 함 (일단 오탐으로 셈)
            fp[f[1]] += 1
        else:
            fp[f[1]] += 1
            wrong += [f] if any(g["verdict"] == "issue" for g in near) else []
    for g in labels:
        if g["verdict"] == "issue" and not any(hits(f, g) and f[1] == g["type"] for f in found):
            fn[g["type"]] += 1
    rows = {}
    for t in sorted(set(tp) | set(fp) | set(fn)):
        p, r = tp[t] + fp[t], tp[t] + fn[t]
        rows[t] = {"tp": tp[t], "fp": fp[t], "fn": fn[t],
                   "precision": tp[t] / p if p else None, "recall": tp[t] / r if r else None}
    T, P, R = sum(tp.values()), sum(tp.values()) + sum(fp.values()), sum(tp.values()) + sum(fn.values())
    rows["ALL"] = {"tp": T, "fp": P - T, "fn": R - T, "precision": T / P if P else None, "recall": T / R if R else None}
    return {"types": rows, "wrong_type": wrong, "unknown": unknown}


def _pct(x):
    return "  -  " if x is None else f"{x:5.0%}"


def main(argv: list[str]) -> None:
    gold = json.load(open(argv[0], encoding="utf-8"))
    for path in argv[1:]:
        judged, found = parse_run(open(path, encoding="utf-8").read())
        res = score(gold, judged, found)
        print(f"\n== {path}  (정답 통화 중 판정된 {len(set(gold['calls']) & judged)}건)")
        for t, r in res["types"].items():
            print(f"{t:32} 정밀도 {_pct(r['precision'])}  재현율 {_pct(r['recall'])}  (맞음 {r['tp']} · 오탐 {r['fp']} · 놓침 {r['fn']})")
        if res["unknown"]:
            print("정답에 없는 구간 (사람 확인 후 gold에 추가):", res["unknown"])


if __name__ == "__main__":
    main(sys.argv[1:])
