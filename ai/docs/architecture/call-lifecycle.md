# Call Lifecycle 설계

상태: 설계안 · 근거 표기는 `overview.md` §0(F1~F18)을 따른다.

> 구현(S4, 2026-11-03): `app/calls/`(`session.py` CallSession·Phase, `registry.py`, `service.py` CallService), 설정 `config/server.toml` `[call]`, 조립 `app/main.py`(OPENAI_API_KEY가 있을 때 수신·PBX·관제 라우터). 설계와 다른 점·남은 것:
> - 2단계 고객 확인은 `CallService.stage2(s)`(1회, `ops["stage2"]`)·`call_session_seq(s)`(시작 후 잠금 밖 대기)로 제공하고, 시작 시점(첫 업무 의도·첫 위임)은 S5 핸들러가 부른다.
> - 무발화·만료 임박은 지금은 바로 마무리(begin_closing). "확인 1회"·마무리 유도 발화는 S5 notifier.
> - 수신 루프는 오디오 반사를 바이트 앞부분의 type만 보고 버리고, 나머지는 `json.loads` 후 동기 핸들러 표(`handlers`)로 보낸다(S5가 함수 호출·발화 끝 Decision 핸들러를 더한다). sideband 송신 `event_id = trace_id:seq`(`next_event_id`).
> - 페르소나는 `promptText`만 쓴다(음성 `voiceId` 적용, apply-result 회신, `/internal/persona/*`는 미구현).
> - RAG는 통화에 아직 연결하지 않았다(`search_manual` → `KB_UNAVAILABLE`). 결과 아웃박스는 S6(`on_finalize` 훅).

## 1. 구성 요소

| 구성 | 책임 |
|---|---|
| `CallRegistry` | 진행 중 통화 색인(`session_id` → `CallSession`, 발신번호 → 진행 통화 목록), 동시 통화 상한, 같은 session_id 중복 수신 거부, shutdown 시 전체 정리 |
| `CallSession` | 통화 1건의 **경량 상태 객체**: 상태·`state_version`·`asyncio.Lock`·`pending_confirmation`·진행 작업·`closed`·태스크·타이머(`concurrency.md` §2). Actor·처리 큐 없음 |
| `SidebandReader` | 통화당 수신 태스크 1개. 이벤트를 읽는 순서대로 동기 핸들러를 호출(`concurrency.md` §4) |
| `Outbox` | 통화 결과·인사이트 이벤트의 영속 보관과 재전송(통화 종료 후에도 동작) |

**규칙: 상태 변경은 `CallSession.lock` 안의 짧은 동기 구간에서만 한다.** 웹훅 핸들러·sideband 핸들러·타이머·도구 태스크 모두 같은 규칙을 따르고, 외부 I/O는 잠금 밖에서 하며 결과는 필드 버전으로 검증 후 반영한다(`concurrency.md` §3).

## 2. 상태 전이

```
                 incoming webhook (서명OK, 첫 webhook-id, 같은 session_id 미등록)
                                   │
                                   ▼
                            ┌─ RECEIVED ─┐  상한 초과 → reject(486) → CLOSED
                            │            │
                 stage-1 caller_context(phone) [예산 1.5s, 실패 시 UNREGISTERED 취급]
                 persona ACTIVE (메모리 캐시)
                            ▼
                         ACCEPTING ── accept 실패 ─────────────────────▶ FAILED ─▶ FINALIZING
                            │  ▲ PBX ended 도착 → flag hangup_after_accept
                 accept 200 │
                            ▼
                         ATTACHING ── sideband connect (SDK 재연결 내장 F14)
                            │        hangup_after_accept → hangup, sideband 미개시 → CLOSING
                 session.started (expires_at 기록)
                            ▼
                ┌──────── ACTIVE ────────┐
                │  substate: registered? (stage-2 완료 여부, 기본 false)
                │  업무 의도 확정(첫 업무 도구 성공) → stage-2 caller_context(phone, call) 1회
                │                                                              │
   Decision task/switch=end(서버 확인) / 상담원 refer 성공 / 무응답 타임아웃 / 만료 임박 / PBX ended / remote_hangup
                ▼
             CLOSING ── 마무리 발화 대기(quiet window) → hangup / session.close
                │
     session.closed 또는 연결 종료 확인 또는 hangup 404
                ▼
             CLOSED
                ▼
           FINALIZING ── 통화 결과 결정·아웃박스 기록 → 전송, 인사이트 전송, 리소스 해제
                ▼
              DONE  (registry에서 제거)
```

