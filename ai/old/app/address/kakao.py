"""확정한 도로명주소 → 지번·동명·우편번호·좌표(카카오 로컬 "주소로 좌표 변환", spec/address.md).
백엔드 COMPLETE 접수에 이 값들이 필요하다. 키(KAKAO_REST_API_KEY)가 없거나 못 찾으면 None(임의 값으로 채우지 않는다)."""

import logging
import os
import re

import httpx2

from app.order import Geo

log = logging.getLogger(__name__)

URL = "https://dapi.kakao.com/v2/local/search/address.json"


async def geocode(address: str, timeout_sec: float, transport: httpx2.AsyncBaseTransport | None = None) -> Geo | None:
    key = os.environ.get("KAKAO_REST_API_KEY")
    if not key:
        log.warning("KAKAO_REST_API_KEY가 없어 주소 좌표를 찾지 않습니다")
        return None
    try:
        async with httpx2.AsyncClient(timeout=timeout_sec, transport=transport) as http:
            resp = await http.get(URL, params={"query": address}, headers={"Authorization": f"KakaoAK {key}"})
        resp.raise_for_status()
        docs = resp.json()["documents"]
    except Exception as e:
        log.warning("카카오 주소 검색 실패: %s", type(e).__name__)  # 주소는 개인정보라 남기지 않는다
        return None
    for doc in docs:
        road, jibun = doc.get("road_address") or {}, doc.get("address") or {}
        postal, dong = road.get("zone_no") or "", jibun.get("region_3depth_name") or road.get("region_3depth_name")
        if re.fullmatch(r"\d{5}", postal) and dong and jibun.get("address_name"):
            try:
                return Geo(jibun_address=jibun["address_name"], dong_name=dong, postal_code=postal,
                           latitude=float(doc["y"]), longitude=float(doc["x"]))
            except (KeyError, ValueError):
                continue
    log.info("카카오 주소 검색 결과 없음")
    return None
