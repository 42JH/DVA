"""통화 쪽 → 관제 쪽 알림. 통화 처리는 알림만 던지고 기다리지 않는다(느린 구독자는 버린다)."""

import asyncio

QUEUE_SIZE = 256


class Bus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(QUEUE_SIZE)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def publish(self, message: dict) -> None:
        for q in self._subscribers:
            try:
                q.put_nowait(message)
            except asyncio.QueueFull:
                pass  # 못 따라오는 관제 클라이언트는 이번 알림을 놓친다


bus = Bus()
