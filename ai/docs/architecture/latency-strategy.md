# Latency 전략과 관측성 (v2)

상태: 설계안 · 원칙: AGENTS.md §7 (측정 없이 효과 단정 금지, 타임아웃, 독립 읽기 병렬, 루프 비차단, LLM 호출 최소화, 첫 유효 음성 응답 측정, P50/P95)

> 수치는 **초기값**이며 측정 전 효과를 주장하지 않는다. 지연 개선을 위해 새 LLM 호출이나 중간 계층을 추가하지 않는다.

## 1. 경로와 구간

### 1.1 두 업무 경로
```
경로 D (Decision → 서버 직접, Backend 없음): 확인·선택·전환·종료
  T0 고객 발화 끝(마지막 delta) ─▶ +utterance_gap_ms(800) Decision 호출 ─▶ T1 Decision 응답 ─▶ T2 서버 행동 시작(확정 지연 포함) ─▶ T3 행동 완료
                    ─▶ T4 commentary.append 송신 ─▶ T5 Live 첫 출력(해당 내용)
경로 B (Live 위임 → Backend → 서버 도구): 값 입력·조회·문의
  T0 고객 발화 끝 ─▶ T1' session.delegation.created ─▶ T2' function_call 도착 ─▶ T3' 도구 완료
                    ─▶ T4' response.create 송신 ─▶ T5' response.completed ─▶ T6' Live 첫 출력(결과)
```

### 1.2 측정 지표 (요구 구간 매핑)

v3 요구 4구간 ↔ 지표:

| 요구 구간 | 지표 |
|---|---|
| 고객 발화 종료 → Live 첫 응답 음성 | `first_response_ms` (일반 대화 포함, 서버 무관 구간 — Live 자율 진행의 기준선) |
| 고객 발화 종료 → Decision 결과 | `decision_ms` = `utterance_gap_ms` + `decision_api_ms`(호출 → 응답, S0c 웜 p50 251·p95 284ms) |
| Decision 결과 → Tool 실행 완료 | `decision_to_tool_done_ms` = `decision_to_action_ms` + `tool_ms` (B·C3 경로) / 위임 경로는 `delegation.created` → 도구 완료 |
| Tool 결과 전달 → Live 업무 안내 시작 | `result_to_speech_ms` (N1 위임 결과 / N2 commentary 송신 → 다음 출력 delta) |

추가: `n3_corrections_total`(정정 횟수), `n3_to_speech_ms`(정정 송신 → 정정 발화 시작), `decision_tokens_total`(비용), `backend_tier_downgraded_total`(priority 강등).

| 요구 구간 | 지표 | 정의 | 출처 |
|---|---|---|---|
| 발화 종료 → Decision 결과 | `decision_ms` | 발화 마지막 delta 수신 → Decision 응답 수신(서버 시계) | 서버, F13 |
| Decision 판단 → Tool 실행 시작 | `decision_to_action_ms` | Decision 응답 수신 → 서버 행동/외부 호출 시작(확정 지연은 `commit_delay_ms`로 분리 기록) | 서버 |
| Tool 실행 시간 | `tool_ms` | 도구·서버 행동 시작 → 완료(단계별: 세마포어 대기, BE, 주소, RAG) | 서버 |
| Tool 완료 → Live 첫 응답 음성 | `result_to_speech_ms` | 경로 D: commentary 송신 → 다음 출력 전사 delta `start_ms` / 경로 B: `function_call_output` 송신 → 다음 출력 delta | 서버 + [SDK] F13 |
| 발화 종료 → 첫 유효 응답 | `first_valid_response_ms` | T0 → 업무 결과를 담은 첫 출력 delta(중립 응답 "확인할게요" 제외) | 위 합성 |
| (참고) 발화 종료 → 첫 응답(중립 포함) | `first_response_ms` | T0 → 첫 출력 delta | [SDK] |
| (참고) 위임 | `delegation_ms`, `backend_model_ms` | T1'→T5', 그중 모델 생성 시간 | [SDK] |

