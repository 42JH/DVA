"""관제 화면(읽기 전용, 임시). 원본 ai/app/monitor + ai/app/events.py에서 흐름 엔진·통화 레지스트리 의존을 떼어 냈다.
통화 쪽은 Bus.publish로 알림만 던지고, 관제는 create_monitor_router에 넘긴 함수로 통화 목록을 읽는다.
이 패키지만 지우면 통째로 걷어낼 수 있다(통화 처리 코드는 관제를 import하지 않는다 — 알림은 bus 객체로만)."""

from monitor.bus import Bus
from monitor.router import create_monitor_router

__all__ = ["Bus", "create_monitor_router"]
