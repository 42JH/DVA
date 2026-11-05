# Error Recovery 설계

상태: 설계안 · 원칙: AGENTS.md §6 (예상 가능한 업무 실패는 정상 분기, 기계 판독 상태, BE 장애를 고객 입력 오류로 오인 금지, 근거 없는 결과 금지)

## 1. 결과 분류

모든 도구·어댑터 결과는 `ToolOutcome.status` 하나로 분류한다.

| status | 뜻 | 모델/고객 대응 | 예 |
|---|---|---|---|
| `ok` | 성공 | Live가 정책대로 진행 | 값 기록, 조회 성공 |
| `needs_input` | **업무상 다시 물어야 함**(고객 입력 문제) | 재질문(`next.attempt`·`say` 제약에 따라 Live가 표현) | 전화 자릿수 오류, 주소 못 찾음 |
| `needs_choice` | 후보 중 선택 | 후보 이름표 읽고 고르기 | 핀 여러 개, 담은 택배 중 수정 대상, 자동 확정 주소를 고객이 부정했을 때 |
| `needs_confirmation` | 확인 필요/재확인 | 되읽기 | 스냅샷 불일치(정정), 확정 지연 중 새 발화 |
| `rejected` | 업무 규칙상 불가(정상 분기) | 사유 안내 + 대안 | 결제 완료 주문 취소, 운영 시간 외 상담원 |
| `unavailable` | **시스템 장애**(고객 잘못 아님) | "확인이 어렵다" 안내, 재시도 1회 또는 대안, 고객에게 다시 말하게 하지 않음 | BE 5xx·타임아웃, RAG 실패, 2단계 등록 실패 |
| `unknown` | 쓰기 결과 불확실 | "확인 중" 안내, 서버가 백그라운드 확인 후 다음 결과에 반영. **완료라고 말하지 않음** | 취소 요청 타임아웃, 결과 전송 SUBMITTING |

`code`는 아래 §2의 대문자 식별자. Live는 `status`·`fields`·`needs`(필드와 사유)·`missing`만으로 다음 행동을 고를 수 있어야 하고, `code`는 사유 표시·관측·테스트용이다.