- T0 = 다음 AI 출력이 시작되기 전 마지막 `input_transcript.delta.end_ms`.
- "첫 유효 응답" 판정: 서버가 결과를 보낸 시각 이후의 첫 출력 delta. 출력 전사는 완료 이벤트가 없으므로(F13) 시작 시각만 쓴다.
- 세션 ms ↔ 서버 시각 환산: `session.started` 수신 시각을 세션 0ms 근사로 두고, 오차는 같은 시계끼리 비교하는 구간(`tool_ms` 등)으로 분리한다.

### 1.3 라벨
모든 지표에 `path`(D/B), `tool`/`action`, `status`, **`active_calls_bucket`**(1·10·30·50·100…)을 붙여 동시 통화 수에 따른 변화를 본다.

## 2. 경로별 예산 (초기값)

| 경로 | 예산 | 수단 |
|---|---|---|
| 수신 → accept | ≤ 1.5s | 1단계 고객 확인만 대기(1.2s, 실패 시 미등록), 페르소나 메모리 캐시 |
| 경로 D 서버 행동(내부) | ≤ 50ms + `commit_delay_ms` | 순수 상태 변경 |
| 경로 D 취소(외부) | ≤ 5s | BE 취소 + 재조회 |
| 경로 B 값 기록(주소 없음) | ≤ 100ms | 순수 검증 |
| 경로 B 주소 포함 | ≤ 2.5s | 보정(실행기) → 지오코딩, 보내는 곳·받는 곳 병렬 |
| 경로 B 받는 곳 | 핀 ≤ 50ms, 기업 ≤ 1.5s | |
| 경로 B 조회 | ≤ 2.5s | 상세 N건 병렬(통화당 5) |
| 경로 B 문의(RAG) | ≤ 4s | 단계별 예산 합 ≤ 4s |
| 세마포어 대기 | 예산에 포함 | 초과 시 즉시 `unavailable` |

## 3. 기법 (측정 후 채택)

| # | 기법 | 효과 기대 | 근거·위험 |
|---|---|---|---|
| L1 | 열거형 행동을 Decision 경로로(경로 B 제거) | 확인·선택 턴에서 Backend 생성 시간 제거 | 독립 API 웜 p50 251ms(S0c) — 채택 |
| L2 | Live가 일반 대화에 위임하지 않음 | 위임 수 감소 | 프롬프트 준수율 측정 |
| L3 | 위임 1회에 여러 값 기록(`record_fields`) | 왕복 감소 | — |
| L4 | 2단계 고객 확인 후 이전 주소 2건 병렬 | 1 RTT | — |
| L5 | 주소 보정 전역 락 제거 + 실행기 분리 | 통화 간 직렬화 제거 | GIL → 프로세스 풀 필요 여부 측정 |
| L6 | 보내는 곳·받는 곳 주소 병렬 | 최대 1회 보정+지오코딩 | — |
| L7 | 공유 HTTP 클라이언트(카카오 포함) | TLS 재사용 | — |
| L8 | RAG 이중 타임아웃 제거·단계 예산 | 꼬리 지연 상한 | 근거 부족 증가 가능 |
| L9 | Backend instructions·tools 정적 유지 | 프롬프트 캐시 | [미확인] |
| L10 | Backend `reasoning.effort` 낮게, `verbosity: low`, `max_output_tokens` 제한, 필요 시 `service_tier:"priority"` | 생성 시간 | 정확도·비용 평가 |
| L11 | 결과 JSON 최소화 | 입력 토큰 | 맥락 부족 → `get_state` |
| L12 | 오디오 반사 이벤트 미파싱 | 루프 CPU | D12, 실제 수신 여부 [미확인] |
| L13 | 선택형 판단이 없는 단계는 Decision 호출 안 함, 입력은 직전 AI 발화 + 고객 발화만 | 호출 수·토큰 감소 | S0c: 토큰 1/27 |
| L14 | `commit_delay_ms` 실측 조정 | 확인 턴 지연 | 끼어들기 누락과 교환 |

