"""도구 실행 파이프라인(한 곳): 찾기 → 인수 검증 → 허용 단계 확인 → 실행(시간 제한) → 상태 전이 → 관제 기록.
없는 도구·검증 실패·허용되지 않은 단계·예외·시간 초과도 모두 오류 결과로 돌려준다(통화를 끊지 않는다)."""

import asyncio
import logging
import time

from pydantic import ValidationError

from app.flow import engine
from app.tools._base import TOOLS, ToolError

log = logging.getLogger(__name__)


def _validation_hint(e: ValidationError) -> str:
    return "; ".join(f"{'.'.join(map(str, err['loc'])) or '인수'}: {err['type']}" for err in e.errors()[:5])


async def dispatch(call, name: str, arguments: str, call_id: str) -> dict:
    record = call.tool_calls.setdefault(call_id, {"call_id": call_id, "name": name})
    record.update(name=name, arguments=arguments, status="running", started=time.time())
    call.notify()
    t0 = time.monotonic()
    events: list[str] = []
    try:
        tool = TOOLS.get(name)
        if tool is None:
            raise ToolError(f"없는 도구: {name}", "state.tools에 있는 도구만 쓰기")
        try:
            args = tool.args.model_validate_json(arguments or "{}")
        except ValidationError as e:
            raise ToolError("인수 오류", _validation_hint(e)) from None
        if name not in engine.allowed_tools(call):
            # 음성 모델은 거절된 위임 뒤 지시 없이 혼자 말한다(2026-11-01 20:05 통화): 진행 상태를 다시 보낸다
            call.progress_stale = True
            raise ToolError(f"지금 단계({call.flow.stage})에서 쓸 수 없는 도구", "state.next를 따르기")
        timeout = call.cfg.rag.timeout_sec if name == 'search_manual' else call.cfg.call.tool_timeout_sec
        result = await asyncio.wait_for(tool.run(call, args), timeout)
        events = result.events
        output = {"ok": True, **result.data}
    except ToolError as e:
        events = e.events
        output = {"ok": False, "error": e.error, "retry": e.retry}
    except TimeoutError:
        log.warning("도구 시간 초과 %s %s", call.session_id, name)
        output = {"ok": False, "error": "처리 시간 초과", "retry": "잠시 후 한 번만 다시 시도"}
    except Exception:
        log.exception("도구 예외 %s %s", call.session_id, name)
        output = {"ok": False, "error": "내부 오류", "retry": "잠시 후 한 번만 다시 시도, 계속되면 상담원 전환 안내"}
    try:
        await engine.apply(call, events, name)
    except Exception:
        log.exception("상태 전이 오류 %s %s %s", call.session_id, name, events)
    output["state"] = engine.summary(call)
    record.update(status="done" if output["ok"] else "error", output=output, events=events,
                  elapsed_ms=round((time.monotonic() - t0) * 1000))
    call.notify()
    return output
