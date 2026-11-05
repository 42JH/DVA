"""행안부 주소DB(텍스트) -> SQLite 변환 + 보정기용 사전/건물번호 조회.

빌드: uv run python -X utf8 -m app.address.gazetteer <주소DB 텍스트 폴더> data/address.db   (한 번만, 1~2분 걸림)
사용: open_db(path)로 열어 matcher.resolve()/correct()에 넘긴다. correct()는 지번도 찾는다.
DB 스키마가 바뀌면(지번 테이블 추가 등) address.db 를 지우고 다시 빌드한다.

레이아웃은 address_db/[가이드]주소DB 활용방법.pdf 붙임1 기준.
  개선_도로명코드_전체분.txt : 도로명코드|도로명|로마자|읍면동일련번호|시도명|..|시군구명|..|읍면동명|..|읍면동구분|읍면동코드|사용여부|...
  주소_<시도>.txt            : 관리번호|도로명코드|읍면동일련번호|지하여부|건물본번|건물부번|...
  지번_<시도>.txt            : 관리번호|일련번호|법정동코드|시도명|시군구명|법정읍면동명|법정리명|산여부|번지|호|대표여부
"""
import glob
import logging
import os
import re
import sqlite3
import sys
import threading
import time
from pathlib import Path

from app.address.matcher import RoadDict
from app.address.phonetic import Name

log = logging.getLogger(__name__)

ENC = "cp949"
# 테스트도 같은 스키마로 작은 DB를 만든다
SCHEMA = """
    CREATE TABLE roads (road_code INTEGER, emd_seq INTEGER, road TEXT, sido TEXT, sigungu TEXT,
                        emd TEXT, emd_type TEXT);
    CREATE TABLE buildings (id INTEGER PRIMARY KEY, road_code INTEGER, emd_seq INTEGER, underground INTEGER,
                            main INTEGER, sub INTEGER);
    CREATE TABLE areas (id INTEGER PRIMARY KEY, sido TEXT, sigungu TEXT, dong TEXT, ri TEXT);  -- 법정동·리
    CREATE TABLE jibun (area INTEGER, san INTEGER, main INTEGER, sub INTEGER, building INTEGER);
"""
INDEXES = """
    CREATE INDEX roads_region ON roads (sido, sigungu, road);
    CREATE INDEX roads_key ON roads (road_code, emd_seq);  -- 건물·지번 -> 도로
    CREATE INDEX buildings_key ON buildings (road_code, main, sub);
    CREATE INDEX areas_region ON areas (sido, sigungu);
    CREATE INDEX jibun_key ON jibun (area, san, main, sub);
"""


def build(src, out):
    if os.path.exists(out):
        os.remove(out)
    conn = sqlite3.connect(out)
    conn.executescript("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;" + SCHEMA)
    t = time.time()
    with open(os.path.join(src, "개선_도로명코드_전체분.txt"), encoding=ENC) as f:
        rows = []
        for line in f:
            c = line.rstrip("\n").split("|")
            if c[12] == "0":  # 사용여부 0:사용
                rows.append((int(c[0]), int(c[3]), c[1], c[4], c[6], c[8], c[10]))
    conn.executemany("INSERT INTO roads VALUES (?,?,?,?,?,?,?)", rows)
    print(f"도로명코드 {len(rows):,}건 ({time.time() - t:.0f}s)")

    n = m = 0
    areas = {}  # (시도, 시군구, 법정읍면동, 법정리) -> areas.id
    for path in sorted(glob.glob(os.path.join(src, "주소_*.txt"))):
        ids, rows = {}, []  # 관리번호(25자리) -> buildings.id. 지번 파일은 같은 시도 건물만 가리켜서 시도별로만 들고 있음
        with open(path, encoding=ENC) as f:
            for c in (line.split("|", 6) for line in f):
                n += 1
                ids[c[0]] = n
                rows.append((n, int(c[1]), int(c[2]), int(c[3]), int(c[4]), int(c[5])))
        conn.executemany("INSERT INTO buildings VALUES (?,?,?,?,?,?)", rows)
        rows = []
        with open(os.path.join(src, "지번_" + os.path.basename(path)[3:]), encoding=ENC) as f:
            for c in (line.rstrip("\n").split("|") for line in f):
                if c[0] in ids:
                    area = areas.setdefault((c[3], c[4], c[5], c[6]), len(areas) + 1)
                    rows.append((area, int(c[7]), int(c[8]), int(c[9]), ids[c[0]]))
        conn.executemany("INSERT INTO jibun VALUES (?,?,?,?,?)", rows)
        m += len(rows)
        print(f"  {os.path.basename(path)} 건물 {len(ids):,}건, 지번 {len(rows):,}건")
    conn.executemany("INSERT INTO areas VALUES (?,?,?,?,?)", [(i, *k) for k, i in areas.items()])
    print(f"건물 {n:,}건, 지번 {m:,}건, 법정동·리 {len(areas):,}개 ({time.time() - t:.0f}s)")

    conn.executescript(INDEXES)
    conn.commit()
    conn.close()
    print(f"인덱스 완료 ({time.time() - t:.0f}s), {os.path.getsize(out) / 1e6:.0f}MB")


class _LazyRoads(dict):
    """(시도, 시군구) -> {도로명}. 처음 묻는 지역만 DB에서 읽어 캐시."""

    def __init__(self, db):
        super().__init__()
        self.db = db

    def __missing__(self, key):
        roads = {r for (r,) in self.db.conn.execute(
            "SELECT DISTINCT road FROM roads WHERE sido = ? AND sigungu = ?", key)}
        self.db.add_parts(roads)
        self[key] = roads
        return roads


