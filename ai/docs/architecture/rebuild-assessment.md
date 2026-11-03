# 재설계 평가 (Rebuild Assessment)

> 2026-11-03 이후: 이 문서의 `tools/rag/`는 원본 그대로인 `app/rag/`로 교체됐다(RAG는 다른 담당자 구현, 수정 금지 — `decisions.md` RAG). 본문은 분석 당시 기록이다.

작성일: 2026-11-03 · 입력: `docs/architecture/current-state.md`, `docs/contracts/*.md`
원칙: 외부 계약(BE API, PBX·OpenAI 웹훅)은 유지, 내부 구현은 교체 가능(AGENTS.md §2, §4). 이 문서는 **평가**이며 설계·구현이 아니다.

---

## 1. 그대로 재사용할 모듈

| 모듈 | 이유 | 조건 |
|---|---|---|
| `pbx_webhook/sip.py` | 순수 함수, 계약 일치(`token_ok` 상수 시간 비교, `iso_utc`) | `normalize_caller` 15자리 vs BE 3~20자리 확인 후 |
| `pbx_webhook/call_ended.py` | 경로·인증·응답 코드가 계약 그대로 | 콜백 예외 처리 래핑은 호출자 쪽에서 |
| `address_resolver/corrector.py`, `db.py`, `stt_preprocess.py` | 실통화 사례로 다듬어진 보정 알고리즘(2026-10-28 사례 반영), 테스트 보유 | 알고리즘 변경 없음 |
| `backend_client/order.py`의 `match_places`·`place_score`·`pin_labels` | 실통화 사례 기반 매칭 규칙 | 위치만 도메인 계층으로 이동 가능 |
| `backend_client/api.py`의 요청 생성부(`parcel_body`, `result_body`, `_address`, `_pin_place`)와 `search_company_places` | BE 계약(좌표 제거, null 생략)에 맞춰 검증됨 | 본문 생성 규칙 변경 없음 |
| `tools/rag/` 검색·FAQ 동기화 코어(`schemas`, `context`, `algorithms`, `hybrid`, `remote`, `faq_events`, `faq_webhook`, `faq_processor`, `faq_index*`, `faq_vectors`, `faq_source`, `faq_bootstrap`, `gpu.py`) | 주입 가능, 영속 큐·멱등·FIFO 등 BE FAQ 계약 충족, 232 테스트 | 기동 연결만 새로 작성 |
| `tools/base.py`의 `normalize_phone`, `future_time`, `OrderFields` 검증 규칙 | 실통화 사례(고유어 숫자 2026-11-01) 반영 | 시계 주입 정도의 수정 허용 |
| `MockBackend` | 계약 테스트·개발용 | BE 계약 변경 시 동기 유지 |

## 2. 내부 구현을 수정할 모듈 (인터페이스 유지 또는 소폭 변경)

| 모듈 | 수정 내용 | 근거(문제 번호) |
|---|---|---|
| `backend_client/api.py` | ① 오류를 구조화(`status`, `code`, 재시도 가능 여부)해 업무/시스템 오류 구분 ② `TransportError` 일관 래핑 ③ `submit_result` 503 처리 BE 권고대로(같은 키 확인) ④ `create_pin` 409 코드 구분 ⑤ `caller_context` 이전 주소 2건 병렬 ⑥ 인증 방식별 분리(고객/주문, 인사이트, 페르소나, FAQ) ⑦ `persona_token` 누락 가드 ⑧ 옛 `/internal/ai` 메서드 제거 | E1-E3, E7, P1, C6 |
| `address_resolver/__init__.py`, `kakao.py` | 전역 `_db`/락 → 인스턴스화·주입. 전역 락 대신 읽기 전용 연결 풀 또는 지역 캐시 사전 적재 검토(측정 후). 카카오 클라이언트 재사용, 장애와 "없음" 구분 | R1, P3, P6, E4, S5 |
| `tools/runner.py` | 허용 확인을 검증보다 먼저, 오류에 기계 판독 코드 추가, 기록 PII 최소화·상한, 타임아웃 단일화 | tool-contracts §4, D4 |
| `tools/record_order.py` | ambiguous 주소 확정 기록 금지(후보 보류 상태로), sender/receiver 주소 병렬 처리, 의존성 주입 | S3, P2, C5 |
| `tools/match_pins.py`, `lookup_orders.py` | 결과를 `ctx`에 숨기지 않고 서버 상태 저장소로 명시 반환 | S1 |
| `tools/cancel_order.py` | 재조회 실패 시 `outcome: unknown` 보장, 동시 호출 잠금, `ctx.orders` 대상 검증 | E6, R3 |
| `tools/search_manual.py` + `RagService` | 이중 타임아웃 제거, 단계별 예산(합 ≤ 전체 상한), 반환 계약 축소(진단 키 분리) | D4, P4 |
| `pbx_webhook/incoming.py` | 중복 제거를 교체 가능한 저장소로(다중 인스턴스 대비), 콜백 실패 시 reject/hangup 정책, shutdown 시 작업 정리, 서명 오류와 설정 오류 구분 | R5, E5, L5 |
| `tools/base.py` `Tool.spec()` | SDK 의존을 어댑터 계층으로 이동 | C3 |

