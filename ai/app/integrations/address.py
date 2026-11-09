"""주소 서비스: 주소DB 보정(app/address, CPU·SQLite) + 접수용 지번·동명·우편번호(주소DB, 비면 카카오).

- 보정은 전용 스레드풀에서 돈다(concurrency.md §6.2 "주소 보정 실행기", 이벤트 루프를 막지 않음).
- 카카오는 공유 클라이언트 1개 + 세마포어(호출 한도 [미확인]).
- 예산 2.5초(error-recovery.md §3). 장애·초과는 status="error" — 호출자는 들은 값으로 진행하고 geo 없음으로 둔다.
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
    area: str | None = None       # 상호·건물 이름만으로 찾았을 때 고객에게 확인할 시·군·구와 동("강남구 역삼동"). 번호를 들었으면 None


def area_of(address: str, geo: Geo | None) -> str:
    """확인용 지역: 지번주소의 시·군·구와 동("서울 강남구 역삼동 737" → "강남구 역삼동"). 지번이 없으면 도로명주소의 시·군·구만."""
    if geo and geo.dong_name in geo.jibun_address:
        head = geo.jibun_address.split(" ", 1)[-1]
        return head[:head.index(geo.dong_name) + len(geo.dong_name)]
    return " ".join(address.split()[1:-2])  # 시도·도로명·번호를 뺀 가운데("성남시 분당구")


class AddressService:
    def __init__(self, db: AddressDB | None = None, workers: int = 2, kakao_concurrency: int = 8,
                 kakao_timeout_sec: float = 3.0, budget_sec: float = 2.5, http: httpx2.AsyncClient | None = None):
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
        detail = None
        if self.db is None:
            status, address, alternatives = "off", heard, ()
        else:
            with span("address", step="correct"):  # 들은 문장에서 상세주소를 떼고(서버가 가른다) 기본주소를 보정
                r, heard, raw = await asyncio.get_running_loop().run_in_executor(
                    self.pool, matcher.resolve_detail, self.db, heard)
            detail = detail_text(raw) if raw else None
            if (r.status == "not_found" or r.weak) and kakao.has_key():
                with span("address", step="witness"):
                    r = await self._witness(heard, r)
            if r.status in ("not_found", "region_needed"):
                return AddressResult(r.status, None, r.candidates, None, detail)
            cands = list(r.candidates) or [r.address]
            status, address, alternatives = r.status, cands[0], tuple(cands[1:])
        geo = None
        if self.db is not None:  # 접수용 값은 주소DB에서(4단계 Geo 로컬화, 2026-11-06). 비어 있으면 카카오로 보완
            with span("address", step="geo"):
                geo = await asyncio.get_running_loop().run_in_executor(self.pool, self.db.geo, address)
        if geo is None:
            with span("address", step="geocode"):
                async with self.kakao_sem:
                    geo = await kakao.geocode(address, self.kakao_timeout_sec, http=self.http)
        area = area_of(address, geo) if status in ("confirmed", "ambiguous") and matcher.named_only(heard) else None
        return AddressResult(status, address, alternatives, geo, detail, area)

    async def _witness(self, heard: str, local: matcher.Resolution) -> matcher.Resolution:
        """두 번째 근거: 로컬이 못 찾았거나 약하면(지역 없는 건물명 확정·소리를 고친 되묻기) 카카오 키워드·주소(similar) 검색을
        병렬로 부르고, 결과 주소를 주소DB로 검증해 다시 판정한다(matcher.with_witness). 실패·결과 없음이면 로컬 결과 그대로."""
        async with self.kakao_sem:
            places, addresses = await asyncio.gather(
                kakao.search_places(heard, self.kakao_timeout_sec, http=self.http),
                kakao.search_addresses(heard, self.kakao_timeout_sec, http=self.http))
        texts = list(dict.fromkeys(places + addresses))
        if not texts:
            return local
        return await asyncio.get_running_loop().run_in_executor(self.pool, matcher.with_witness, self.db, local, texts, heard)