## 4. 관측성

### 4.1 Trace ID와 스팬
- 통화당 `trace_id`(수신 시 UUID4). 로그·지표·아웃박스·인사이트에 포함, `session_id`·`callSessionSeq` 매핑.
- 스팬: `call` > `accept` / `stage1` / `stage2` / `decision[utterance_id]` > `action[key]` / `delegation[delegation_id]` > `tool[call_id]` > `backend_http` / `address` / `rag` / `semaphore_wait`.
- sideband 송신 `event_id = f"{trace_id}:{seq}"` → `client_event_id` 상관.
- 수단: 의존성 추가 없이 구조화 JSON 로그 + 프로세스 내 히스토그램. OpenTelemetry는 별도 승인.

### 4.2 지표 목록

| 지표 | 유형 | 라벨 |
|---|---|---|
| `decision_ms`, `decision_to_action_ms`, `tool_ms`, `result_to_speech_ms`, `first_valid_response_ms`, `first_response_ms` | 히스토그램 | path, action/tool, active_calls_bucket |
| `delegation_ms`, `backend_model_ms` | 히스토그램 | active_calls_bucket |
| `semaphore_wait_ms` | 히스토그램 | resource |
| `event_loop_lag_ms` | 히스토그램 | — (주기 타이머 지연으로 측정) |
| `sideband_bytes_total`, `sideband_events_total` | 카운터 | type |
| `outcomes_total` | 카운터 | path, status, code |
| `delegations_total` | 카운터 | decision_act(같은 발화의 Decision 분류) — **불필요 위임률** 산출 |
| `decisions_discarded_total` | 카운터 | reason(stale, timeout, unavailable, refusal) |
| `active_calls`, `tasks_per_call`, `rss_bytes` | 게이지 | phase |

P50/P95는 히스토그램에서 계산하고, 통화 종료 시 구간 요약 1줄 JSON을 남긴다.

### 4.3 개인정보
로그에 전화번호(마스킹), 주소·이름·검색어·발화 원문 금지. 필드 이름·상태·코드·길이만.

## 5. 모델·파라미터 결정 절차
1. 평가셋(`test-strategy.md` §6) 30개 시나리오를 시뮬레이터로.
2. 후보: Backend 모델 × `reasoning.effort`(service_tier는 priority 고정, `decisions.md` S0b), Decision 임계값(θ_yes, θ_corr), `utterance_gap_ms`, `commit_delay_ms`.
3. 기준: 업무 정확도 ≥ 기준선, `first_valid_response_ms` P95 최소, 비용 보고.

## 6. 부하 테스트로 처리량 검증

동시 통화 처리량은 단정하지 않는다. 아래로 측정한다.

| 항목 | 방법 |
|---|---|
| 부하 생성 | 가짜 OpenAI sideband 서버(WebSocket. 서버를 가짜로 돌리는 방법 — 클라이언트 base URL 설정 또는 sideband 연결 계층 주입 — 은 S1에서 SDK로 확인)가 통화당 이벤트 스트림을 실시간 속도로 재생: 전사 delta, 함수 호출(가짜 `/v1/decisions`도 함께), (옵션) 오디오 반사 24kHz 크기 |
| 외부 의존 | 가짜 BE(지연·오류 주입), 가짜 카카오, 실제 주소DB(CPU 부하 재현), RAG는 가짜 또는 스테이징 |
| 단계 | 동시 통화 1 → 10 → 30 → 50 → 100 → 실패까지 |
| 관찰 | `event_loop_lag_ms` P95, 구간 지표 P50/P95, `semaphore_wait_ms`, CPU·RSS, 오류율 |
| 한계 판정 | `event_loop_lag_ms` P95 > 50ms 또는 `tool_ms` P95가 기준선 대비 2배 → 그 직전 동시 통화 수를 용량으로 기록(기준값은 첫 측정 후 확정) |
| 병목 분리 | 오디오 반사 on/off, 주소 실행기 thread/process, RAG on/off 비교 |
