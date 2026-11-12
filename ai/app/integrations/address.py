"""주소 서비스: 주소DB 보정(app/address, CPU·SQLite) + 접수용 지번·동명·우편번호(주소DB, 비면 카카오).

- 보정은 전용 스레드풀에서 돈다(concurrency.md §6.2 "주소 보정 실행기", 이벤트 루프를 막지 않음).
- 카카오는 공유 클라이언트 1개 + 세마포어(호출 한도 [미확인]).
- 예산 3초(error-recovery.md §3). 장애·초과는 status="error" — 호출자는 들은 값으로 진행하고 geo 없음으로 둔다.
- 주소DB가 없으면(db=None) status="off": 들은 그대로 기록하고 geo만 찾는다.
"""

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Literal

import httpx2

from app.address import matcher
from app.address.gazetteer import AddressDB
from app.address.parse import detail_text
from app.domain.state import Geo
from app.integrations import kakao
from app.observability.trace import span

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class AddressResult:
    status: Literal["confirmed", "ambiguous", "region_needed", "not_found", "off", "error"]
    address: str | None           # 기록할 주소(confirmed·ambiguous=보정 주소 1순위, off·error=들은 그대로)
    alternatives: tuple[str, ...]  # ambiguous일 때 나머지 후보(P6: 보관), region_needed일 때 되물을 지역 이름(최대 3)
    geo: Geo | None
    detail: str | None = None     # 들은 문장에서 서버가 뗀 상세주소(수사는 숫자로, "312동 403호"). 없으면 None
    place: str | None = None      # 건물명·상호명으로 확정했을 때 검색이 찾은 이름. 상세주소 앞에 붙인다


class AddressService:
    def __init__(self, db: AddressDB | None = None, workers: int = 2, kakao_concurrency: int = 8,
                 kakao_timeout_sec: float = 3.0, budget_sec: float = 3.0, http: httpx2.AsyncClient | None = None):
        self.db = db
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="address")
        self.kakao_sem = asyncio.Semaphore(kakao_concurrency)
        self.kakao_timeout_sec = kakao_timeout_sec
        self.budget_sec = budget_sec
        self.http = http or httpx2.AsyncClient()

    async def close(self) -> None:
        await self.http.aclose()
        self.pool.shutdown(wait=False, cancel_futures=True)

    async def resolve(self, heard: str) -> AddressResult:
        try:
            return await asyncio.wait_for(self._resolve(heard), self.budget_sec)
        except TimeoutError:
            log.warning("주소 처리 시간 초과")
            return AddressResult("error", heard, (), None)
        except Exception as e:  # 보정·지오코딩 장애는 대화를 막지 않는다(error-recovery.md §4)
            log.warning("주소 처리 장애: %s", type(e).__name__)
            return AddressResult("error", heard, (), None)

    async def _resolve(self, heard: str) -> AddressResult:
        detail = place = None
        if self.db is None:
            status, address, alternatives = "off", heard, ()
        else:
            # 상호명은 주소DB에 없어 로컬 보정이 다시 보기 상한까지 다 쓰고 not_found로 끝난다(운영 1.1초, 부하 시 예산 초과로
            # 들은 값이 기록됨) — 카카오 검색을 로컬 보정과 동시에 시작해 두고, 두 번째 근거가 필요할 때만 결과를 쓴다
            early = asyncio.create_task(self._search(heard)) if kakao.has_key() else None
            try:
                with span("address", step="correct"):  # 들은 문장에서 상세주소를 떼고(서버가 가른다) 기본주소를 보정
                    r, base, raw = await asyncio.get_running_loop().run_in_executor(
                        self.pool, matcher.resolve_detail, self.db, heard)
                detail = detail_text(raw) if raw else None
                if early is not None and (r.status == "not_found" or r.weak):
                    with span("address", step="witness"):  # 상세주소를 뗐으면 기본주소로 다시 검색(이전과 같은 질의)
                        texts, names = await (early if base == heard else self._search(base))
                        if texts:
                            r = await asyncio.get_running_loop().run_in_executor(
                                self.pool, matcher.with_witness, self.db, r, texts, base, names)
            finally:
                if early is not None:
                    early.cancel()
            if r.status in ("not_found", "region_needed"):
                return AddressResult(r.status, None, r.candidates, None, detail)
            cands = list(r.candidates) or [r.address]
            status, address, alternatives = r.status, cands[0], tuple(cands[1:])
            place = r.place if r.status == "confirmed" else None
        geo = None
        if self.db is not None:  # 접수용 값은 주소DB에서(4단계 Geo 로컬화, 2026-11-06). 비어 있으면 카카오로 보완
            with span("address", step="geo"):
                geo = await asyncio.get_running_loop().run_in_executor(self.pool, self.db.geo, address)
        if geo is None:
            with span("address", step="geocode"):
                async with self.kakao_sem:
                    geo = await kakao.geocode(address, self.kakao_timeout_sec, http=self.http)
        return AddressResult(status, address, alternatives, geo, detail, place)

    async def _search(self, query: str) -> tuple[list[str], dict[str, str]]:
        """두 번째 근거: 카카오 키워드·주소(similar) 검색을 병렬로 불러 (도로명주소들(중복 제거), {도로명주소: 장소명}).
        실패·결과 없음은 빈 목록.
        채택은 주소DB로 검증한 뒤 matcher.with_witness가 정한다(로컬이 못 찾았거나 약할 때만)."""
        async with self.kakao_sem:
            places, addresses = await asyncio.gather(
                kakao.search_places(query, self.kakao_timeout_sec, http=self.http),
                kakao.search_addresses(query, self.kakao_timeout_sec, http=self.http))
        names = {}
        for road, name in places:
            if name:
                names.setdefault(road, name)
        return list(dict.fromkeys([road for road, _ in places] + addresses)), names