### 2.1 전이 표

| 현재 | 입력 | 가드 | 동작 | 다음 |
|---|---|---|---|---|
| — | `IncomingCall` | registry에 session_id 없음 | 등록, trace_id 발급 | RECEIVED |
| RECEIVED | 상한 초과 | — | `reject(session_id, status_code=486)` | CLOSED |
| RECEIVED | 시작 | — | 1단계 고객 확인 ∥ 페르소나 읽기(캐시) | ACCEPTING |
| ACCEPTING | accept 200 | `hangup_after_accept` 없음 | sideband 연결 시작 | ATTACHING |
| ACCEPTING | accept 200 | `hangup_after_accept` | `hangup`, sideband 미개시 | CLOSED |
| ACCEPTING | accept 오류 | `decision_already_made` 등 | 로그, 결과 미전송(업무 정보 없음) | FAILED |
| ATTACHING | `session.started` | — | `expires_at` 타이머 설정 | ACTIVE |
| ATTACHING | 연결 실패(SDK 재시도 소진) | — | `hangup` 시도 | CLOSED |
| ACTIVE | 첫 업무 의도 확정 | `registered=false` | 2단계 `caller_context(phone, call)` (백그라운드, 결과는 메시지로) | ACTIVE |
| ACTIVE | Decision `task`/`switch`=`end` (임계 이상) | 진행 중 확인·부작용 없음 | 결과 전송 → 마무리 사실 commentary | CLOSING |
| ACTIVE | 상담원 refer 성공 | — | — | CLOSING |
| ACTIVE | PBX ended (매칭) | — | 즉시 `hangup` | CLOSING |
| ACTIVE | `session.closed` | — | — | CLOSED |
| ACTIVE | 만료 `expires_at - 60s` | — | 마무리 유도(commentary) | CLOSING |
| ACTIVE | 무발화 N초 | — | 확인 1회 → 다시 무발화면 종료 | CLOSING |
| CLOSING | 출력 전사 정지 `quiet_ms` 또는 상한 `closing_max_s` | — | `hangup_quietly` | CLOSING(대기) |
| CLOSING | `session.closed` / sideband 종료 / hangup 404 | — | — | CLOSED |
| CLOSED | — | — | 대기 중 확정 버림, 진행 중 쓰기는 결과 기록 대기(최대 예산) | FINALIZING |
| FINALIZING | 결과 결정 | `conversation-state.md` §7 | 아웃박스 기록 후 전송 시작, 인사이트 이벤트 flush | DONE |

수치(`quiet_ms`, `closing_max_s`, 무발화 N)는 설정값이며 실측 후 정한다(`latency-strategy.md`).

### 2.2 고객 확인 2단계 (BE 계약 `be-api.md` §1)

| 단계 | 시점 | 호출 | 결과 사용 |
|---|---|---|---|
| 1 | RECEIVED (accept 전) | `caller_context(phone)` | Live `instructions`/`input`의 고객 맥락(이름·기본 출발지 존재 여부), 탈퇴 고객 분기 |
| 2 | ACTIVE, 첫 업무 의도(접수·조회·취소·문의·상담원) 확정 시 **1회** | `caller_context(phone, {providerCallId: session_id, incomingAt: 최초 created_at})` | `callSessionSeq` 확보 → 이전 접수 주소(ORIGIN 1, DESTINATION N) **병렬** 조회 |

