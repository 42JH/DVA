"""정답 묶음과 비교한 정밀도 · 재현율 — 판정을 바꿀 때마다 이 숫자로 좋아졌는지 본다 (한 유형만 막는 땜질 방지).

    python -m call_analysis.evaluate gold.json run1.txt [run2.txt ...]

gold.json = {"calls": [통화 번호...], "types"(선택): [이 유형만 셈], "call"(선택): {통화: {purposes, goal, mood}}, "labels": [{"seq", "from", "to", "verdict": issue|none|check, "type"}]}
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
CANDIDATES = re.compile(r"한판 (.*)$")


def parse_run(text: str, attrs: dict | None = None, loose: bool = False) -> tuple[set[int], list[tuple[int, str, int, int]]]:
    """try_live 출력 → (판정된 통화, [(통화, 유형, 시작, 끝)]). 오류 줄(판정 실패)은 통화에서도 뺌.
    고객 불만은 '유형:대상:강도@[…]' — attrs를 주면 {(통화, 시작, 끝): (대상, 강도)}를 채움.
    loose = 줄 끝 '한판 …'(다수결에 못 미쳐 빠진 표시)도 판정으로 넣음 — 기준을 낮췄을 때의 정밀도 · 재현율을 같은 판정으로 봄."""
    seen, out = set(), []
    for line in text.splitlines():
        m = LINE.match(line)
        if not m:
            continue
        seq = int(m.group(1))
        seen.add(seq)
        parts = [] if m.group(2) == "불만 없음" else m.group(2).split(" · ")
        more = CANDIDATES.search(line) if loose else None
        if more and more.group(1) != "-":
            parts += more.group(1).split(" · ")
        for part in parts:
            t, extra, orders = re.match(r"(\w+)((?::\w+)*)@\[(.*)\]", part).groups()
            o = [int(x) for x in orders.split(",")]
            out.append((seq, t, min(o), max(o)))
            if attrs is not None and extra:
                target, level = (extra[1:].split(":") + [None, None])[:2]
                attrs[(seq, min(o), max(o))] = (target, level)
    return seen, out


CALL = re.compile(r"통화 (\d+)\s.*용건 (\S+)\s+결과 (\S+)\s+감정 (\S+)")


def score_calls(gold_calls: dict, text: str) -> dict:
    """통화 칸(용건 · 결과 · 감정)을 정답 {통화: {purposes, goal, mood}}과 비교.
    감정 · 결과는 일치율, 부정 감정 · 못 이룸은 따로 정밀도 · 재현율(화면에 띄울 값), 용건은 값마다 정밀도 · 재현율."""
    got = {int(m[1]): {"purposes": set() if m[2] == "-" else set(m[2].split(",")), "goal": m[3], "mood": m[4]}
           for m in map(CALL.match, text.splitlines()) if m}
    all_pairs = [(got[int(k)], g) for k, g in gold_calls.items() if int(k) in got]
    out = {"n": len(all_pairs)}
    for k, focus in (("mood", "negative"), ("goal", "failed")):  # 정답에 그 칸이 있는 통화만 셈(K쇼핑은 감정만)
        pairs = [(a, g) for a, g in all_pairs if k in g]
        out[k] = sum(a[k] == g[k] for a, g in pairs) / len(pairs) if pairs else None
        tp = sum(a[k] == focus == g[k] for a, g in pairs)
        out[focus] = (tp, sum(a[k] == focus for a, _ in pairs), sum(g[k] == focus for _, g in pairs))  # 맞음 · 판정 · 정답
    pairs = [(a, g) for a, g in all_pairs if "purposes" in g]
    out["purposes"] = {p: (sum(p in a["purposes"] and p in g["purposes"] for a, g in pairs),
                           sum(p in a["purposes"] for a, _ in pairs), sum(p in g["purposes"] for _, g in pairs))
                       for p in sorted({p for _, g in pairs for p in g["purposes"]} | {p for a, _ in pairs for p in a["purposes"]})}
    return out


def score(gold: dict, judged: set[int], found: list[tuple[int, str, int, int]]) -> dict:
    """구간이 한 발화라도 겹치면 같은 장면. 유형 같음 = 맞음, 다름 = 유형 틀림(오탐으로도 셈)."""
    calls = set(gold["calls"]) & judged
    scope = set(gold.get("types") or ())  # 한 유형만 매긴 정답(보강용)이면 다른 유형은 판정 · 라벨 모두 셈하지 않음
    inside = lambda t: not scope or t in scope
    labels = [g for g in gold["labels"] if g["seq"] in calls and inside(g["type"])]
    found = [f for f in found if f[0] in calls and inside(f[1])]

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
        attrs: dict = {}
        judged, found = parse_run(open(path, encoding="utf-8").read(), attrs)
        res = score(gold, judged, found)
        print(f"\n== {path}  (정답 통화 중 판정된 {len(set(gold['calls']) & judged)}건)")
        for t, r in res["types"].items():
            print(f"{t:32} 정밀도 {_pct(r['precision'])}  재현율 {_pct(r['recall'])}  (맞음 {r['tp']} · 오탐 {r['fp']} · 놓침 {r['fn']})")
        if "  한판 " in open(path, encoding="utf-8").read():  # 다수결 기준을 낮추면(한 판만 잡아도 인정) 어떻게 되는지 — 같은 판정으로
            wide = score(gold, *parse_run(open(path, encoding="utf-8").read(), loose=True))["types"]
            for t, r in wide.items():
                if r != res["types"].get(t):
                    print(f"  한 판 기준 {t:21} 정밀도 {_pct(r['precision'])}  재현율 {_pct(r['recall'])}  (맞음 {r['tp']} · 오탐 {r['fp']} · 놓침 {r['fn']})")
        # 고객 불만의 대상 · 강도 — 정답과 겹친 고객 불만끼리 비교 (정답에 대상 · 강도가 있을 때만)
        pairs = [(attrs[(f[0], f[2], f[3])], g) for f in found if (f[0], f[2], f[3]) in attrs
                 for g in gold["labels"] if g["seq"] == f[0] and g.get("target") and g["type"] == "DISSATISFACTION_EXPRESSION"
                 and not (f[3] < g["from"] or f[2] > g["to"])]
        if pairs:
            same_t = sum(str(a[0]).upper() == g["target"] for a, g in pairs)
            same_l = sum(str(a[1]).upper() == g["level"] for a, g in pairs)
            print(f"고객 불만 대상 일치 {same_t}/{len(pairs)} ({same_t / len(pairs):.0%}) · 강도 일치 {same_l}/{len(pairs)} ({same_l / len(pairs):.0%})")
        if gold.get("call"):
            c = score_calls(gold["call"], open(path, encoding="utf-8").read())
            pr = lambda t: f"정밀도 {_pct(t[0] / t[1] if t[1] else None)}  재현율 {_pct(t[0] / t[2] if t[2] else None)}  ({t[0]}/{t[1]}/{t[2]})"
            print(f"통화 칸 {c['n']}건 — 감정 일치 {_pct(c['mood'])} · 부정 {pr(c['negative'])}")
            print(f"            결과 일치 {_pct(c['goal'])} · 못 이룸 {pr(c['failed'])}")
            for p, t in c["purposes"].items():
                print(f"            용건 {p:9} {pr(t)}")
        if res["unknown"]:
            print("정답에 없는 구간 (사람 확인 후 gold에 추가):", res["unknown"])


if __name__ == "__main__":
    main(sys.argv[1:])
