"""통화 trace_id와 구간 측정(latency-strategy.md §4.1). 지표 저장소는 S7에서 붙인다 — 지금은 로그와 훅만."""

import logging
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar

log = logging.getLogger("trace")
trace_id_var: ContextVar[str] = ContextVar("trace_id", default="-")
# 구간이 끝날 때마다 (이름, ms, 속성)으로 불린다. 테스트·지표 수집기가 바꿔 끼운다.
span_hooks: list[Callable[[str, float, dict], None]] = []


def new_trace() -> str:
    """통화 수신 시 1회. 이 태스크와 자식 태스크의 로그·구간에 붙는다."""
    trace_id = uuid.uuid4().hex
    trace_id_var.set(trace_id)
    return trace_id


class TraceFilter(logging.Filter):
    """로그 레코드에 trace_id를 넣는다(포맷에 %(trace_id)s)."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = trace_id_var.get()
        return True


@contextmanager
def span(name: str, **attrs) -> Iterator[dict]:
    """with span("backend_http", op="order_detail") as s: ... — s에 결과 속성(예: s["outcome"])을 더할 수 있다."""
    t0 = time.perf_counter()
    try:
        yield attrs
    finally:
        ms = (time.perf_counter() - t0) * 1000
        log.debug("span %s %.1fms %s", name, ms, attrs)
        for hook in span_hooks:
            hook(name, ms, attrs)
