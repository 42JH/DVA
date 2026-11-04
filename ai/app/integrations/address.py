"""주소 서비스: 주소DB 보정(app/address, CPU·SQLite) + 카카오 지번·동명·우편번호.

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
from app.domain.state import Geo
from app.integrations import kakao
from app.observability.trace import span

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class AddressResult:
    status: Literal["confirmed", "ambiguous", "not_found", "off", "error"]
    address: str | None           # 기록할 주소(confirmed·ambiguous=보정 주소 1순위, off·error=들은 그대로)
    alternatives: tuple[str, ...]  # ambiguous일 때 나머지 후보(P6: 보관)
    geo: Geo | None


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
        if self.db is None:
            status, address, alternatives = "off", heard, ()
        else:
            with span("address", step="correct"):
                r = await asyncio.get_running_loop().run_in_executor(self.pool, matcher.resolve, self.db, heard)
            if r.status == "not_found":
                return AddressResult("not_found", None, (), None)
            cands = list(r.candidates) or [r.address]
            status, address, alternatives = r.status, cands[0], tuple(cands[1:])
        with span("address", step="geocode"):
            async with self.kakao_sem:
                geo = await kakao.geocode(address, self.kakao_timeout_sec, http=self.http)
        return AddressResult(status, address, alternatives, geo)