- 2단계는 수신 후 30분 안이어야 녹취 연결(`B/meaningful-call-registration-handoff.md` §3) → 통화 시간 상한보다 짧으면 문제없음, 30분 초과 통화에서 미등록이면 경고 지표.
- 2단계는 `ops["stage2"]`로 1회만 실행한다. 시작 시점은 첫 업무 의도가 확인된 때: Decision `task`가 업무 값(order·lookup·cancel·inquiry·agent)이거나, 그 전에 첫 Backend 위임(값 기록·조회·검색)이 도착한 때 중 먼저 오는 것(`delegation.md` §3.1).
- 2단계가 끝나기 전 `callSessionSeq`가 필요한 도구(조회·취소·이전 주소)는 `ops["stage2"]`의 Future를 **잠금 밖에서** 기다린다(도구 예산 안). 실패 시 `unavailable/CALL_NOT_REGISTERED`.
- 무의미 통화(업무 의도 없이 종료): 2단계·결과 전송·인사이트 모두 하지 않는다.
- `incomingAt`은 `IncomingCall.incoming_at`에서 고정, 재계산 금지.

## 3. WebSocket(sideband) 관리

- 연결: `client.live.sideband.connect(session_id=..., graceful_close=True)` [SDK F14]. SDK 내장 재연결(`max_retries=5`, 0.5~8s 백오프)을 쓰고 `on_reconnecting`으로 지표·로그만 남긴다.
- 수신 루프는 `SidebandReader` 태스크 하나. 오디오 반사 이벤트는 타입만 보고 버리고(D12), 나머지는 SDK로 파싱해 동기 핸들러를 바로 호출한다. 핸들러는 짧은 임계 구역 + 태스크 생성만 하고 반환한다.
- 송신은 핸들러가 잠금 밖에서 한다. 모든 송신에 `event_id = f"{trace_id}:{seq}"`를 붙여 `error.client_event_id`·`*.appended.client_event_id`로 상관관계를 찾는다 [SDK `error.py`].
- 재연결 중 미결 함수 호출: 결과 전송을 보관했다가 재연결 후 재전송. 중복 결과는 서버가 거절하므로(`[DOC]` duplicate rejected) `call_id`별 전송 여부를 기록해 1회만 보낸다.
- 처리할 서버 이벤트(그 외는 기록만):

| 이벤트 [SDK] | 처리 |
|---|---|
| `session.started` | `expires_at` 저장, ACTIVE |
| `session.delegation.created` | 위임 스팬 시작(`offset_ms`), 위임 감시 타이머 해제 |
| `response.event` | `delegation.md` §4 함수 라우터 |
| `session.updated` | 기록만(트리거를 쓰지 않으므로 질문 세트 교체 없음) |
| `session.input_transcript.delta` | 고객 발화 누적, **발화 끝 타이머(`utterance_gap_ms`) 재시작** → 만료 시 Decision 호출(`delegation.md` §3), 확정 지연 중이면 **확정 취소**, 무발화 타이머 리셋 |
| `session.output_transcript.delta` | AI 발화 누적(직전 AI 발화 = Decision 입력·G3 기준), 발화 끝에 결과 문구 검사(§6.2-5), 첫 응답 시간 측정, CLOSING quiet window |
| `session.usage.updated` | `context_window.usage_ratio` 지표(0.9 근접 경고) |
| `error` | `client_event_id`로 원인 송신 찾기, 치명 여부 분류 |
| `session.closed` | 사유·usage 기록 → CLOSED |
| `transport.dtmf.received` | 현재 미사용(기록만) |

## 4. 중복 웹훅 방지

| 계층 | 방법 |
|---|---|
| OpenAI 웹훅 | `webhook-id` 중복 제거(기존 `_Dedupe`) + **`session_id` 기준 registry 중복 거부**(같은 통화로 다른 webhook-id가 와도 1회만 accept). `live.call.incoming`(구 이름)도 같은 session_id면 무시 |
| 재시작 후 재전송 | OpenAI가 72시간 재시도할 수 있으나(`pbx-sip.md`, 미검증) 재시작 후 온 같은 세션의 accept는 `decision_already_made`로 실패 → FAILED로 기록만 |
| PBX 종료 웹훅 | 같은 요청 반복 허용(200). 이미 CLOSING 이후면 무시 |
| FAQ 알림 | 기존 SQLite 큐의 eventId 멱등 |
| 함수 호출 | `call_id` 단위 실행 1회(F15). 결과 캐시 재사용 |

다중 인스턴스에서는 위 메모리 중복 제거가 깨진다 → 단일 인스턴스 전제(overview Q4).