**서버가 결정할 수 있는 예외 판정에 LLM 단계를 추가하지 않는다.** 서버는 "무엇이 실패했고 왜인지, 재시도 한도를 넘었는지(`attempts_exceeded`)"를 사실로 주고, 재질문 표현·다른 방법 제안·상담원 제안은 Workflow Policy의 `reask` 규칙에 따라 Live가 정한다(`workflow-policy.md` §2). 전달 경로: 값 기록·조회는 위임 결과(N1), 서버 직접 처리·비동기 결과는 thinking(N1')/commentary(N2), 오안내만 instructions(N3)(`delegation.md` §6).

## 2. 오류 코드 체계

| 영역 | code | status |
|---|---|---|
| 입력 | `PHONE_INVALID_DIGITS`, `PICKUP_IN_PAST`, `PICKUP_TOO_SOON`(현재 + 1시간 미만, P1), `PICKUP_INVALID_FORMAT`, `NOTHING_TO_RECORD`, `ITEM_UNSPECIFIED` | needs_input |
| 주소(자동) | `ADDRESS_AUTO_SELECTED`(ambiguous 1순위 자동 확정, P6) | ok(+경고) |
| 상담원 | `AGENT_NOT_CONFIGURED`(P11 설정 없음), `AGENT_CLOSED`(운영 시간 외) | rejected |
| 주소 | `ADDRESS_NOT_FOUND`, `ADDRESS_AMBIGUOUS`, `ADDRESS_GEO_MISSING`(접수 필수값 부족, 대화는 계속) | needs_input / needs_choice / ok(+경고) |
| 받는 곳 | `DEST_NONE`, `DEST_MANY`, `DEST_TOO_MANY`(기업 검색 과다) | needs_input / needs_choice |
| 확인 | `CONFIRM_SNAPSHOT_CHANGED`, `CONFIRM_BEFORE_READBACK_END`, `COMMIT_ABORTED_BY_SPEECH`, `CONFIRM_UNCLEAR`(임계 미만·not_answer) | needs_confirmation |
| Decision | `DECISION_STALE`(더 최신 발화 결과 적용됨·pending 바뀜), `DECISION_TIMEOUT`(예산 1.0초 초과), `DECISION_UNAVAILABLE`(API 오류), `DECISION_REFUSAL` (모두 "판단 없음"·기록만, 고객 대응 없음) | — |
| 위임 | `RESULT_SUPERSEDED`(늦은 도구 결과), `COMMIT_HELD_FOR_DELEGATION`(복합 발화 확정 보류) | ok(+superseded) / 기록 |
| 조회·취소 | `ORDER_NOT_FOUND_BY_NAME`, `ORDER_OUT_OF_RANGE`(최근 N건 밖), `CANCEL_LOCKED`(결제 완료 등 409), `CANCEL_ALREADY`, `CANCEL_OUTCOME_UNKNOWN` | needs_input / rejected / ok / unknown |
| 통화 | `CALL_NOT_REGISTERED`(2단계 실패), `CALL_ENDING`, `CUSTOMER_WITHDRAWN` | unavailable / rejected |
| 지식 | `KB_NO_EVIDENCE`, `KB_LOW_SCORE`, `KB_UNAVAILABLE`, `KB_TIMEOUT` | ok(answerable=false) / unavailable |
| BE | `BE_UNAVAILABLE`(연결 실패·5xx·503), `BE_TIMEOUT`, `BE_INVALID_STATE`(409 INVALID_STATE), `BE_FORBIDDEN`(403), `BE_NOT_FOUND`(404), `BE_CONTRACT_VIOLATION`(400/422·사용 필드 누락 — **AI 버그**) | unavailable / rejected |
| 내부 | `TOOL_ARGS_INVALID`(모델 인수 오류), `TOOL_NOT_ALLOWED`, `TOOL_TIMEOUT`(도구 예산 초과), `INTERNAL_ERROR`, `NOTHING_CHANGED`(같은 값 재기록) | needs_input(모델에게 재호출) / rejected / unavailable / ok |

### 2.1 BE 응답 → 분류 (`BackendGateway`)

`backend_client.api`의 문자열 `BackendError`를 대체하지 않고, 게이트웨이에서 `BackendFailure(http_status, error_code, retryable, kind)`로 구조화한다.

| BE 응답 | kind | retryable | 비고 |
|---|---|---|---|
| 연결 실패·타임아웃 | `unavailable` | 읽기 ✔ / 쓰기 결과 불확실 | |
| 5xx, 503 DEPENDENCY_UNAVAILABLE | `unavailable` | 읽기 ✔(1회) | `POST /api/orders` 503은 같은 키 재확인(`be-api.md` §8) |
| 409 REQUEST_IN_PROGRESS, 202, 504 | `in_progress` | 같은 키 | 결과 전송 |
| 409 INVALID_STATE | `state` | ✘ | 종료된 통화 등 |
| 403 FORBIDDEN | `forbidden` | ✘ | 결제 자격·고객 범위 |
| 404 | `not_found` | ✘ | 조회 범위 밖 |
| 400 / 422 | `contract` | ✘ | AI 본문 오류 → 경보, 고객에게는 "확인 후 연락" |

## 3. 재시도·타임아웃·멱등성

| 작업 | 예산 | 재시도 | 멱등 장치 |
|---|---|---|---|
| 읽기 도구(BE 조회·검색) | 도구 예산(기본 3s) | 연결 실패·5xx 1회(남은 예산 안) | 부작용 없음 |
| 주소 보정 + 지오코딩 | 2.5s | 지오코딩 실패 1회 | 부작용 없음 |
| RAG | 4s(단계 합 ≤ 예산) | 없음(지연 우선) | — |
| 취소(서버 전용) | 5s | 재시도 전 상세 재조회로 이미 취소 여부 확인(기존 `cancel_order` 규칙) | `op_id`, 상태 `running/done/unknown/refused`, 같은 대상 동시 실행 금지(`ops` 키, `concurrency.md` §5) |
| 2단계 고객 확인 | 3s | 연결 실패 1회 | BE가 같은 ID·번호·시각에 같은 번호 반환 |
| PIN 저장·고객 등록 | 백그라운드 | 1회 | BE 409 DUPLICATE_RESOURCE를 성공으로, **409 상태 오류는 실패로 구분** |
| 통화 결과 | 요청 15s, 총 40s(기존) + 실행 중 주기 재확인(`backend.result_resend_sec`, 기본 60s, SENT_UNCERTAIN만) + 재시작 복구 | 같은 키·같은 본문 | 아웃박스(`call-lifecycle.md` §7). 전송 중인 행·방금 바뀐 행(전송 예산 안)은 건너뜀 |
| 인사이트 | 백그라운드 | 5xx·연결 실패 3회, 같은 eventId | eventId·eventOrder 영속 |
| 함수 호출 결과 반환 | — | 재연결 후 재전송 | `call_id` 결과 캐시, 1회 전송 |

- 도구 예산 초과 시 runner가 **반드시** 결과를 만든다(`unavailable`/`unknown`). OpenAI가 결과 타임아웃을 정의하지 않으므로(overview F7) 무응답 위임을 남기지 않는다.
- `asyncio.wait_for(to_thread(...))` 취소 후 남는 스레드(R4): 스레드풀을 작업 종류별로 분리하고 크기를 제한한다.

## 4. 시나리오별 대응

| 예외 | 감지 | 1차 대응 | 반복 시 | 근거·제약 |
|---|---|---|---|---|
| **주소 검색 실패**(not_found) | AddressService `not_found` | 값 저장 안 함, `needs_input` `ADDRESS_NOT_FOUND`: "도로명과 건물번호를 다시" | 2회: "동 이름과 번지로"(지번 경로) → 3회: 상담원 제안 | `call-flow/README.md` §4 |
| 주소 애매(ambiguous) | 후보 ≥2 또는 도로명을 많이 고침(건물번호는 정확히 일치할 때만 — 번호를 고쳐야 맞으면 not_found, 2026-11-05) | **1순위 자동 확정**(`auto_selected=true`), 나머지 후보 보관 | 고객이 정정하면 일반 정정 경로 | 사용자 결정 P6(`decisions.md`) |
| 주소 보정 장애(DB 없음·예외) | 서비스 오류 | 들은 값 VALID(source=CUSTOMER) + `ADDRESS_GEO_MISSING` 기록, 대화 계속 | 결과는 INCOMPLETE(운영자 보완) | 대화를 막지 않음 |
| 카카오 지오코딩 실패 | `geo=None` | 대화 계속, 결과 INCOMPLETE 사유 기록 | — | 장애와 결과 없음 구분해 지표 |
| **전화번호 오류** | `normalize_phone` None | 기존 값 유지, `PHONE_INVALID_DIGITS`: "또박또박 한 번 더" | 2회: 끊어서 불러 달라 → 3회: 상담원 제안 | 자릿수 규칙 기존 유지 |
| 전화번호 되읽기에 "아니요" | Decision `confirm=no` | 해당 필드 INVALID로 돌리고 다시 묻기 | — | |
| 성함으로 주문 못 찾음 | 0건 | "받는 분 성함을 다시" | 최근 N건 밖 가능성 안내 → 상담원 | `lookup_limit` 한계 |
| 취소 불가(결제 완료) | BE 409 → 재조회 | `rejected/CANCEL_LOCKED`: 전화로 취소 어렵다 | 상담원 제안 | 기존 규칙 |
| 취소 결과 불확실 | 타임아웃 | `unknown`, 백그라운드 상세 재조회 → 결과를 다음 응답에 | 확인 실패 지속 → "확인 후 연락" | 완료 발언 금지 |
| **BE API 장애**(조회·검색) | `BE_UNAVAILABLE` | `unavailable`: "지금 확인이 어렵습니다", 1회 재시도 제안 | 접수는 계속 가능(접수는 통화 끝 1회 전송) | 고객 입력 오류로 처리 금지 |
| 페르소나 `promptText` 확보 실패 | 조회 오류·타임아웃·404·빈 값 | 서버 기본 프롬프트로 accept(인사 지연 없음), `persona_fallback_total` | — | `decisions.md` P2 |
| 1단계 고객 확인 실패 | 예외/타임아웃 | 미등록 취급으로 accept(인사 지연 방지) | 2단계에서 재조회 | `ai/backend-api.md` §1 |
| 2단계 등록 실패 | 예외 | `CALL_NOT_REGISTERED`: 조회·취소·이전 주소 불가 안내, 접수는 계속 | `ops["stage2"]` 백그라운드 1회 재시도 | 결과 전송은 `call` 본문으로 통화 생성 가능(`orders.md`) |
| 결과 전송 실패 | 4xx | 성공 안내 금지 → END_PENDING("확인 후 연락"), 경보 | — | `be-api.md` §8 |
| 결과 처리 중(SUBMITTING) | 202·409 | 재확인 루프, 마지막 SUBMITTING이면 END_PENDING | 재시작 복구 | |
| **RAG 검색 실패** | `KB_UNAVAILABLE/TIMEOUT` | 추측 금지, "확인이 필요하다" + 접수 흐름 복귀 | 미답변 등록 | 기존 `search_manual` 규칙 |
| RAG 근거 없음/낮은 점수 | `answerable=false` | 모른다고 안내 + 상담원 제안(D5 문구) | 서버가 미답변으로 자동 기록(통화 후 BE 전송) | `scenario.md` QnA |
| 탈퇴 고객 | 1단계 `WITHDRAWN` | 업무 진행 없이 상담원 연결 | — | |
| 모델 인수 오류 | strict 검증 실패 | `needs_input/TOOL_ARGS_INVALID`(모델에게 필드 경로 힌트) — 고객에게 묻지 않음 | 2회 연속이면 `get_state` 유도 | |
| 위임 누락(값을 말했는데 Live가 위임 안 함) | 별도 판단을 두지 않음(Decision으로 값 발화를 감지하지 않는다). 필드가 EMPTY로 남아 `missing`에 계속 포함 | Live가 정책대로 다시 묻고, 되읽기 gate가 열리지 않아 누락된 채 확정되지 않음. 지표: 수집 단계 발화 중 위임 없는 비율 | — | 원본 위임 누락 사고(`LANGGRAPH_REVIEW.md:49`) |
| Live가 업무 사실을 먼저 말함 | 서버 결정적 문구 검사(`[forbid].claims`: 접수·취소·결제 완료 문구 + 서버 상태에 그 결과 없음, `delegation.md` §6.2-5) | N3(`instructions.append`)로 "확인 전" 정정, 결과 도착 후 N2로 정확한 사실 | N3 3회 이후에도 필요하면 상담원 이관 제안(P4). 상담원 미설정이면 "담당자가 확인 후 연락" 안내 + INCOMPLETE | `delegation.md` §6.2-5, `decisions.md` P4·P11 |
| Live가 gate 단계로 조기 진입(되읽기 등) | 감지하지 않음(출력 감시 미사용, S0b) | pending이 없으면 confirm 질문을 넣지 않아 고객 "네"가 확정으로 이어지지 않음. 다음 결과·N2에 `missing` | — | `workflow-policy.md` §5, `delegation.md` §7.4 |
| Decision 결과 지연·오류 | `utterance_id`·pending id, 예산 1.0초 | 폐기(`DECISION_STALE`) 또는 판단 없음(`DECISION_TIMEOUT`/`UNAVAILABLE`), 고객 대응 없음 — Live가 대화로 다시 확인 | `DECISION_UNAVAILABLE` 비율 경보 | `delegation.md` §3.3 |
| 같은 질문 반복 | `attempts` | `attempts` 증가 사실 전달 → Live가 정책 `reask.vary_wording`에 따라 표현을 바꿈 | 3회 → 상담원 제안 | REVIEW A4 |
| 세션 만료 임박 | `expires_at` | 마무리 유도, 결과 전송 | — | |
| sideband 단절 | SDK 재연결 | 미결 함수 결과 보관·재전송 | 재연결 실패 → hangup, FINALIZING | |

## 5. 고객에게 하지 않는 말

- 결과 없이 "접수되었습니다/취소되었습니다" (status `ok` + 해당 결과가 있을 때만).
- 결제 완료·메시지 발송(`ai/backend-api.md` §3).
- 장애를 고객 탓으로("잘못 말씀하셨어요").

## 6. 경보 기준(운영)

| 조건 | 경보 |
|---|---|
| `BE_CONTRACT_VIOLATION` 1건 | 즉시(본문 버그) |
| `BE_UNAVAILABLE` 5분 비율 > 5% | 경고 |
| 결과 아웃박스 PENDING > 10분 | 경고 |
| `CANCEL_OUTCOME_UNKNOWN` 1건 | 확인 필요 |
| 위임 결과 미반환(`function_call_outputs_required`) | 즉시(라우터 버그) |
