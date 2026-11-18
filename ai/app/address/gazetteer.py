"""행안부 주소DB(텍스트) -> SQLite 변환 + 보정기용 사전/건물번호/전국 이름 색인 조회.

빌드: uv run python -X utf8 -m app.address.gazetteer <주소DB 텍스트 폴더> data/address.db   (한 번만, 몇 분 걸림)
사용: open_db(path)로 열어 matcher.resolve()/correct()에 넘긴다. correct()는 지번도 찾는다.
DB 스키마가 바뀌면 address.db 를 지우고 다시 빌드한다. open_db는 옛 스키마(names 없음)를 거부한다(기동 실패, 사용자 결정 2026-11-05).

레이아웃은 address_db/[가이드]주소DB 활용방법.pdf 붙임1 기준.
  개선_도로명코드_전체분.txt : 도로명코드|도로명|로마자|읍면동일련번호|시도명|..|시군구명|..|읍면동명|..|읍면동구분|읍면동코드|사용여부|...
  주소_<시도>.txt            : 관리번호|도로명코드|읍면동일련번호|지하여부|건물본번|건물부번|...
  지번_<시도>.txt            : 관리번호|일련번호|법정동코드|시도명|시군구명|법정읍면동명|법정리명|산여부|번지|호|대표여부
  부가정보_<시도>.txt        : 관리번호|행정동코드|행정동명|우편번호|(폐지)|(폐지)|건축물대장건물명|시군구용건물명|공동주택여부
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

from app.address.matcher import RoadDict, sido_aliases
from app.domain.state import Geo
from app.address.phonetic import Name, jamo, read_digits

log = logging.getLogger(__name__)

ENC = "cp949"
# 테스트도 같은 스키마로 작은 DB를 만든다
SCHEMA = """
    CREATE TABLE roads (road_code INTEGER, emd_seq INTEGER, road TEXT, sido TEXT, sigungu TEXT,
                        emd TEXT, emd_type TEXT);
    CREATE TABLE buildings (id INTEGER PRIMARY KEY, road_code INTEGER, emd_seq INTEGER, underground INTEGER,
                            main INTEGER, sub INTEGER, postal INTEGER, hdong INTEGER);  -- postal·hdong: 부가정보
    CREATE TABLE hdongs (id INTEGER PRIMARY KEY, code TEXT, name TEXT);  -- 행정동
    CREATE TABLE areas (id INTEGER PRIMARY KEY, sido TEXT, sigungu TEXT, dong TEXT, ri TEXT);  -- 법정동·리
    CREATE TABLE jibun (area INTEGER, san INTEGER, main INTEGER, sub INTEGER, building INTEGER, rep INTEGER);  -- rep: 대표 지번
    CREATE TABLE building_names (building INTEGER, name TEXT);  -- 시군구용건물명·건축물대장건물명, 건물당 0~2개
    -- 전국 이름 색인: kind 0 도로명(시군구별), 1 법정동·리, 2 건물명(시군구별). canon = name_key(). FTS는 names를 내용으로 씀
    CREATE TABLE names (id INTEGER PRIMARY KEY, kind INTEGER, text TEXT, canon TEXT, sido TEXT, sigungu TEXT);
    CREATE VIRTUAL TABLE names_fts USING fts5(canon, content='names', content_rowid='id', tokenize='trigram');
    CREATE VIRTUAL TABLE names_vocab USING fts5vocab(names_fts, row);  -- trigram별 문서 수(질의 비용 제한용)
