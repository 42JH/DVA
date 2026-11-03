# 테스트 전략

상태: 설계안 · 현행 기준선: `uv run pytest -q` 364 passed (외부 호출 없음)

## 1. 원칙

- 외부 서비스(OpenAI, PBX, BE, 카카오, Qdrant)를 단위·통합 테스트에서 부르지 않는다(기존 규칙 유지).
- 도메인(`app/domain`)은 순수 함수·객체 → 가짜 없이 테스트.
- 시계·ID·난수는 주입(`Clock`, `IdGen`)해 결정적 테스트.
- 테스트 통과를 위해 검증 로직을 제거하지 않는다(AGENTS.md §9).
- 오류 단언은 한국어 문구가 아니라 `status`/`code`로.

## 2. 계층

| 계층 | 대상 | 도구 | 위치 |
|---|---|---|---|
| L0 스파이크 | 실 Live 세션·로그 재생: 위임 지연·tier, append 동작, 발화 끝 간격, 독립 Decision 정확도(`delegation.md` §9, `spikes/s0*/RESULTS.md`) | 수동 + 기록 | `spikes/` (CI 제외) |
| L1 단위 | `ConversationState`, `FieldState` 전이·필드 버전, `assess`, 확정 관문 G1~G5, 정책 파일 → Live 지시문·서버 판정 일관성, 결과 outcome 결정, 정규화, Decision 질문 세트 생성 | pytest | `tests/domain/` |
| L2 도구 | 각 핸들러: 입력 검증·상태 변경·`ToolOutcome` | 가짜 `BackendGateway`/`AddressService`/`KnowledgeBase` | `tests/tools/` |
| L3 계약(BE) | 요청 본문·헤더가 `docs/be-contract/backend/` 규칙 충족, 응답 분류 | httpx2 `MockTransport` + 계약 검사기 | `tests/contracts/` |
| L4 어댑터 | sideband 경량 분기·함수 라우터·Decision 핸들러·송신 순서 | SDK 타입으로 만든 이벤트 + 가짜 연결 | `tests/live/` |
| L5 생명주기 | 상태 전이 표 전체, 웹훅 중복, PBX 매칭, 정리 | 가짜 OpenAI 클라이언트(`sessions.accept/reject/hangup/refer`, sideband) | `tests/calls/` |
| L6 시나리오 | 통화 대본 단위 E2E(가짜 Live 이벤트 시퀀스 + MockBackend) | 시뮬레이터 | `tests/scenarios/` |
| L7 지연·부하 | 구간 P50/P95, 동시 통화 1→100 단계 부하, 이벤트 루프 지연 | 가짜 sideband WS 서버 + 하네스(`latency-strategy.md` §6) | `bench/` |
| L8 스테이징 | 실 SIP 통화 | 수동 + 기록 | 체크리스트 |

기존 테스트(`pbx_webhook/tests`, `backend_client/tests`, `address_resolver/tests`, `tools/tests`)는 유지하며 리팩터 시 같은 동작을 보장하는 회귀망으로 쓴다.

## 3. L3 BE 계약 테스트 (필수 항목)

| 검사 | 근거 |
|---|---|
| 모든 주소에 `latitude`/`longitude` 키 없음 | `address-coordinates-removal.md` |
| `paymentMethodType` 모르면 키 생략(null 금지) | `persona-read-payment-null-handoff.md` |
| `Idempotency-Key` UUID, 재시도 시 같은 키·같은 본문 바이트 | `orders.md`, `ai-order-billing-integration.md` |
| `call` 3필드, `incomingAt` = 최초 `created_at` | `caller-context.md` |
| `customerSeq`와 `customer` 동시 금지 | `orders.md` |
| COMPLETE 필수값 충족 시에만 COMPLETE, `totalAmount` = `notifiedPrice` 합 | `ai-order-billing-integration.md` |
| 빈 결과 규칙, 무의미 통화 미전송 | `empty-ai-order-results.md`, meaningful handoff |
| 1단계 본문에 `call` 없음, 2단계 1회 | meaningful handoff |
| `call_session_seq` 헤더(조회·취소·이력·PIN), 결과 전송엔 없음 | `orders.md` |
| 전화번호·이름 URL 미포함(기업 검색 `q` 예외) | `ai/backend-api.md` 공통 |
| analysis에 `result` 없음 | `call-analysis.md` 042 |
| 503 → 같은 키 재확인, 4xx → 재전송 없음 | `ai-order-billing-integration.md:220` |
| 응답 분류 표(`error-recovery.md` §2.1) | 각 문서 오류 표 |