## 5. PBX 종료 웹훅 매칭

```
on_call_ended(ev):
  candidates = registry.active_by_caller(ev.caller)
  targets = [c for c in candidates if c.incoming_at_dt < ev.ended_at]   # 같은 번호 재통화 보호
  for c in targets: on_pbx_ended(c, ev)      # 잠금 안에서 phase 확인·표시, hangup은 태스크로
  return 200   # 모르는 통화도 200
```
- 핸들러는 짧은 임계 구역에서 표시만 하고 즉시 반환(hangup은 백그라운드 태스크, 콜백 예외는 잡아서 로그 후 200).
- phase별: ACCEPTING이면 `hangup_after_accept=True`, ACTIVE/ATTACHING이면 `hangup_quietly` 태스크, CLOSING 이후면 무시.

## 6. 비정상 종료와 리소스 정리

| 상황 | 감지 | 처리 |
|---|---|---|
| 고객이 먼저 끊음 | `session.closed{reason:"remote_hangup"}` 또는 PBX 웹훅 | CLOSED → FINALIZING |
| 연결 유실 | `reason:"connection_lost"` 또는 sideband 재연결 소진 | hangup 시도(404 무시) → FINALIZING |
| 세션 만료 | `expires_at` 타이머 / `reason:"expired"` | 만료 60초 전 마무리 유도 |
| 안전 필터 | `reason:"content"` | 결과는 일반 규칙(INCOMPLETE 등), 경고 지표 |
| `session.closed` 없이 연결 종료 | 펌프 종료 | 최종화 미확인 기록([SDK] docstring), hangup 시도 |
| 핸들러·수신 태스크 예외 | 수신 루프 최상위 except, 태스크 done 콜백 | 통화 FAILED 처리 → hangup → FINALIZING(결과 결정은 진행) |
| 서버 shutdown | lifespan 종료 | 신규 수신 503 거부 → 진행 통화에 종료 요청 → 아웃박스는 영속 상태로 남겨 재기동 시 재전송 |

정리 순서(FINALIZING)는 `concurrency.md` §6.4: `closed=True` → 타이머·확정 대기 취소 → 태스크 취소·상한 대기 → 진행 중 부작용 `unknown` 기록·재조회 → 결과 아웃박스 → sideband 닫기 → registry 제거 → 상태 객체 참조 해제.

## 7. 통화 결과 아웃박스

```sql
-- persistence: 기존 SQLite 사용(신규 의존성 없음)
CREATE TABLE call_results(
  session_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,       -- UUID4, 통화당 1개
  body_json TEXT NOT NULL,             -- 처음 만든 본문, 이후 불변
  status TEXT NOT NULL,                -- PENDING | SENT_UNCERTAIN | DONE | FAILED
  last_data_json TEXT, attempts INT, updated_at TEXT);
CREATE TABLE insight_events(
  event_id TEXT PRIMARY KEY, call_session_seq INT, event_order INT, body_json TEXT, status TEXT);
```
- 키·본문은 **전송 전에** 커밋(`B/ai-order-billing-integration.md` "전송 전에 보관"). 재시작 시 PENDING/SENT_UNCERTAIN을 같은 키·본문으로 재확인.
- COMPLETE 전송은 "더 없어요" 시점에 할 수도 있으나(통화 중 안내 필요) 기본은 FINALIZING. 통화 중 결과 안내가 필요하므로 **CLOSING 진입 직전**(마무리 직전)에 전송하고 결과 status로 마무리 문구를 정한다(`conversation-state.md` §7). 끊긴 뒤면 안내 없이 전송.

## 8. 인터페이스

```python
# CallSession 필드는 concurrency.md §2
async def run_external(s, key, deps, io, apply) -> Effects     # concurrency.md §3.1 패턴
def on_sideband_event(s: CallSession, raw: bytes) -> None       # 동기 핸들러 분기
async def finalize(s: CallSession) -> None                      # concurrency.md §6.4

class CallRegistry:
    def admit(self, incoming: IncomingCall) -> CallSession | None   # 중복/상한이면 None
    def active_by_caller(self, caller: str) -> list[CallSession]
    async def shutdown(self, deadline_s: float) -> None
```
