"""CallRegistry: 진행 통화 색인(session_id → CallSession, 발신번호 → 목록), 동시 통화 상한, 같은 session_id 중복 거부.
단일 인스턴스 전제(decisions.md P3) — 다중 워커에서는 이 색인이 갈라진다(concurrency.md §7)."""

from app.calls.session import ENDED, CallSession


class CallRegistry:
    def __init__(self, max_active: int):
        self.max_active = max_active
        self.calls: dict[str, CallSession] = {}
        # 이 프로세스에서 받은 적 있는 session_id(다른 webhook-id로 다시 와도 1회만)
        # shortcut: 프로세스 수명 동안 쌓인다(id당 수십 바이트) — 하루 수만 통화를 넘으면 TTL로 바꾼다
        self.seen: set[str] = set()

    def admit(self, session: CallSession) -> str:
        """'ok' · 'duplicate'(같은 session_id) · 'full'(상한 초과 → reject 486)."""
        if session.call_id in self.seen:
            return "duplicate"
        self.seen.add(session.call_id)
        if sum(1 for c in self.calls.values() if c.phase not in ENDED) >= self.max_active:
            return "full"
        self.calls[session.call_id] = session
        return "ok"

    def remove(self, call_id: str) -> None:
        self.calls.pop(call_id, None)

    def active_by_caller(self, caller: str | None) -> list[CallSession]:
        return [c for c in self.calls.values() if caller and c.caller == caller and c.phase not in ENDED]

    def snapshots(self) -> list[dict]:
        return [c.snapshot() for c in self.calls.values()]