`MockBackend`도 같은 계약 검사기를 통과해야 한다(Mock-실제 동치).

## 4. L4/L5 핵심 케이스

| 케이스 | 기대 |
|---|---|
| `response.event{response.output_item.done(function_call)}` 1개 | 도구 1회 실행 → `response.item.create(function_call_output)` → `response.create` 순서 |
| 같은 `call_id` 두 번 수신 | 실행 1회, 결과 재전송 없음 |
| 한 응답에 호출 2개 | 둘 다 결과 후 `response.create` 1회 |
| `response.completed`만(호출 없음) | 아무것도 보내지 않음 |
| 도구 예산 초과 | `unknown/unavailable` 결과 전송(무응답 없음) |
| `error{code:"function_call_outputs_required"}` | 누락분 재전송, 경보 지표 |
| sideband 재연결 중 결과 생성 | 재연결 후 1회 전송 |
| 같은 session_id, 다른 webhook-id 두 번 | accept 1회 |
| accept 중 PBX ended | accept 후 hangup, sideband 미개시 |
| PBX ended, 같은 번호 새 통화가 `endedAt` 이후 시작 | 새 통화 유지 |
| `session.closed(remote_hangup)` 중 확정 지연 | 확정 버림, 결과 INCOMPLETE/COMPLETE 규칙대로 |
| 핸들러·수신 태스크 예외 | hangup + FINALIZING 진행 |
| 통화 종료 후 | 그 통화의 태스크 0개, sideband 닫힘, registry에서 제거 |
| 이전 발화의 Decision 응답이 최신 발화 결과보다 늦게 도착 | 폐기(`DECISION_STALE`), 상태 불변 |
| Decision 호출 예산 초과·오류 | 판단 없음, 상태 불변, 고객 대응 없음 |
| delta 간격 0.8초 미만 연속 / 0.8초 이상 쉼 | 한 발화로 호출 1회 / 두 발화로 각각 호출 |
| pending 없는 상태의 고객 "네" | Decision 질문에 confirm 없음, 확정 없음 |
| `confirm=yes` 후 `commit_delay_ms` 안에 새 입력 전사 | 확정 안 됨 |
| `confirm=yes`인데 그사이 확인 대상 필드 변경 | 확정 안 됨(`CONFIRM_SNAPSHOT_CHANGED`) |
| `confirm=yes` 발화 시작이 직전 AI 발화 끝보다 이름, 또는 직전 AI 발화가 pending 발급 전에 시작 | 확정 안 됨(`CONFIRM_BEFORE_READBACK_END`, G3) |
| 같은 확인에 yes 두 번 | 실행 1회 |
| 질문 세트가 꺼진 단계의 발화 / `switch=none` | Decision 호출 0건 / 서버 송신 0건 |
| 복합 발화: `confirm=yes` + 같은 구간 위임이 확인 대상 필드 변경 | 확정 안 함(G6) |
| 복합 발화: `confirm=yes` + 같은 구간 위임이 무관 필드(예: 요청사항) 기록 | 위임 완료 후 확정 |
| 복합 발화: Decision과 위임 결과 도착 순서 바꿔 재생 | 최종 상태 동일(R6) |
| `pick=none` + 위임 `find_destination` | 후보 해제 후 새 검색 결과 |
| Decision 질문에 자유형 값 질문이 없음 | 질문 세트 정적 검사(choice·predicate·score만) |
| Backend 도구에 확인·선택·분류 도구 없음 | 레지스트리 정적 검사 |
| Decision 확인 처리 중 Backend 위임 진행 | commentary는 위임 완료 후 송신 |
| 값 발화 후 위임 없음 | 필드 EMPTY 유지, `missing` 포함, 되읽기 gate 미개방 |
| AI 발화에 "접수되었습니다"인데 결과 미접수 | N3 1회, 상한 초과 시 송신 없음 |
| AI 발화에 "확인했습니다" | 문구 검사 대상 아님(N3 없음) |
| Live 발화 중 서버 결과(N2) | 출력 전사 정지 후 송신 |
| N1' 같은 내용 반복 | 1회만 송신 |
| 무관한 필드 변경 중 주소 보정 결과 도착 | 반영됨(필드 버전 기준) |
| 같은 필드 변경 중 주소 보정 결과 도착 | `stale`, 반영 안 함 |
| shutdown | 신규 거부, 아웃박스 영속 |
| 재시작 후 아웃박스 PENDING | 같은 키·본문 재확인 |