"""
TRIGRAM_POSTINGS = 50_000  # 한 질의가 훑는 posting 수 예산: 흔한 trigram("…로"의 ㄴㄴㅗ, "아파트")은 비용만 크고 변별력이 없다
TRIGRAM_MIN = 4            # 그래도 최소 이만큼은 써서 소리 오류로 한두 trigram이 깨져도 찾히게
INDEXES = """
    CREATE INDEX roads_region ON roads (sido, sigungu, road);
    CREATE INDEX roads_key ON roads (road_code, emd_seq);  -- 건물·지번 -> 도로
    CREATE INDEX buildings_key ON buildings (road_code, main, sub);
    CREATE INDEX areas_region ON areas (sido, sigungu);
    CREATE INDEX jibun_key ON jibun (area, san, main, sub);
    CREATE INDEX jibun_building ON jibun (building);  -- 건물 -> 대표 지번(geo)
    CREATE INDEX roads_road ON roads (road, sido);     -- 도로명주소 문자열 -> 건물(geo: 시군구를 모를 때)
    CREATE INDEX building_names_name ON building_names (name);
    CREATE INDEX names_kind ON names (kind, sido, sigungu);
"""


def name_key(text: str) -> str:
    """색인·질의 공통 비교 키: 띄어쓰기·구두점을 떼고 숫자는 읽는 소리로("63빌딩"→육십삼빌딩), 발음 정규화 자모."""
    return jamo(read_digits(re.sub(r"[\s,.·()\[\]'\"]", "", text)), canon=True)


COMPOSITE = re.compile(r"(?<=\S\S)\s*(?:[,/&]|및|앤드)\s*(?=\S\S)")  # 건물 여럿을 한 칸에 적은 표기의 구분


def name_variants(name):
    """부가정보 건물명 하나 -> 말로 부를 법한 이름들. 복합 표기는 데이터에서 풀어 두고 보정기는 같은 이름인지만 본다.
    "롯데월드타워앤드롯데월드몰" -> 그대로 + 롯데월드타워 + 롯데월드몰, "부산광역시청, 부산광역시의회" -> 둘로,
    "서울역(본옥)" -> 그대로 + 서울역, "삼성전자(주) 평택캠퍼스" -> + 삼성전자 평택캠퍼스."""
    out = [name] + ([p for p in COMPOSITE.split(name) if p] if COMPOSITE.search(name) else [])
    out += [re.sub(r"\(.*?\)", "", x) for x in out if "(" in x]
    return [x for x in dict.fromkeys(x.strip() for x in out) if len(x) >= 2]


def read_extra(path, hdongs):
    """부가정보 -> {관리번호: (우편번호, 행정동 id, 건물명들)}. 행정동은 코드별로 hdongs에 번호를 매긴다."""
    out = {}
    with open(path, encoding=ENC) as f:
        for c in (line.rstrip("\n").split("|") for line in f):
            hd = hdongs.setdefault(c[1], (len(hdongs) + 1, c[2]))[0] if c[1] else None
            names = tuple(dict.fromkeys(v for x in (c[7], c[6]) if x for v in name_variants(x)))
            out[c[0]] = (int(c[3]) if c[3].isdigit() else None, hd, names)
    return out


def build_names(conn):
    """전국 이름 색인(names + FTS)을 roads·areas·building_names에서 (다시) 만든다. 샘플 DB도 같이 쓴다."""
    conn.execute("DELETE FROM names")
    rows = [(0, road, sido, sg) for road, sido, sg in conn.execute("SELECT DISTINCT road, sido, sigungu FROM roads")]
    # 법정동·리(areas)와 도로가 속한 읍면동(roads.emd: 동 지역은 법정동, 읍면 지역은 읍면). "기암리(基岩)"처럼 한자로만
    # 구분된 리는 말로는 같다 -> 괄호를 뗀 이름 하나로
    rows += [(1, re.sub(r"\(.*?\)", "", ri) or dong, sido, sg)
             for sido, sg, dong, ri in conn.execute("SELECT sido, sigungu, dong, ri FROM areas")]
    rows += [(1, emd, sido, sg) for emd, sido, sg in conn.execute("SELECT DISTINCT emd, sido, sigungu FROM roads WHERE emd != ''")]
    rows += [(2, name, sido, sg) for name, sido, sg in conn.execute("""
        SELECT DISTINCT bn.name, r.sido, r.sigungu FROM building_names bn
        JOIN buildings b ON b.id = bn.building JOIN roads r ON r.road_code = b.road_code AND r.emd_seq = b.emd_seq""")]
    conn.executemany("INSERT INTO names (kind, text, canon, sido, sigungu) VALUES (?,?,?,?,?)",
                     ((k, t, name_key(t), s, g) for k, t, s, g in dict.fromkeys(rows)))
    conn.execute("INSERT INTO names_fts(names_fts) VALUES ('rebuild')")


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

    n = m = named = 0
    areas = {}  # (시도, 시군구, 법정읍면동, 법정리) -> areas.id
    hdongs = {}  # 행정동코드 -> (hdongs.id, 행정동명)
    for path in sorted(glob.glob(os.path.join(src, "주소_*.txt"))):
        sido_file = os.path.basename(path)[3:]
        extra = read_extra(os.path.join(src, "부가정보_" + sido_file), hdongs)
        ids, rows, name_rows = {}, [], []  # 관리번호(25자리) -> buildings.id. 지번 파일은 같은 시도 건물만 가리켜서 시도별로만 들고 있음
        with open(path, encoding=ENC) as f:
            for c in (line.split("|", 6) for line in f):
                n += 1
                ids[c[0]] = n
                postal, hdong, names = extra.get(c[0], (None, None, ()))
                rows.append((n, int(c[1]), int(c[2]), int(c[3]), int(c[4]), int(c[5]), postal, hdong))
                name_rows += [(n, name) for name in names]
        del extra
        conn.executemany("INSERT INTO buildings VALUES (?,?,?,?,?,?,?,?)", rows)
        conn.executemany("INSERT INTO building_names VALUES (?,?)", name_rows)
        named += len(name_rows)
        rows = []
        with open(os.path.join(src, "지번_" + sido_file), encoding=ENC) as f:
            for c in (line.rstrip("\n").split("|") for line in f):
                if c[0] in ids:
                    area = areas.setdefault((c[3], c[4], c[5], c[6]), len(areas) + 1)
                    rows.append((area, int(c[7]), int(c[8]), int(c[9]), ids[c[0]], int(c[10] == "1")))
        conn.executemany("INSERT INTO jibun VALUES (?,?,?,?,?,?)", rows)
        m += len(rows)
        print(f"  {sido_file} 건물 {len(ids):,}건, 건물명 {len(name_rows):,}건, 지번 {len(rows):,}건")
    conn.executemany("INSERT INTO areas VALUES (?,?,?,?,?)", [(i, *k) for k, i in areas.items()])
    conn.executemany("INSERT INTO hdongs VALUES (?,?,?)", [(i, code, name) for code, (i, name) in hdongs.items()])
    print(f"건물 {n:,}건, 건물명 {named:,}건, 지번 {m:,}건, 법정동·리 {len(areas):,}개, 행정동 {len(hdongs):,}개 "
          f"({time.time() - t:.0f}s)")

    conn.executescript(INDEXES)
    print(f"인덱스 완료 ({time.time() - t:.0f}s)")
    build_names(conn)
    conn.commit()
    print(f"이름 색인 {conn.execute('SELECT COUNT(*) FROM names').fetchone()[0]:,}건 ({time.time() - t:.0f}s), "
          f"{os.path.getsize(out) / 1e6:.0f}MB")
    conn.close()


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
    """주소DB를 연다. 파일이 없으면 None(보정 없이 들은 그대로 — AddressService가 status="off").
    옛 스키마(전국 이름 색인 없음)면 RuntimeError: 조용히 축소하지 않고 기동을 막아 재빌드를 알린다."""
    if not path.is_file():
        log.warning("주소DB가 없어 주소 보정을 끕니다: %s", path)
        return None
    db = AddressDB(path)
    if not db.conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'names'").fetchone():
        raise RuntimeError(f"주소DB 스키마가 오래됐습니다(names 없음): {path} — 다시 빌드: "
                           f"python -X utf8 -m app.address.gazetteer <주소DB 텍스트 폴더> {path}")
    log.info("주소 보정 켜짐: %s", path)
    return db


class AddressDB(RoadDict):
    """여러 스레드(AddressService 실행기)가 잠금 없이 같이 쓴다: SQLite 연결은 스레드마다 하나씩, 캐시(지역별 도로·법정동)는
    같은 값을 다시 채워 넣을 뿐이라 동시에 채워도 결과가 같다."""

    name_key = staticmethod(name_key)

    def __init__(self, path):
        self._uri = f"{Path(path).resolve().as_uri()}?mode=ro"  # 읽기 전용(배포에서는 :ro 볼륨)
        self._local = threading.local()
        self.parts = {}
        self.roads = _LazyRoads(self)
        self._areas = {}
        self._dongs: frozenset[str] | None = None
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

    def is_dong(self, name):
        """전국 어딘가의 법정동 이름인가("사이동"): 상세주소의 N동 표지와 구분(parse.split_detail).
        전국 동 이름은 한 번만 읽어 둔다(토큰마다 질의하지 않게. 동시에 채워도 같은 값)."""
        if self._dongs is None:
            self._dongs = frozenset(d for (d,) in self.conn.execute("SELECT DISTINCT dong FROM areas"))
        return name in self._dongs

    def areas(self, key):
        """(시도, 시군구) 안의 법정동·리 -> [(areas.id, 비교 이름들)]. "선산읍 완전리"는 "완전리"로도 말함."""
        if key not in self._areas:
            # "기암리(基岩)"/"기암리(岐岩)"처럼 한자로만 구분된 리가 있음 -> 말로는 같으니 괄호를 떼고 비교
            self._areas[key] = [(i, [Name(ri), Name(dong + ri)] if ri else [Name(dong)])
                                for i, dong, ri in ((i, d, re.sub(r"\(.*?\)", "", r)) for i, d, r in self.conn.execute(
                                    "SELECT id, dong, ri FROM areas WHERE sido = ? AND sigungu = ?", key))]
        return self._areas[key]

    def jibun_lookup(self, area, san, number):
        """그 법정동·리에 그 지번("123-4")이 실제로 있으면 그 지번 지상 건물들의 도로명주소(한 지번에 건물이 여럿이면 여러 개)."""
        main, _, sub = number.partition("-")
        if not main.isdigit() or (sub and not sub.isdigit()):
            return []
        rows = self.conn.execute("""
            SELECT DISTINCT r.sido, r.sigungu, r.road, b.main, b.sub, r.emd, r.emd_type FROM jibun j
            JOIN buildings b ON b.id = j.building
            JOIN roads r ON r.road_code = b.road_code AND r.emd_seq = b.emd_seq
            WHERE j.area = ? AND j.san = ? AND j.main = ? AND j.sub = ? AND b.underground = 0""",
                                 (area, san, int(main), int(sub or 0)))
        return [address(sido, sg, road, number_of(bm, bs), emd, emd_type) for sido, sg, road, bm, bs, emd, emd_type in rows]

    def geo(self, road_address):
        """확정한 도로명주소의 접수용 값(지번주소·법정동명·우편번호) — 카카오 geocode와 같은 표기(2026-11-06 실측으로 정한 규칙):
        지번은 대표 지번, 시도는 특별시·광역시·도만 두 글자로 줄임, 동명은 "동" 또는 "읍면 리", 산은 "산 45-1", 우편번호 5자리.
        건물·대표 지번·우편번호 중 하나라도 없으면 None(호출자가 카카오로 보완)."""
        parts = road_address.split()
        sido, road, number = parts[0], parts[-2], parts[-1]
        main, _, sub = number.partition("-")
        if not main.isdigit() or (sub and not sub.isdigit()):
            return None
        for bid, sg, emd, t, postal in self.conn.execute("""
                SELECT b.id, r.sigungu, r.emd, r.emd_type, b.postal FROM buildings b
                JOIN roads r ON r.road_code = b.road_code AND r.emd_seq = b.emd_seq
                WHERE r.sido = ? AND r.road = ? AND b.main = ? AND b.sub = ? AND b.underground = 0""",
                (sido, road, int(main), int(sub or 0))):
            if address(sido, sg, road, number, emd, t) != road_address or postal is None:
                continue
            j = self.conn.execute("""SELECT a.dong, a.ri, j.san, j.main, j.sub FROM jibun j JOIN areas a ON a.id = j.area
                                     WHERE j.building = ? ORDER BY j.rep DESC, j.rowid LIMIT 1""", (bid,)).fetchone()
            if j is None:
                continue
            dong, ri, san, jm, js = j
            dong_name = f"{dong} {ri}".strip()
            jibun = " ".join(x for x in (kakao_sido(sido), sg, dong_name, "산" if san else "", number_of(jm, js)) if x)
            return Geo(jibun_address=jibun, dong_name=dong_name, postal_code=f"{postal:05d}")
        return None

    def search_names(self, kind, key, scope=None, limit=200):
        """전국 이름 색인: name_key(들은 이름)와 trigram을 공유하는 이름을 bm25 순으로 -> [(text, 시도, 시군구)].
        scope=[(시도, 시군구)]면 그 지역만. 재순위(소리 거리)는 호출자가 한다.
        trigram은 드문 것부터 posting 합이 예산 안인 만큼만 쓴다(측정: 전부 쓰면 70~220ms, 드문 4~6개면 12~50ms, 1위 동일)."""
        tri = list(dict.fromkeys(key[i:i + 3] for i in range(len(key) - 2))) or [key]
        df = {t: (self.conn.execute("SELECT doc FROM names_vocab WHERE term = ?", (t,)).fetchone() or (0,))[0] for t in tri}
        picked, total = [], 0
        for t in sorted(tri, key=df.get):
            if len(picked) >= TRIGRAM_MIN and total + df[t] > TRIGRAM_POSTINGS:
                break
            picked.append(t)
            total += df[t]
        match = " OR ".join('"' + t.replace('"', '""') + '"' for t in picked)
        sql = ("SELECT n.text, n.sido, n.sigungu FROM names_fts f JOIN names n ON n.id = f.rowid "
               "WHERE names_fts MATCH ? AND n.kind = ?")
        args = [match, kind]
        if scope:
            sql += " AND (" + " OR ".join("(n.sido = ? AND n.sigungu = ?)" for _ in scope) + ")"
            args += [x for k in scope for x in k]
        return self.conn.execute(sql + " ORDER BY bm25(names_fts) LIMIT ?", args + [limit]).fetchall()

    def named_addresses(self, name, scope=None):
        """그 건물명(부가정보 표기 그대로)이 붙은 지상 건물의 도로명주소들(중복 제거). scope=[(시도, 시군구)]로 제한."""
        sql = """SELECT DISTINCT r.sido, r.sigungu, r.road, b.main, b.sub, r.emd, r.emd_type FROM building_names bn
                 JOIN buildings b ON b.id = bn.building JOIN roads r ON r.road_code = b.road_code AND r.emd_seq = b.emd_seq
                 WHERE bn.name = ? AND b.underground = 0"""
        args = [name]
        if scope:
            sql += " AND (" + " OR ".join("(r.sido = ? AND r.sigungu = ?)" for _ in scope) + ")"
            args += [x for k in scope for x in k]
        return [address(sido, sg, road, number_of(main, sub), emd, t)
                for sido, sg, road, main, sub, emd, t in self.conn.execute(sql, args)]


def kakao_sido(sido):
    """카카오 지번주소의 시도 표기: 특별시·광역시·도는 두 글자(서울, 경북), 특별자치시·도와 통합특별시는 정식 명칭."""
    if "특별자치" in sido or "통합" in sido:
        return sido
    return min(sido_aliases(sido), key=len)


def number_of(main, sub):
    return f"{main}-{sub}" if sub else str(main)


def address(sido, sigungu, road, number, emd, emd_type):
    emd = emd if emd_type == "0" else ""  # 읍/면 지역은 주소에 읍면명이 들어감
    return " ".join(x for x in (sido, sigungu, emd, road, number) if x)


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2])
