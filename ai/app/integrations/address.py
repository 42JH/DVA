"""주소 서비스(Address Resolver 어댑터). 주소DB 보정(CPU·SQLite) + 카카오 지번·동명·우편번호.

- 보정은 전용 스레드풀에서 돈다(concurrency.md §6.2 "주소 보정 실행기", 이벤트 루프를 막지 않음).
- 카카오는 공유 클라이언트 1개 + 세마포어(호출 한도 [미확인]).
- 예산 2.5초(error-recovery.md §3). 장애·초과는 status="error" — 호출자는 들은 값으로 진행하고 geo 없음으로 둔다.
"""

import asyncio
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Literal

import httpx2

import address_resolver
from address_resolver import kakao
from app.domain.state import Geo
from app.observability.trace import span

log = logging.getLogger(__name__)


_GIL = re.compile(r"(?<=[가-힣])([영공일이삼사오육칠팔구십백]+번?길)(?=\s|$)")


def split_gil(heard: str) -> str | None:
    """"인동구길" → "인동 구길": 붙여 쓴 한글 길 번호를 띄운다(보정기는 띄운 "구길"만 9길로 읽는다). 바뀐 게 없으면 None.
    못 찾았을 때만 쓴다 — 아무 데서나 떼면 "구미"처럼 숫자 글자로 시작하는 이름을 자를 수 있어서."""
    spaced = _GIL.sub(r" \1", heard)
    return spaced if spaced != heard else None


def retries(heard: str) -> list[str]:
    """못 찾았을 때 차례로 다시 볼 표기: 붙인 길 번호 띄우기, 쉼표 뒤(건물 이름) 떼기
    (2026-11-03 통화 98b348: "도림로143길 27, 리버뷰 신안 인스빌")."""
    road = heard.split(",")[0].strip() if "," in heard else ""
    out = [split_gil(heard), road if road and road != heard else None, split_gil(road) if road else None]
    return list(dict.fromkeys(x for x in out if x))


# 받아쓴 그대로 넘긴 기본주소의 말끝(backend_rules.md). "이요"·"이에요"는 앞 글자에 받침이 있으면 두 가지로 읽힌다
# ("테헤란로 이일이요" = "이일이"+"요" / "이일"+"이요"). 이름은 문법만으로 정하지만(record.clean_name) 번호는 글자만으로
# 못 정해서, 두 해석을 다 찾아 보고 주소DB에 있는 쪽을 쓴다(둘 다 있으면 후보 둘 — 확정하지 않음)
_ENDING = re.compile(r"\s*(입니다|이에요|예요|에요|이요|요)[.!?\s]*$")


def _has_final(ch: str) -> bool:
    return "가" <= ch <= "힣" and (ord(ch) - 0xAC00) % 28 != 0


def endings(heard: str) -> list[str]:
    """말끝을 뗀 해석(1~2개). 말끝이 없으면 빈 목록."""
    m = _ENDING.search(heard)
    if not m:
        return []
    base = heard[:m.start()].rstrip()
    if m[1] in ("이요", "이에요"):
        with_i = base + "이"
        out = [base, with_i] if _has_final(base[-1:]) else [with_i]
    else:
        out = [base]
    return [x for x in out if x]


@dataclass(frozen=True)
class AddressResult:
    status: Literal["confirmed", "ambiguous", "not_found", "off", "error"]
    address: str | None           # 기록할 주소(confirmed·ambiguous=보정 주소 1순위, off·error=들은 그대로)
    alternatives: tuple[str, ...]  # ambiguous일 때 나머지 후보(P6: 보관)
    geo: Geo | None


class AddressService:
    def __init__(self, workers: int = 2, kakao_concurrency: int = 8, kakao_timeout_sec: float = 3.0,
                 budget_sec: float = 2.5, http: httpx2.AsyncClient | None = None):
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
        with span("address", step="correct"):
            r = await self._correct(heard)
            if r is not None and r["status"] == "not_found":
                r = await self._retry(heard) or r
        if r is None:
            status, address, alternatives = "off", heard, ()
        elif r["status"] == "not_found":
            return AddressResult("not_found", None, (), None)
        else:
            cands = list(r["candidates"]) or [r["address"]]
            status, address, alternatives = r["status"], cands[0], tuple(cands[1:])
        with span("address", step="geocode"):
            async with self.kakao_sem:
                g = await kakao.geocode(address, self.kakao_timeout_sec, http=self.http)
        geo = Geo(g.jibun_address, g.dong_name, g.postal_code) if g else None
        return AddressResult(status, address, alternatives, geo)

    async def _correct(self, text: str) -> dict | None:
        return await asyncio.get_running_loop().run_in_executor(self.pool, address_resolver.correct_blocking, text)

    async def _retry(self, heard: str) -> dict | None:
        """못 찾았을 때: 말끝 해석마다 다시 보는 표기(retries)를 차례로 보고 처음 찾은 것. 해석이 둘이고 둘 다 찾으면 후보 둘."""
        found = []
        for base in endings(heard) or [heard]:
            for text in ([base] if base != heard else []) + retries(base):
                r = await self._correct(text)
                if r["status"] != "not_found":
                    found.append(r)
                    break
        found = [r for r in found if r["status"] == "confirmed"] or found  # 그대로 있는 해석이 고쳐야 맞는 해석보다 먼저
        if len(found) < 2:
            return found[0] if found else None
        cands = list(dict.fromkeys(c for r in found for c in (r["candidates"] or [r["address"]])))
        return found[0] if len(cands) == 1 else {"status": "ambiguous", "address": cands[0], "candidates": cands}