이벤트 픽스처는 `openai.types.live.*` 모델로 생성·검증해 SDK 스키마와 어긋나지 않게 한다(SDK 버전 고정 `3.35.1`, 업그레이드 시 픽스처 검증 실패로 감지).

## 5. 동시성 테스트

- 같은 통화에 도구 결과·Decision 결과 100개를 무작위 순서·지연으로 투입 → `state_version` 단조 증가, 늦은 결과 미반영, 최종 상태 결정적.
- 임계 구역 안 `await` 금지 검사(정적 검사 또는 테스트 훅).
- 통화 50개 동시 주소 보정 → 전역 직렬화 없음(처리 시간 상한), 결과 정확.
- 되읽기 직후 정정 위임과 Decision `yes` 경합 → 확정 안 됨.
- 취소 같은 대상 동시 2회 → BE 호출 1회.
- 서로 다른 통화의 Lock 독립: 한 통화의 느린 외부 작업이 다른 통화 처리 지연을 늘리지 않음.
- 결과 아웃박스: 보관소 해시 불일치 시 전송 안 함, 재시작 후 같은 키·본문.

### 5.1 결정 사항(`decisions.md`) 검증
| 결정 | 테스트 |
|---|---|
| P1 | 수거 시각 now+59분 → `PICKUP_TOO_SOON`, now+61분 → VALID, 시간대 없음 → INVALID (시계 주입) |
| P2 | Live instructions 렌더링: `promptText`가 앞에 오고 우선 문구 포함, 16,384 토큰 이하. Backend instructions에는 페르소나 미포함. 페르소나 조회 실패·타임아웃·404·빈 값 → 서버 기본 프롬프트로 accept, `aiPersonaVersionSeq`=null |
| P4 | N3 3회 후 정정 상황 → 상담원 이관 제안 전달, 4번째 N3 송신 없음 |
| P5 | 담은 택배 수정 → 미확인 → 재확인 후 확인됨. **재확인 전 종료 → 그 택배는 마지막 확인 스냅샷으로 COMPLETE**(수정 중 값 미전송). 택배 2개 중 수정 대상 `pick` |
| P6 | ambiguous → 1순위 VALID + `auto_selected`, 이후 정정 시 일반 정정 경로 |
| P7 | 성함·주소만 있을 때 등록 안 함, 셋 다 있을 때 1회, geo 없으면 PIN 생략 |
| P11 | 상담원 설정 없음 → `AGENT_NOT_CONFIGURED`, 대체 안내, 결과 INCOMPLETE. 설정 변경이 재배포 없이 반영 |
| BE 변동 | 응답에 모르는 필드 추가 → 정상 동작, 사용하는 필드 누락 → `BE_CONTRACT_VIOLATION` |

## 6. 시나리오 평가셋 (L6)

원본 사고와 흐름 문서에서 만든 대본. 각 대본 = Live 이벤트 시퀀스(전사 delta + 위임 + 함수 호출 인수) + 기대 상태·BE 호출·결과.

