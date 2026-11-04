"""BackendGateway: 실패 분류(error-recovery.md §2.1), 예산·세마포어·재시도(§3, concurrency.md §6.2)."""

import asyncio

import httpx2
import pytest
from conftest import run

from app.integrations.backend.gateway import BackendFailure, BackendGateway, classify
from app.observability import trace
from backend_client.api import BackendError


@pytest.mark.parametrize("exc, kind, code, retryable", [
    (httpx2.ConnectError("x"), "unavailable", "BE_UNAVAILABLE", True),
    (httpx2.ReadTimeout("x"), "unavailable", "BE_TIMEOUT", True),
    (BackendError("m", 503, "DEPENDENCY_UNAVAILABLE"), "unavailable", "BE_UNAVAILABLE", True),
    (BackendError("m", 500), "unavailable", "BE_UNAVAILABLE", True),
    (BackendError("m", 202), "in_progress", "BE_UNAVAILABLE", False),
    (BackendError("m", 409, "REQUEST_IN_PROGRESS"), "in_progress", "BE_UNAVAILABLE", False),
    (BackendError("m", 409, "INVALID_STATE"), "state", "BE_INVALID_STATE", False),
    (BackendError("m", 403, "FORBIDDEN"), "forbidden", "BE_FORBIDDEN", False),
    (BackendError("m", 404), "not_found", "BE_NOT_FOUND", False),
    (BackendError("m", 400, "INVALID_REQUEST"), "contract", "BE_CONTRACT_VIOLATION", False),
    (BackendError("m", 422, "VALIDATION_FAILED"), "contract", "BE_CONTRACT_VIOLATION", False),
    (BackendError("m", code="RESPONSE_INVALID"), "contract", "BE_CONTRACT_VIOLATION", False),
    (BackendError("m", code="TRANSPORT"), "unavailable", "BE_UNAVAILABLE", True),
    (BackendError("/api/orders 결과 확인 시간 초과"), "unavailable", "BE_UNAVAILABLE", False),
    (KeyError("data"), "contract", "BE_CONTRACT_VIOLATION", False),  # 사용하는 응답 필드 누락
])
def test_classify(exc, kind, code, retryable):
    f = classify(exc, "op")
    assert (f.kind, f.code, f.retryable) == (kind, code, retryable)


def test_classify_does_not_swallow_unexpected_errors():
    with pytest.raises(ZeroDivisionError):
        classify(ZeroDivisionError())


class Flaky:
    def __init__(self, *outcomes):
        self.outcomes, self.calls = list(outcomes), 0

    async def __call__(self):
        self.calls += 1
        o = self.outcomes.pop(0)
        if isinstance(o, BaseException):
            raise o
        if isinstance(o, float):
            await asyncio.sleep(o)
            return "slow"
        return o


def test_read_retries_once_on_retryable_and_write_never():
    gw = BackendGateway(object())
    fn = Flaky(BackendError("m", 503), "ok")
    assert run(gw.read("op", fn)) == "ok" and fn.calls == 2
    fn = Flaky(BackendError("m", 503), BackendError("m", 503), "ok")
    with pytest.raises(BackendFailure, match="BE_UNAVAILABLE"):
        run(gw.read("op", fn))
    assert fn.calls == 2  # 재시도는 1회만
    fn = Flaky(BackendError("m", 404), "ok")
    with pytest.raises(BackendFailure) as e:
        run(gw.read("op", fn))
    assert e.value.kind == "not_found" and fn.calls == 1  # 업무 결과는 재시도하지 않는다
    fn = Flaky(httpx2.ConnectError("x"), "ok")
    with pytest.raises(BackendFailure):
        run(gw.write("op", fn))
    assert fn.calls == 1  # 쓰기는 결과가 불확실해도 재시도하지 않는다


def test_budget_timeout_and_semaphore_wait_counts_in_budget():
    gw = BackendGateway(object(), max_concurrency=1)
    with pytest.raises(BackendFailure) as e:
        run(gw.read("op", Flaky(1.0), budget_sec=0.05))
    assert e.value.code == "BE_TIMEOUT"

    async def two():
        slow = asyncio.create_task(gw.read("hold", Flaky(0.3), budget_sec=1.0))
        await asyncio.sleep(0.01)
        with pytest.raises(BackendFailure) as e2:  # 자리를 기다리다 예산을 넘기면 즉시 unavailable
            await gw.read("wait", Flaky("ok"), budget_sec=0.05)
        assert e2.value.error_code == "SEMAPHORE_TIMEOUT"
        assert await slow == "slow"

    run(two())
    assert gw.sem._value == 1  # 실패해도 자리를 돌려준다


def test_spans_record_outcome():
    seen = []
    trace.span_hooks.append(lambda name, ms, attrs: seen.append((name, dict(attrs))))
    try:
        gw = BackendGateway(object())
        run(gw.read("order_detail", Flaky("ok")))
        with pytest.raises(BackendFailure):
            run(gw.read("order_detail", Flaky(KeyError("data"))))
    finally:
        trace.span_hooks.clear()
    http = [a for n, a in seen if n == "backend_http"]
    assert [a["outcome"] for a in http] == ["ok", "BE_CONTRACT_VIOLATION"]
    assert {n for n, _ in seen} == {"semaphore_wait", "backend_http"}


def test_gateway_records_backend_calls_for_current_call():
    """관제: 지금 통화(current_call)에 BE 호출의 op·결과·HTTP·오류·ms를 남긴다. 통화 밖이면 남기지 않는다."""
    import asyncio
    from app.integrations.backend.gateway import BackendFailure, BackendGateway
    from app.observability.trace import current_call

    class Call:
        def __init__(self):
            self.rows = []

        def record_backend(self, *row):
            self.rows.append(row)

    async def ok():
        return 1

    async def boom():
        raise BackendFailure("not_found", "BE_NOT_FOUND", "x", http_status=404, error_code="NOT_FOUND")

    async def scenario():
        gw = BackendGateway(object())
        await gw.read("outside", ok)  # 통화 밖: 기록 없음
        call = Call()
        current_call.set(call)
        await gw.read("caller_context", ok)
        try:
            await gw.write("cancel", boom)
        except BackendFailure:
            pass
        return call.rows

    rows = asyncio.run(scenario())
    assert [r[0] for r in rows] == ["caller_context", "cancel"]
    assert rows[0][2] == "ok" and rows[1][2:] == ("BE_NOT_FOUND", 404, "NOT_FOUND") and all(r[1] >= 0 for r in rows)
