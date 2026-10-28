"""앱 하나가 공유하는 것: 설정·클라이언트·통화 레지스트리·백그라운드 작업. main이 만들어 app.state.svc에 둔다."""

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from app.call import Registry
from app.config import ServerConfig, Texts


@dataclass
class Services:
    cfg: ServerConfig
    texts: Texts
    client: Any  # AsyncOpenAI(테스트에서는 가짜)
    backend: Any  # BackendAPI(테스트에서는 가짜)
    registry: Registry
    seen_webhooks: dict[str, float] = field(default_factory=dict)
    tasks: set[asyncio.Task] = field(default_factory=set)
    rag: Any = None
    persona: Any = None  # PersonaManager(main이 만든다)

    def first_time(self, webhook_id: str | None) -> bool:
        """같은 webhook-id는 한 번만. 오래된 기록은 지운다."""
        now = time.time()
        ttl = self.cfg.call.webhook_dedupe_sec
        for k in [k for k, t in self.seen_webhooks.items() if now - t > ttl]:
            del self.seen_webhooks[k]
        if not webhook_id:
            return True
        if webhook_id in self.seen_webhooks:
            return False
        self.seen_webhooks[webhook_id] = now
        return True

    def spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task