| 그룹 | 예 | 출처 |
|---|---|---|
| 정상 접수 | 등록 고객 기본 출발지, 신규 고객, 택배 2개, 후불/개인 카드 | `scenario.md` |
| 정정 | "네, 근데 이름이…"(11-01 20:05), "아니요, 제 이름이 틀렸어요"(11-01 23:14), 번호 정정 이중 발화(11-02 00:07) | `flow.md` |
| 확인 관문 | 끝까지 듣기 전 "네"(11-02), 확정 지연 중 "잠깐만요" | `flow-two-key-plan.md` |
| 주소 | not_found 3회, ambiguous 자동 확정 후 고객 정정, 보정 장애 | `error-recovery.md` §4 |
| 담은 택배 수정 | 2개 담은 뒤 첫 번째 받는 분 주소 수정 → 재확인 → 접수 | `decisions.md` P5 |
| 받는 곳 | 핀 1/여러 개/기업 과다/없음 | `match_pins` |
| 조회·취소 | 성함 조회, 결제 완료 취소 불가, 이미 취소, 결과 불확실 | `scenario.md` C |
| 장애 | BE 503/타임아웃, RAG 실패, 2단계 실패 | — |
| 종료 | 고객 먼저 끊음, 만료, 상담원 이관 | `call-lifecycle.md` |

| 일반 대화 | "잠시만요", "네 알겠어요"(확인 대기 아님), 인사 → 서버 송신 0건, 위임 0건 | `delegation.md` §7.1 |
| 문맥 의존 "네" | 같은 "네"가 확인 대기 중/아닐 때 다르게 처리 | `delegation.md` §3 |
| 정책 준수(자율 진행) | 모든 필수 항목을 정책 순서로 질문, 기록된 항목 재질문 없음, 조기 되읽기 시 N3 1회로 복귀, 검증 전 "확정" 발화 시 정정 | `workflow-policy.md` §5 |
| 충돌 6상황 | `delegation.md` §6.2의 1~6 각각 | `delegation.md` |
| 전달 최소화 | 정상 접수 1건 통화에서 N2·N3 송신 수 상한 이내, 일반 대화 턴 서버 송신 0 | `delegation.md` §6.3 |

**오프라인 모델 평가**(네트워크 사용, CI 제외):
- Decision: 대본의 (직전 AI 발화, 고객 발화) 쌍을 운영과 같은 입력 형식으로 독립 `POST /v1/decisions`에 넣어 `task`·`switch`·`confirm`·`pick` 정확도와 임계값(θ) 결정(`spikes/s0c/replay.py` 방식).
- Backend: 값 발화를 Responses 모델에 넣어 도구 선택·인자 정확도.
- 불필요 위임률: Decision이 ②로 분류한 발화 중 Live가 위임한 비율(스테이징).

## 7. 커버리지·품질 게이트

- 도메인·도구·라우터: 분기 커버리지 측정(목표는 기준선 측정 후 합의).
- 전이 표(`call-lifecycle.md` §2.1)의 모든 행과 오류 코드 표(`error-recovery.md` §2)의 모든 code에 최소 1개 테스트.
- CI: L1~L6 필수, L7 야간.

## 8. 스테이징 수용 기준 (구현 S8 단계)

| 항목 | 기준 |
|---|---|
| 대본 통화 20회 | 업무 결과(BE 기록) 기대와 100% 일치 |
| 성공 안내 | `ACCEPTED` 외 상태에서 접수 완료 발언 0회 |
| 확인 없이 확정 | 0회 |
| 위임 결과 미반환 | 0회 |
| 지연 | 구간 5종(`latency-strategy.md` §1.2) P50/P95 보고(목표치는 사용자와 합의) |
| 불필요 위임 | 확인·선택 턴의 위임률 보고 |
| 부하 | L7에서 정한 용량의 80%로 30분 유지 시 오류율·지연 기준 충족 |
| 녹취 연결 | BE에서 통화-녹취 매칭 확인 |
