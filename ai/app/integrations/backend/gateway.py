"""BE 호출 게이트웨이(error-recovery.md §2.1·§3, concurrency.md §6).

backend_client.api(BE 계약: 경로·본문 매핑·응답 해석)를 감싸 다음만 더한다.
- 실패를 BackendFailure(kind, code, http_status, error_code, retryable)로 구조화 — 업무 오류와 시스템 오류를 가른다.
- 전역 세마포어(동시 요청 상한)와 시간 예산. 세마포어 대기도 예산에 포함하고, 대기만으로 넘으면 즉시 unavailable.
- 읽기는 재시도 가능한 장애에 1회 재시도(남은 예산 안). 쓰기는 재시도하지 않는다(결과 불확실 = unknown은 호출자가 판단).
- 사용하는 응답 필드가 없거나 형식이 다르면(KeyError 등) BE_CONTRACT_VIOLATION으로 경보.
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, TypeVar

import httpx2

from app.observability.trace import observe_backend, span
from backend_client.api import IN_PROGRESS, BackendError

log = logging.getLogger(__name__)
T = TypeVar("T")
Kind = Literal["unavailable", "in_progress", "state", "forbidden", "not_found", "contract"]


@dataclass
class BackendFailure(Exception):
    kind: Kind
    code: str                      # BE_UNAVAILABLE · BE_TIMEOUT · BE_INVALID_STATE · BE_FORBIDDEN · BE_NOT_FOUND · BE_CONTRACT_VIOLATION
    op: str = ""
    http_status: int | None = None
    error_code: str | None = None  # BE 응답 error.code
    retryable: bool = False

    def __str__(self) -> str:
        return f"{self.op} {self.code} http={self.http_status} error={self.error_code}"


def classify(exc: BaseException, op: str = "") -> BackendFailure:
    """예외 → BackendFailure. 표: error-recovery.md §2.1."""
    def f(kind: Kind, code: str, status=None, error=None, retryable=False) -> BackendFailure:
        return BackendFailure(kind, code, op, status, error, retryable)

    if isinstance(exc, BackendFailure):
        return exc
    if isinstance(exc, httpx2.TimeoutException):
        return f("unavailable", "BE_TIMEOUT", retryable=True)
    if isinstance(exc, httpx2.TransportError):
        return f("unavailable", "BE_UNAVAILABLE", retryable=True)
    if isinstance(exc, (KeyError, TypeError, ValueError)):  # 사용하는 응답 필드 누락·형식 오류
        return f("contract", "BE_CONTRACT_VIOLATION")
    if not isinstance(exc, BackendError):
        raise exc  # 예상하지 못한 예외는 삼키지 않는다
    status, error = exc.status, exc.code
    if status is None:  # 응답 없는 실패: 연결 실패·결과 확인 시간 초과·토큰 미설정·클라이언트 검사
        if error in ("ARGUMENT_INVALID", "RESPONSE_INVALID"):  # AI 쪽 인수 오류·응답 형식 오류
            return f("contract", "BE_CONTRACT_VIOLATION", None, error)
        return f("unavailable", "BE_UNAVAILABLE", None, error, retryable=error == "TRANSPORT")
    if status in (202, 504) or (status == 409 and error == IN_PROGRESS):
        return f("in_progress", "BE_UNAVAILABLE", status, error)
    if status >= 500:
        return f("unavailable", "BE_UNAVAILABLE", status, error, retryable=True)
    if status == 409:
        return f("state", "BE_INVALID_STATE", status, error)
    if status == 403:
        return f("forbidden", "BE_FORBIDDEN", status, error)
    if status == 404:
        return f("not_found", "BE_NOT_FOUND", status, error)
    return f("contract", "BE_CONTRACT_VIOLATION", status, error)  # 400·422·401 등: AI 본문·설정 오류


class BackendGateway:
    def __init__(self, api, max_concurrency: int = 16, read_budget_sec: float = 3.0, write_budget_sec: float = 5.0):
        self.api = api  # BackendAPI 또는 MockBackend(같은 메서드)
        self.sem = asyncio.Semaphore(max_concurrency)
        self.read_budget_sec = read_budget_sec
        self.write_budget_sec = write_budget_sec

    async def read(self, op: str, fn: Callable[..., Awaitable[T]], *args, budget_sec: float | None = None, **kw) -> T:
        """부작용 없는 호출. 재시도 가능한 장애면 남은 예산 안에서 1회 더."""
        deadline = time.monotonic() + (budget_sec or self.read_budget_sec)
        try:
            return await self._once(op, fn, args, kw, deadline)
        except BackendFailure as e:
            if not e.retryable or deadline - time.monotonic() <= 0:
                raise
            log.info("BE 읽기 재시도 %s", e)
            return await self._once(op, fn, args, kw, deadline)

    async def write(self, op: str, fn: Callable[..., Awaitable[T]], *args, budget_sec: float | None = None, **kw) -> T:
        """부작용 있는 호출. 재시도하지 않는다 — 같은 키 재확인은 BackendAPI.submit_result가, 취소 재확인은 호출자가."""
        return await self._once(op, fn, args, kw, time.monotonic() + (budget_sec or self.write_budget_sec))

    async def _once(self, op, fn, args, kw, deadline: float):
        t0, outcome, http, error = time.monotonic(), "ok", None, None
        try:
            return await self._call(op, fn, args, kw, deadline)
        except BackendFailure as e:
            outcome, http, error = e.code, e.http_status, e.error_code
            raise
        finally:  # 관제: 대기(세마포어) 포함 걸린 시간과 결과
            observe_backend(op, round((time.monotonic() - t0) * 1000), outcome, http, error)

    async def _call(self, op, fn, args, kw, deadline: float):
        with span("semaphore_wait", resource="backend", op=op):
            try:
                await asyncio.wait_for(self.sem.acquire(), max(0.0, deadline - time.monotonic()))
            except TimeoutError:
                raise BackendFailure("unavailable", "BE_UNAVAILABLE", op, error_code="SEMAPHORE_TIMEOUT") from None
        try:
            with span("backend_http", op=op) as s:
                try:
                    result = await asyncio.wait_for(fn(*args, **kw), max(0.0, deadline - time.monotonic()))
                except TimeoutError:
                    s["outcome"] = "BE_TIMEOUT"
                    raise BackendFailure("unavailable", "BE_TIMEOUT", op) from None
                except BackendFailure:
                    raise
                except Exception as e:
                    failure = classify(e, op)
                    s["outcome"] = failure.code
                    if failure.kind == "contract":
                        log.error("BE 계약 위반 %s (%s)", failure, type(e).__name__)  # 경보 대상(error-recovery.md §6)
                    raise failure from e
                s["outcome"] = "ok"
                return result
        finally:
            self.sem.release()