## 3. 완전히 새로 설계할 모듈

| 모듈 | 설계 대상 | 근거 |
|---|---|---|
| **통화 세션 관리자(Call lifecycle)** | 수신 → 1단계 고객 조회 → accept/reject → sideband 연결 → 의도 확인 후 2단계 등록(30분 시한) → 종료(`session.closed`/PBX 웹훅/서버 hangup) → 결과 전송 → 인사이트 전송. 통화 레지스트리, 동시 통화 상한, PBX 종료 매칭(발신번호 + `endedAt` 이전 시작), accept 중 종료 처리 | L1-L4, L6, R6 |
| **GPT-Live-1 세션·Delegation 어댑터** | accept 본문(세션 설정), 위임 모델 설정, 도구 노출 범위, sideband 이벤트 처리, 도구 결과 반환. 현재 코드·문서 근거 없음 → OpenAI 문서 확인 후 설계 | current-state §3 |
| **업무 상태 저장소(Conversation/Order state)** | 담은 택배 목록, 받는 중 택배, 결제 방식, 수거 시각, 후보·조회 결과, 확인 대기(두 열쇠), 쓰기 작업 기록. LLM 컨텍스트와 독립, 단일 쓰기 경로 | S1-S2, AGENTS.md §4 |
| **업무 흐름 정책(관문)** | 받는 순서, 확인 관문(A_CONFIRM, A_PAYMENT, C_CANCEL_CONFIRM, D_AGENT_OFFER), 두 열쇠 판정, `commit_delay_ms`, 서버 전용 동작 실행, 통화 결과 outcome 결정 | `docs/call-flow/README.md` 반드시 지킬 것 |
| **통화 결과 전송기** | 통화당 Idempotency-Key 1개와 최초 본문 **영속** 보관, 재시작 복구, 결과 status 기반 안내 결정, 빈 결과·무의미 통화 규칙, 배송비·결제 방식 결정 | L7, be-api §8 |
| **인사이트 생산자** | events(순번·eventId 영속), analysis(`result` 금지 신계약), unanswered-questions | be-api §10-12 (미구현) |
| **페르소나 수신·적용** | `/internal/persona/options`, `/internal/persona/refresh` 노출, ACTIVE/PENDING 조회, 통화 시작 시 버전 고정, apply-result 회신 | be-api §13 (미구현) |
| **앱 조립·설정(Composition root)** | FastAPI 앱, 의존성 생성·주입, 설정 로딩(`server.toml` 대체), RAG/FAQ 기동(동기 초기화의 스레드 실행), shutdown | L5, T2 |
| **관측성** | 첫 유효 음성 응답 시간, 도구·BE·RAG 단계별 지연 P50/P95, 개인정보 마스킹 로그 | P7, AGENTS.md §7 |

## 4. 제거할 수 있는 모듈·코드

| 대상 | 이유 |
|---|---|
| `BackendAPI.update_order`, `recent_orders`, `PREFIX="/internal/ai"` | BE에 없는 옛 계약, 실제 BE에서 실패(`api.py:425-440`) |
| `tools/rag/text_agent.py` | 실험용 Responses 루프, 운영 미사용, `search_manual` 이중 정의 |
| `tools/rag/prompts.py`, `tools/rag/delivery.py`, `tools/rag/embeddings.py` | 운영 경로 미사용(테스트 전용·미참조) — 새 Live 어댑터에서 append 분할이 필요한지 확인 후 |
| `rag.toml` `context_k` | 미사용 설정(evidence 3개 하드코딩) |
| `ToolContext.records`의 원문 인수·결과 전체 보관 | PII, 인사이트 계약은 원문 tool 인자 전송 금지 |
| `INCOMING`의 `live.call.incoming` | 구 이름 — 현재도 발송되는지 확인 후 |

