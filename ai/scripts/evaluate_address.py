"""주소 보정 회귀 측정: evaluation/datasets/address_v1.json을 실제 주소DB로 풀어 정확도와 지연을 잰다.

서버가 쓰는 경로 그대로 AddressService.resolve()를 부른다(보정 + 못 찾았을 때 재시도). 카카오 지번 조회는
네트워크라 끄고(geo 없음) 보정 시간만 잰다.

    uv run python -X utf8 -m scripts.evaluate_address [--repeat 5] [--out evaluation/results/address_v1_baseline.json]

판정(서버가 실제로 기록하는 값 기준, P6: ambiguous는 1순위를 기록):
- 정답 주소가 있는 사례: confirmed(확정·정답) / auto(애매→1순위가 정답) / wrong(다른 주소 기록) / missed(못 찾음 → 다시 물음)
- 정답 null(없는 주소): rejected(못 찾음, 정답) / wrong(무언가 기록). 못 찾았으면 이유(needs.detail)가 expect_reason과 맞는지도 센다
"""

import argparse
import asyncio
import json
import os
import statistics
import subprocess
import time
from collections import Counter, defaultdict
from pathlib import Path

from app.address.gazetteer import AddressDB, open_db
from app.integrations import kakao
from app.integrations.address import AddressService

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "evaluation" / "datasets" / "address_v1.json"


def check_labels(db: AddressDB, cases: list[dict]) -> None:
    """정답 주소가 실제 주소DB에 있는지(오타 난 정답으로 채점하지 않게). 도로명 + 건물번호로 찾아 표기까지 같아야 한다."""
    bad = []
    for c in cases:
        want = c["expect"]
        if want is None:
            continue
        parts = want.split()
        sido, road, number = parts[0], parts[-2], parts[-1]
        sigungus = [s for (s,) in db.conn.execute("SELECT DISTINCT sigungu FROM roads WHERE sido = ? AND road = ?",
                                                    (sido, road))]
        if want not in {db.lookup(sido, sg, road, number) for sg in sigungus}:
            bad.append((c["id"], want))
    assert not bad, f"주소DB에 없는 정답: {bad}"
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids)), "사례 id 중복"


def classify(expect: str | None, status: str, recorded: str | None) -> str:
    if status in ("off", "error"):
        return "error"
    if expect is None:
        return "rejected" if recorded is None else "wrong"
    if recorded is None:
        return "missed"
    if recorded != expect:
        return "wrong"
    return "confirmed" if status == "confirmed" else "auto"


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))], 1)


async def main(repeat: int, out: Path | None) -> None:
    data = json.loads(DATASET.read_text(encoding="utf-8"))
    cases = data["cases"]
    db_path = Path(os.environ.get("ADDRESS_DB", ROOT / "data" / "address.db"))
    db = open_db(db_path)
    assert db is not None, f"주소DB 없음: {db_path}"
    check_labels(db, cases)

    async def no_geo(*_a, **_k):
        return None
    kakao.geocode = no_geo  # 네트워크 없이 보정만

    svc = AddressService(db)
    rows, cold, warm = [], {}, defaultdict(list)
    try:
        for c in cases:  # 첫 호출(지역 도로 캐시 없음)
            t = time.perf_counter()
            r = await svc.resolve(c["heard"])
            cold[c["id"]] = (time.perf_counter() - t) * 1000
            rows.append((c, r))
        for _ in range(repeat):
            for c in cases:
                t = time.perf_counter()
                await svc.resolve(c["heard"])
                warm[c["id"]].append((time.perf_counter() - t) * 1000)
        # 동시 처리: 같은 사례 전부를 한꺼번에(여러 통화가 동시에 주소를 묻는 상황)
        t = time.perf_counter()
        await asyncio.gather(*(svc.resolve(c["heard"]) for c in cases))
        concurrent_ms = (time.perf_counter() - t) * 1000
    finally:
        await svc.close()

    results = []
    for c, r in rows:
        outcome = classify(c["expect"], r.status, r.address)
        results.append({"id": c["id"], "heard": c["heard"], "expect": c["expect"], "tags": c["tags"],
                        "status": r.status, "recorded": r.address, "alternatives": list(r.alternatives),
                        "reason": r.reason, "expect_reason": c.get("expect_reason"),
                        "outcome": outcome, "cold_ms": round(cold[c["id"]], 1),
                        "warm_p50_ms": round(statistics.median(warm[c["id"]]), 1) if warm[c["id"]] else None})

    counts = Counter(x["outcome"] for x in results)
    positive = [x for x in results if x["expect"] is not None]
    negative = [x for x in results if x["expect"] is None]
    by_tag = defaultdict(Counter)
    for x in results:
        for tag in x["tags"]:
            by_tag[tag][x["outcome"]] += 1
    all_warm = [v for vs in warm.values() for v in vs]
    sequential_ms = sum(statistics.median(vs) for vs in warm.values()) if warm else None
    summary = {
        "cases": len(results),
        "outcomes": dict(counts),
        "positive": {"total": len(positive),
                     "correct_recorded": sum(x["outcome"] in ("confirmed", "auto") for x in positive),
                     "confirmed": counts["confirmed"], "auto": counts["auto"],
                     "wrong": sum(x["outcome"] == "wrong" for x in positive), "missed": counts["missed"]},
        "negative": {"total": len(negative), "rejected": counts["rejected"],
                     "wrong": sum(x["outcome"] == "wrong" for x in negative),
                     "reason_match": sum(x["outcome"] == "rejected" and x["reason"] == x["expect_reason"] for x in negative)},
        "latency_ms": {"cold_p50": pct(list(cold.values()), 50), "cold_p95": pct(list(cold.values()), 95),
                       "cold_max": round(max(cold.values()), 1),
                       "warm_p50": pct(all_warm, 50) if all_warm else None,
                       "warm_p95": pct(all_warm, 95) if all_warm else None,
                       "warm_max": round(max(all_warm), 1) if all_warm else None,
                       "concurrent_all_wall": round(concurrent_ms, 1),
                       "sequential_sum_warm_p50": round(sequential_ms, 1) if sequential_ms else None},
        "by_tag": {k: dict(v) for k, v in sorted(by_tag.items())},
    }
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    report = {"dataset": data["version"], "commit": commit, "resolver": "app.address",
              "db_bytes": db_path.stat().st_size, "repeat": repeat, "geocode": "off",
              "summary": summary, "results": results}

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("\n틀리거나 못 찾은 사례:")
    for x in results:
        if x["outcome"] in ("wrong", "missed", "error"):
            print(f"  {x['id']} [{x['outcome']}] {x['heard']!r} → {x['status']} {x['recorded']!r}"
                  f" (정답 {x['expect']!r}, 후보 {x['alternatives']})")
    for x in negative:
        if x["outcome"] == "rejected" and x["reason"] != x["expect_reason"]:
            print(f"  {x['id']} [이유 다름] {x['heard']!r} → {x['reason']} (기대 {x['expect_reason']})")
    if out:
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n저장: {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeat", type=int, default=5, help="따뜻한 상태 반복 횟수")
    ap.add_argument("--out", type=Path, default=None, help="결과 JSON 경로")
    args = ap.parse_args()
    asyncio.run(main(args.repeat, args.out))
