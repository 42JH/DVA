"""테스트용 작은 주소DB(실제 행안부 DB 없이 보정기를 시험). 도구 테스트도 같이 쓴다."""

import sqlite3
from pathlib import Path

from app.address.gazetteer import INDEXES, SCHEMA, build_names, name_variants

ROADS = [  # (도로명코드, 읍면동일련번호, 도로명, 시도, 시군구, 읍면동, 읍면동구분 0:읍면 1:동)
    (1, 0, "테헤란로", "서울특별시", "강남구", "역삼동", "1"),
    (2, 0, "테헤란로1길", "서울특별시", "강남구", "역삼동", "1"),
    (3, 0, "테헤란로2길", "서울특별시", "강남구", "역삼동", "1"),
    (4, 0, "판교역로", "경기도", "성남시 분당구", "백현동", "1"),
    (5, 0, "왕궁로", "전북특별자치도", "익산시", "왕궁면", "0"),
    (6, 0, "인동9길", "경상북도", "구미시", "인의동", "1"),
    (7, 0, "올림픽로", "서울특별시", "송파구", "신천동", "1"),
    (8, 0, "중앙로", "서울특별시", "양천구", "신정동", "1"),  # 전국에 흔한 도로명: 두 지역에 같은 번호 232
    (9, 0, "중앙로", "경기도", "고양시 덕양구", "주교동", "1"),
]
BUILDINGS = {1: (111, 115, 211, 212, 21), 2: (10, 32), 3: (32,), 4: (166,), 5: (100,), 6: ((7, 3), (8, 0)), 7: (300, 240),
             8: (232,), 9: (232, 1)}
# 부가정보 건물명(실제 표기처럼 긴 이름·같은 이름 여러 건물): 건물 = 도로명코드*100 + 순번
BUILDING_NAMES = [(701, "롯데월드타워앤드롯데월드몰"), (702, "롯데월드"), (104, "포스코센터"), (401, "카카오 판교 아지트")]
AREAS = [(1, "경상북도", "구미시", "인의동", ""), (2, "경상북도", "구미시", "선산읍", "완전리"),
         (3, "서울특별시", "강남구", "역삼동", ""), (4, "서울특별시", "송파구", "신천동", "")]
JIBUN = [  # (법정동·리, 산여부, 번지, 호, 건물 = 도로명코드*100 + 순번, 대표여부)
    (1, 0, 844, 5, 601, 1),  # 인의동 844-5 -> 인동9길 7-3
    (1, 0, 845, 0, 602, 1),  # 인의동 845 -> 인동9길 8
    (2, 1, 12, 0, 501, 1),   # 선산읍 완전리 산 12 -> (테스트용으로) 왕궁로 100
    (3, 0, 737, 0, 104, 1),  # 역삼동 737 -> 테헤란로 212 (테스트용 배치)
    (3, 0, 738, 0, 104, 0),  # 같은 건물의 비대표 지번
    (4, 0, 29, 0, 701, 1),   # 신천동 29 -> 올림픽로 300
]
POSTAL = {104: (6220, 1), 501: (54546, 2), 701: (5551, 3)}  # 건물 -> (우편번호, 행정동 id). 나머지는 없음(카카오로 보완)
HDONGS = [(1, "1168064000", "역삼2동"), (2, "4514025000", "왕궁면"), (3, "1171063000", "잠실6동")]


def build_sample_db(path: Path) -> Path:
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA + INDEXES)
    conn.executemany("INSERT INTO roads VALUES (?,?,?,?,?,?,?)", ROADS)
    conn.executemany("INSERT INTO buildings VALUES (?,?,?,?,?,?,?,?)",
                     [(code * 100 + i, code, 0, 0, *(n if isinstance(n, tuple) else (n, 0)), *POSTAL.get(code * 100 + i, (None, None)))
                      for code, ns in BUILDINGS.items() for i, n in enumerate(ns, 1)])
    conn.executemany("INSERT INTO hdongs VALUES (?,?,?)", HDONGS)
    conn.executemany("INSERT INTO building_names VALUES (?,?)", [(b, v) for b, n in BUILDING_NAMES for v in name_variants(n)])
    conn.executemany("INSERT INTO areas VALUES (?,?,?,?,?)", AREAS)
    conn.executemany("INSERT INTO jibun VALUES (?,?,?,?,?,?)", JIBUN)
    build_names(conn)
    conn.commit()
    conn.close()
    return path
