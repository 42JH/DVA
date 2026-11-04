"""테스트용 작은 주소DB(실제 행안부 DB 없이 보정기를 시험). 도구 테스트도 같이 쓴다."""

import sqlite3
from pathlib import Path

from app.address.gazetteer import INDEXES, SCHEMA

ROADS = [  # (도로명코드, 읍면동일련번호, 도로명, 시도, 시군구, 읍면동, 읍면동구분 0:읍면 1:동)
    (1, 0, "테헤란로", "서울특별시", "강남구", "역삼동", "1"),
    (2, 0, "테헤란로1길", "서울특별시", "강남구", "역삼동", "1"),
    (3, 0, "테헤란로2길", "서울특별시", "강남구", "역삼동", "1"),
    (4, 0, "판교역로", "경기도", "성남시 분당구", "백현동", "1"),
    (5, 0, "왕궁로", "전북특별자치도", "익산시", "왕궁면", "0"),
    (6, 0, "인동9길", "경상북도", "구미시", "인의동", "1"),
]
BUILDINGS = {1: (111, 115, 211, 212), 2: (10, 32), 3: (32,), 4: (166,), 5: (100,), 6: ((7, 3), (8, 0))}
AREAS = [(1, "경상북도", "구미시", "인의동", ""), (2, "경상북도", "구미시", "선산읍", "완전리")]
JIBUN = [  # (법정동·리, 산여부, 번지, 호, 건물 = 도로명코드*100 + 순번)
    (1, 0, 844, 5, 601),  # 인의동 844-5 -> 인동9길 7-3
    (1, 0, 845, 0, 602),  # 인의동 845 -> 인동9길 8
    (2, 1, 12, 0, 501),   # 선산읍 완전리 산 12 -> (테스트용으로) 왕궁로 100
]


def build_sample_db(path: Path) -> Path:
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA + INDEXES)
    conn.executemany("INSERT INTO roads VALUES (?,?,?,?,?,?,?)", ROADS)
    conn.executemany("INSERT INTO buildings VALUES (?,?,?,?,?,?)",
                     [(code * 100 + i, code, 0, 0, *(n if isinstance(n, tuple) else (n, 0)))
                      for code, ns in BUILDINGS.items() for i, n in enumerate(ns, 1)])
    conn.executemany("INSERT INTO areas VALUES (?,?,?,?,?)", AREAS)
    conn.executemany("INSERT INTO jibun VALUES (?,?,?,?,?)", JIBUN)
    conn.commit()
    conn.close()
    return path