## 5. 추가로 필요한 모듈

| 모듈 | 필요 이유 |
|---|---|
| BE 계약 테스트 | 원문(`docs/be-contract/backend/`) 스키마로 요청 본문 검증(좌표·null·UUID 키·결제수단 생략) |
| 공통 전화번호·한글 숫자 정규화 | D1, D2 통합 |
| 시계·ID 생성기 주입 | T3, T4, UUID 키·eventId |
| 영속 저장소(통화 결과 키/본문, 인사이트 이벤트, 웹훅 중복 제거) | 재시작·다중 인스턴스 대비 |
| 미답변 질문 클라이언트 | BE 계약 존재, 미구현 |
| 통화 시나리오 시뮬레이터(E2E) | 가짜 Live 이벤트 + MockBackend로 흐름 회귀 테스트 |
| 지연 측정 하네스 | P50/P95 기준선 |

---

## 6. 설계 전 확인해야 할 질문과 결정 사항

### 6.1 OpenAI / GPT-Live-1 (저장소에 근거 없음 — 외부 확인 필수)
1. "Responses Delegation"의 정확한 API: 위임 트리거(`<|SpawnThinking|>` 지시문 방식인지 세션 설정인지), 위임 모델 지정 방법, 도구 정의 위치(Live 세션 vs 위임 응답), 도구 결과 반환 경로.
2. accept 본문 `session` 스키마(voice, VAD/턴 감지, 도구, 지시문)와 BE 페르소나 필드(`voiceId`, `speakingRate`, `turnWaitLevel`) 매핑.
3. sideband 이벤트 목록과 서버가 말을 주입하는 공식 방법(옛 `thinking.append`/`commentary.append`/`session.instructions.append`가 현재 유효한지).
4. 웹훅 재시도·타임아웃 수치, `live.call.incoming` 발송 여부, 세션 만료·컨텍스트 교체 동작.
5. 동시 세션 한도(요금제)와 서버 동시 통화 상한.

### 6.2 BE와 확인 (BE 변경 요구 아님, 의도 확인)
6. **수거 시각**: BE가 고객 시각을 무시하고 결제/접수 +1시간을 쓰는 것이 의도인지 → 수거 일시를 계속 물을지, 안내 문구를 바꿀지 결정.
7. 미기재 error.code: pins 409(상태), parcels/cancel 전체, companies/search, orders 403/404/409(다른 키)/503, 같은 키 재요청 HTTP 코드.
8. 미완료 결과의 `totalAmount: null` 허용 여부.
9. 권장 타임아웃(디버 10s 외), `call_session_seq` 헤더 경유 프록시 여부.
10. 서비스 인증(S15P31D109-135) 도입 시점.

### 6.3 제품·운영 결정
11. 운영 지시문의 원천: BE 페르소나 `promptText` 단일화 vs 서버 고정 지시문 + 페르소나 일부(11-02 배포 차단 원인).
12. 두 열쇠 유지 여부와 판정 방식(별도 판별 LLM 호출 유지 시 지연·비용), `commit_delay_ms` 700ms 유지 여부.
13. 무의미 통화 판정 기준(2단계 등록 시점 결정).
14. ambiguous 주소 처리: 후보를 되묻기 vs 1순위 확인 질문.
15. 신규 고객 자동 등록 시점 유지 여부(보내는 분 정보 완성 시).
16. 배포 형태: 단일 인스턴스 vs 다중 → 상태 저장소(메모리/SQLite/Redis) 선택. 대규모 의존성 추가는 승인 필요.
17. 발화 문구(`flow.toml [say]`)를 글자 그대로 재현할지(`LANGGRAPH_REBUILD.md:434`).
18. 지연 목표치(첫 유효 응답 P50/P95)와 측정 방법.
19. RAG `min_score` 보정, `lookup_limit`=5 한계 수용 여부.
20. 상담원 전환 대상 URI·운영 시간 설정 출처.