def open_db(path: Path) -> "AddressDB | None":
    """주소DB를 연다. 파일이 없으면 None(보정 없이 들은 그대로 — AddressService가 status="off")."""
    if not path.is_file():
        log.warning("주소DB가 없어 주소 보정을 끕니다: %s", path)
        return None
    log.info("주소 보정 켜짐: %s", path)
    return AddressDB(path)


class AddressDB(RoadDict):
    """여러 스레드(AddressService 실행기)가 잠금 없이 같이 쓴다: SQLite 연결은 스레드마다 하나씩, 캐시(지역별 도로·법정동)는
    같은 값을 다시 채워 넣을 뿐이라 동시에 채워도 결과가 같다."""

    def __init__(self, path):
        self._uri = f"{Path(path).resolve().as_uri()}?mode=ro"  # 읽기 전용(배포에서는 :ro 볼륨)
        self._local = threading.local()
        self.parts = {}
        self.roads = _LazyRoads(self)
        self._areas = {}
        self.set_regions(self.conn.execute("SELECT DISTINCT sido, sigungu FROM roads"))

    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._local.conn = sqlite3.connect(self._uri, uri=True)
        return conn

    def lookup(self, sido, sigungu, road, number):
        """그 도로에 그 건물번호가 실제로 있으면 표준 도로명주소 문자열, 없으면 None."""
        main, _, sub = number.partition("-")
        if not main.isdigit() or (sub and not sub.isdigit()):
            return None
        # shortcut: 지상 건물만 확인 (STT로 "지하"를 말하는 경우는 아직 처리 안 함)
        row = self.conn.execute("""
            SELECT r.emd, r.emd_type FROM buildings b
            JOIN roads r ON r.road_code = b.road_code AND r.emd_seq = b.emd_seq
            WHERE r.sido = ? AND r.sigungu = ? AND r.road = ?
              AND b.main = ? AND b.sub = ? AND b.underground = 0
            LIMIT 1""", (sido, sigungu, road, int(main), int(sub or 0))).fetchone()
        return row and address(sido, sigungu, road, number, *row)

    def numbers(self, sido, sigungu, road):
        """그 도로의 지상 건물번호 전부 -> [("212", 표준 도로명주소), ("212-1", ...)]"""
        rows = self.conn.execute("""
            SELECT b.main, b.sub, r.emd, r.emd_type FROM roads r
            JOIN buildings b ON b.road_code = r.road_code AND b.emd_seq = r.emd_seq
            WHERE r.sido = ? AND r.sigungu = ? AND r.road = ? AND b.underground = 0""", (sido, sigungu, road))
        return [(number(main, sub), address(sido, sigungu, road, number(main, sub), emd, emd_type))
                for main, sub, emd, emd_type in rows]

    def areas(self, key):
        """(시도, 시군구) 안의 법정동·리 -> [(areas.id, 비교 이름들)]. "선산읍 완전리"는 "완전리"로도 말함.

        리가 있는 읍·면은 읍·면 이름만 말한 경우("산동읍", 접미사 없이 "산동")도 (None, 이름들)로 둔다. 리 없이는 지번이
        하나로 정해지지 않아서(같은 번지가 여러 리에 있고, 건물 없는 필지는 주소DB에 없다) 번호를 찾지 않는다 — 이 이름이
        들은 이름과 같으면 다른 동·리로 고치지 않고 다시 묻게 된다(matcher._correct, 2026-11-05 "산동 580" → 신동 580).
        """
        if key not in self._areas:
            # "기암리(基岩)"/"기암리(岐岩)"처럼 한자로만 구분된 리가 있음 -> 말로는 같으니 괄호를 떼고 비교
            rows = [(i, d, re.sub(r"\(.*?\)", "", r)) for i, d, r in self.conn.execute(
                "SELECT id, dong, ri FROM areas WHERE sido = ? AND sigungu = ?", key)]
            out = [(i, [Name(ri), Name(dong + ri)] if ri else [Name(dong)]) for i, dong, ri in rows]
            for emd in sorted({dong for _, dong, ri in rows if ri}):
                out.append((None, [Name(emd)] + ([Name(emd[:-1])] if len(emd) >= 3 and emd[-1] in "읍면" else [])))
            self._areas[key] = out
        return self._areas[key]

    def jibun_numbers(self, area, san):
        """그 법정동·리의 지번 전부 -> [("123-4", 그 지번 지상 건물의 도로명주소), ...]. 한 지번에 건물이 여럿이면 여러 줄.
        area가 None(읍·면만 말함)이면 없음."""
        if area is None:
            return []
        rows = self.conn.execute("""
            SELECT j.main, j.sub, r.sido, r.sigungu, r.road, b.main, b.sub, r.emd, r.emd_type FROM jibun j
            JOIN buildings b ON b.id = j.building
            JOIN roads r ON r.road_code = b.road_code AND r.emd_seq = b.emd_seq
            WHERE j.area = ? AND j.san = ? AND b.underground = 0""", (area, san))
        return [(number(jm, js), address(sido, sg, road, number(bm, bs), emd, emd_type))
                for jm, js, sido, sg, road, bm, bs, emd, emd_type in rows]


def number(main, sub):
    return f"{main}-{sub}" if sub else str(main)


def address(sido, sigungu, road, number, emd, emd_type):
    emd = emd if emd_type == "0" else ""  # 읍/면 지역은 주소에 읍면명이 들어감
    return " ".join(x for x in (sido, sigungu, emd, road, number) if x)


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2])
