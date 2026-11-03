# 관제 화면 (`monitor/`)

원본 `S15P31D109/ai`의 `app/monitor/` + `app/events.py` + `spec/monitor.md`를 옮겼다. 실시간 모니터링 전용 **임시** 화면이다.

## 원칙 (원본 유지)
- 통화 처리 코드는 관제를 몰라도 된다: 알림은 `Bus.publish`로 던지고 기다리지 않는다(느린 구독자는 버림, 큐 256).
- 개인정보가 보이므로 HTTP Basic 인증(`MONITOR_USER`·`MONITOR_PASSWORD`). 값이 없으면 503.
- 읽기 전용. 통화에 개입하는 버튼 없음. 프레임워크 없는 정적 HTML, 흰 바탕 + `#2ea3ff`.
- `monitor/` 패키지만 지우면 걷어낼 수 있다.

## 원본에서 뺀 것
| 원본 | 이유 |
|---|---|
| `/monitor/api/graph`(Mermaid 상태 그래프) | 옛 흐름 엔진(`app.flow.engine`) 전용. 새 설계는 Workflow Policy 단계(`docs/architecture/workflow-policy.md`) — 필요하면 정책 파일로 다시 그린다 |
| `/monitor/api/orders`(접수 주문 목록) | BE에 없는 옛 계약(`/internal/ai/orders`, `docs/contracts/be-api.md` B-9). 실제 BE에서는 실패했다 |
| 원본 화면의 주문·운임·단계 기록 전용 칸 | 원본 통화 객체(`Call.snapshot`) 형식 전용. 아래 일반 형식의 `detail`로 대체 |

## API
| 경로 | 내용 |
|---|---|
| `GET /monitor` | 화면 |
| `GET /monitor/api/calls` | 통화 스냅샷 목록 |
| `GET /monitor/api/stream` | SSE. 접속 시 현재 목록을 보내고, 이후 `{"type": "call", "call": 스냅샷}`. keepalive 15초 |

## 통화 스냅샷 형식 (화면이 읽는 키)

```json
{
  "session_id": "…", "caller": "010****5678", "started_at": 1762140000.0,
  "status": "accepting|active|ended", "stage": "선택", "end_reason": "remote_hangup|…|null",
  "transcript": [{"speaker": "customer|agent", "text": "…"}],
  "tool_calls": [{"name": "…", "status": "…", "elapsed_ms": 12, "arguments": "…", "output": {}}],
  "events": [{"at": 1762140001.0, "kind": "Decision(input)", "text": "…"}],
  "errors": [{"at": 1762140002.0, "message": "…"}],
  "detail": {"아무 키": "값 또는 객체"}
}
```
- `caller`는 반드시 마스킹(`pbx_webhook.mask_phone`).
- `detail`은 표로 그대로 보인다(새 서버는 Business State 요약·필드 상태를 여기에).

## 연결 방법
```python
from monitor import Bus, create_monitor_router
bus = Bus()
app.include_router(create_monitor_router(list_calls, bus))   # list_calls: () -> list[스냅샷]
bus.publish({"type": "call", "call": snapshot})             # 상태가 바뀔 때마다
```
현재 연결된 곳: 새 서버(`app/main.py`) — 받아쓰기, 도구 호출, 위임·Decision·전달(N1'·N2·N3) 사건, 단계·통계, 오류. 끝난 통화는 `MONITOR_RETAIN_ENDED_SEC`(기본 1800초) 동안 남긴다.
