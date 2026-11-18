"""카카오 로컬 검색. (1) 확정한 도로명주소 → 지번·동명·우편번호(geocode, "주소로 좌표 변환"). 백엔드 COMPLETE 접수에 이 값들이
필요하다. 위도·경도는 백엔드 계약에서 제거됐다(보내면 400, docs/be-contract/backend/address-coordinates-removal.md): 받지도 보내지도 않는다.
(2) 두 번째 근거(search_places·search_addresses): 로컬 보정이 못 찾았거나 약할 때 상호·약칭(키워드 검색)과 건물명이 섞인 주소
(analyze_type=similar)를 찾는다. 결과는 도로명주소 문자열이며, 채택 여부는 주소DB 검증 뒤 matcher.with_witness가 정한다.
키(KAKAO_REST_API_KEY)가 없거나 못 찾으면 None/빈 목록(임의 값으로 채우지 않는다). 무료 일 100,000건, 초과 시 429."""

import logging
import os
import re

import httpx2

from app.domain.state import Geo

log = logging.getLogger(__name__)

URL = "https://dapi.kakao.com/v2/local/search/address.json"
KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
WITNESS_TOP = 3  # 두 번째 근거로 볼 상위 결과 수(아래쪽 결과는 다른 지역의 비슷한 이름이 섞인다)


def has_key() -> bool:
    return bool(os.environ.get("KAKAO_REST_API_KEY"))


async def _documents(url: str, params: dict, timeout_sec: float, transport: httpx2.AsyncBaseTransport | None = None,
                     http: httpx2.AsyncClient | None = None) -> list[dict] | None:
    """한 번의 검색 -> documents. 키 없음·실패는 None. http = 공유 클라이언트(concurrency.md §6.1, keep-alive), 없으면 호출마다 만든다."""
    key = os.environ.get("KAKAO_REST_API_KEY")
    if not key:
        log.warning("KAKAO_REST_API_KEY가 없어 카카오 검색을 건너뜁니다")
        return None
    try:
        headers = {"Authorization": f"KakaoAK {key}"}
        if http is not None:
            resp = await http.get(url, params=params, headers=headers, timeout=timeout_sec)
        else:
            async with httpx2.AsyncClient(timeout=timeout_sec, transport=transport) as own:
                resp = await own.get(url, params=params, headers=headers)
        resp.raise_for_status()
        return resp.json()["documents"]
    except Exception as e:
        log.warning("카카오 검색 실패: %s", type(e).__name__)  # 주소는 개인정보라 남기지 않는다
        return None


async def geocode(address: str, timeout_sec: float, transport: httpx2.AsyncBaseTransport | None = None,
                  http: httpx2.AsyncClient | None = None) -> Geo | None:
    docs = await _documents(URL, {"query": address}, timeout_sec, transport, http)
    for doc in docs or []:
        road, jibun = doc.get("road_address") or {}, doc.get("address") or {}
        postal, dong = road.get("zone_no") or "", jibun.get("region_3depth_name") or road.get("region_3depth_name")
        if re.fullmatch(r"\d{5}", postal) and dong and jibun.get("address_name"):
            return Geo(jibun_address=jibun["address_name"], dong_name=dong, postal_code=postal)
    if docs is not None:
        log.info("카카오 주소 검색 결과 없음")
    return None


async def search_places(query: str, timeout_sec: float, transport: httpx2.AsyncBaseTransport | None = None,
                        http: httpx2.AsyncClient | None = None) -> list[tuple[str, str]]:
    """키워드 장소 검색 -> 상위 결과의 (도로명주소("서울 송파구 올림픽로 300"), 장소명("롯데월드타워"))들.
    상호·약칭("서울시청")·POI를 받아 준다. 장소명은 상세주소 앞에 붙인다(AddressResult.place)."""
    docs = await _documents(KEYWORD_URL, {"query": query, "size": 5}, timeout_sec, transport, http)
    return [(d["road_address_name"], d.get("place_name") or "") for d in docs or [] if d.get("road_address_name")][:WITNESS_TOP]


async def search_addresses(query: str, timeout_sec: float, transport: httpx2.AsyncBaseTransport | None = None,
                           http: httpx2.AsyncClient | None = None) -> list[str]:
    """주소 검색(analyze_type=similar: "입력한 건물명과 일부만 매칭될 경우에도 확장된 검색 결과") -> 도로명주소들."""
    docs = await _documents(URL, {"query": query, "analyze_type": "similar", "size": 5}, timeout_sec, transport, http)
    return [ra["address_name"] for d in docs or [] if (ra := d.get("road_address")) and ra.get("address_name")][:WITNESS_TOP]
