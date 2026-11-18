"""Geo 로컬화 검증: 확정 주소의 접수용 값(지번주소·법정동명·우편번호)을 주소DB(AddressDB.geo)와 카카오(geocode)로 각각 만들어 비교한다.

    KAKAO_REST_API_KEY=... uv run python -X utf8 -m scripts.compare_geo [--random 100]

대상: evaluation/datasets/address_v1·v2의 정답 주소 + 주소DB 무작위 N건(산·읍면·지하 제외 지상 건물). 세 값이 모두 같아야 일치.
"""

import argparse
import asyncio
import json
import os
import sqlite3
from pathlib import Path

import httpx2

from app.address.gazetteer import address as fmt, number_of, open_db
from app.integrations import kakao

ROOT = Path(__file__).resolve().parents[1]


def dataset_addresses() -> list[str]:
    out = []
    for name in ("address_v1", "address_v2"):
        data = json.loads((ROOT / "evaluation" / "datasets" / f"{name}.json").read_text(encoding="utf-8"))
        out += [c["expect"] for c in data["cases"] if c["expect"]]
    return list(dict.fromkeys(out))


def random_addresses(db_path: Path, n: int) -> list[str]:
    conn = sqlite3.connect(f"file:{db_path.resolve().as_posix()}?mode=ro", uri=True)
    rows = conn.execute("""SELECT r.sido, r.sigungu, r.road, b.main, b.sub, r.emd, r.emd_type FROM buildings b
                           JOIN roads r ON r.road_code = b.road_code AND r.emd_seq = b.emd_seq
                           WHERE b.underground = 0 AND b.id % 7919 = 3 LIMIT ?""", (n,)).fetchall()
    return [fmt(s, g, r, number_of(m, sub), e, t) for s, g, r, m, sub, e, t in rows]


async def main(n_random: int) -> None:
    assert kakao.has_key(), "KAKAO_REST_API_KEY 필요"
    db_path = Path(os.environ.get("ADDRESS_DB", ROOT / "data" / "address.db"))
    db = open_db(db_path)
    addresses = dataset_addresses() + random_addresses(db_path, n_random)
    same = diff = local_none = kakao_none = 0
    async with httpx2.AsyncClient() as http:
        for a in addresses:
            local = db.geo(a)
            remote = await kakao.geocode(a, 5.0, http=http)
            if local is None:
                local_none += 1
            if remote is None:
                kakao_none += 1
            if local and remote:
                if local == remote:
                    same += 1
                else:
                    diff += 1
                    print(f"다름 [{a}]\n  로컬  {local}\n  카카오 {remote}")
            elif local is None:
                print(f"로컬 없음 [{a}] 카카오 {remote}")
    print(f"\n주소 {len(addresses)}건: 일치 {same}, 다름 {diff}, 로컬 없음 {local_none}, 카카오 없음 {kakao_none}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--random", type=int, default=100)
    asyncio.run(main(ap.parse_args().random))
