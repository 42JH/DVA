# Worklog

## 2026-11-03 — 현행 분석·문서화 (코드 변경 없음)

- 작성: `docs/contracts/be-api.md`, `pbx-webhooks.md`, `tool-contracts.md`, `docs/architecture/current-state.md`, `rebuild-assessment.md`
- 소스코드 수정 없음. 외부 계약 변경 없음.
- 테스트: `uv run pytest -q` → 364 passed.
- 주요 발견: GPT-Live-1 세션·Responses Delegation·sideband·통화 생명주기 코드 부재 / `submit_result` 503 처리 BE 권고와 불일치 / ambiguous 주소 확정 기록 / 주소 보정 전역 락 / 수거 시각 BE 충돌 미결.
- 남은 일: `rebuild-assessment.md` §6 질문 확인 후 설계.

## 2026-11-03 — 새 아키텍처 설계 문서 (코드 변경 없음)

- 작성: `docs/architecture/overview.md`, `call-lifecycle.md`, `delegation.md`, `conversation-state.md`, `error-recovery.md`, `latency-strategy.md`, `docs/testing/test-strategy.md`
- OpenAI 동작 근거: 설치 SDK `openai==3.35.1` 타입 + 공식 가이드(live-delegation, live-prompting, voice-server-controls). 미확인 항목은 문서에 표시.
- 추천안: A안(Responses 위임 + 서버 결정 도구, 통화당 액터). 구현은 사용자 승인 전 보류.
- 사용자 지시로 송장번호 조회·분실·대리점 미입고 시나리오 제거.

## 2026-11-03 — 아키텍처 v2: 경량 비동기 멀티콜 + Decision 우선 경로 (코드 변경 없음)

- 개정: `overview.md`(v2, 5개 질문 답변·A안 대비 변경·위험·구현 순서), `delegation.md`(Decision·Live·위임 경로), `conversation-state.md`(필드 버전, 토큰 없는 확인), `call-lifecycle.md`(Actor/Queue 제거), `error-recovery.md`, `latency-strategy.md`(구간 5종·부하 테스트), `testing/test-strategy.md`
- 신규: `concurrency.md`(CallSession·Lock·필드 버전·자원 제한·다중 인스턴스)
- 근거: SDK `types/decision.py`·`decision_trigger_param.py`·`connect_server_event.py`, 가이드 `decisions-voice`·`decisions`. Decision은 열거형 답만 반환(자유 텍스트 추출 불가) → 값 입력은 Backend 위임 유지.
- 핵심 미확인: Responses 위임 세션에서 트리거 동시 동작, 트리거 발동 시점 → S0 스파이크.

## 2026-11-03 — 아키텍처 v3: Live-1 자율 진행 + 서버 선택 개입 (코드 변경 없음, 기획 변경 반영)

- 신규: `docs/architecture/workflow-policy.md`(정책 파일 구조, Business State 분리, 자율 경계, 누락 방지 6층)
- 개정: `overview.md`(v3, 6개 질문 답변), `delegation.md`(트리거 입력+출력 2개, 선택적 Tool 경로 A/B/C1~C3, Responses vs Client 비교, 전달 등급 N0~N3, 충돌 6상황), `conversation-state.md`(`next_step` → `assess`), `error-recovery.md`, `latency-strategy.md`(요구 4구간), `test-strategy.md`
- 재확인: Decision은 자유 텍스트 인자 추출 불가(D1) → 값 입력은 Responses 위임 유지. 추천: Responses Delegation + Decision 트리거.

## 2026-11-03 — v3 보완: Decision·Backend 역할 분리 (코드 변경 없음)

- `delegation.md`: 판단 유형별 단일 소유자 표, 위임 경로 Structured Outputs = strict 함수 도구(SDK: 위임 `text`에 `format` 없음), 단계별 Decision 질문 세트(선택형 단계에서만, 선행 단계 아님), 실행 경로 5종, 복합 발화 통합 규칙 R1~R6
- Decision의 값 발화·정정 감지 질문 제거(위임 누락 감시 제거 → 필드 EMPTY 유지 + gate로 보장)
- 반영: `overview.md`(F15, Q4), `workflow-policy.md`(단계별 decision 세트, 필드 kind), `conversation-state.md`(G6), `error-recovery.md`, `call-lifecycle.md`, `test-strategy.md`

## 2026-11-03 — 사용자 결정 P1~P11·BE 변동성 반영 (코드 변경 없음)

- 신규: `docs/architecture/decisions.md`(결정 기록, 다른 문서보다 우선)
- 반영: 수거 시각 now+1h(P1), 페르소나 promptText 우선(P2), 단일 워커(P3), N3 3회 후 상담원 제안(P4), `ParcelStore`로 접수 전 택배 수정(P5), ambiguous 1순위 자동 확정(P6), 등록 조건 성함·전화번호·주소(P7), 스크립트 영역 예약(P8), 상담원 설정값화(P11), BE 계약 변동 대응 구조(`overview.md` §7)
- 남은 결정: P5 후속(수정 후 미확인 택배가 있는 채 종료 시 결과, 기본안 INCOMPLETE)

## 2026-11-03 — 결정 보완 (코드 변경 없음)

- P1: 저장소 BE 원문(결제 +1시간)은 구식, 사용자 결정이 기준
- P2: `promptText` 확보 실패 시 서버 기본 프롬프트 사용
- P6: 자동 확정에 대한 추가 보완 장치 제거(되읽기 필수 포함 규칙 삭제)
- P5 후속: B안 — 재확인 전 종료 시 마지막 확인 스냅샷 전송(`StoredParcel.confirmed_snapshot`)

## 2026-11-03 — S0 스파이크 도구 작성 (기존 소스 변경 없음)

- 신규: `.env.example`, `.env`(빈 값, gitignore 대상), `spikes/s0/server.py`(수신→accept[Responses 위임+트리거 2개]→sideband 기록, 도구 1개, append 실험 3종, 트리거 교체), `spikes/s0/analyze.py`(U1~U7 보고서), `spikes/s0/test_analyze.py`, `spikes/s0/README.md`(준비·대본·판단 기준)
- 검증: `uv run pytest spikes/s0 -q` 1 passed, 세션 설정·session.update·append 3종 페이로드를 SDK TypedDict로 검증 통과. 실통화는 미실행(사용자 환경 필요)
- 발견: sideband 재연결은 `on_reconnecting` 콜백을 넘길 때만 켜짐(SDK `sideband.py`)

## 2026-11-03 — S0 실행 오류 수정

- 증상: `uvicorn` 실행 시 "Unable to create process using C:\Python314\python.exe". 원인: uvicorn이 프로젝트 의존성에 없어 PATH의 전역 uvicorn.exe(삭제된 Python 경로)가 잡힘
- 조치: 실행 명령을 `uv run --env-file .env --with uvicorn python -m uvicorn ...`로 변경(README, server.py docstring). 의존성 추가 없음. 기동·`/healthz` 확인

## 2026-11-03 — 관제·Docker·Qdrant 이관 (원본 S15P31D109/ai에서)

- 신규 `monitor/`(Bus, 인증 라우터, 정적 화면, 테스트 5개): 원본 `app/monitor`·`app/events.py`에서 흐름 엔진·통화 레지스트리 의존 제거. `/api/graph`(옛 흐름 엔진)·`/api/orders`(옛 BE 계약) 제외. S0 스파이크 서버에 연결(받아쓰기·도구·위임·Decision·실험 사건, 끝난 통화 30분 유지)
- 신규 `Dockerfile`·`.dockerignore`·`compose.yaml`(qdrant v1.13.4 + ai)·`compose.qdrant-dashboard.yaml`·`scripts/index_manual.py`(원본 index_markdown을 tools.rag 경로로)
- 의존성: `uvicorn` 추가(원본에도 있던 것, 컨테이너 실행에 필요) → uv.lock 갱신. 이전 `--with uvicorn` 우회는 그대로 동작
- `.env.example`/`.env`에 MONITOR_*, AI_PORT, ADDRESS_DATA_DIR, AI_IMAGE 추가(기존 값 보존)
- 검증: pytest 369 passed, spike 1 passed, index dry-run OK, docker build OK, compose 스모크(healthy, /healthz 200, /monitor 401/200, ai→qdrant 인증 OK, 호스트 6333 미노출)
- 위험: qdrant-client 1.19.1 ↔ 서버 1.13.4 버전 불일치 경고(원본도 동일)

## 2026-11-03 — S0 결과 정리 (실통화 2건)

- `spikes/s0/RESULTS.md`: 위임+트리거 공존 OK, Decision p50 ~140ms·p95 ~400ms(delta마다 발동, 순서 역전 있음), commentary 즉시 발화·thinking 무음, instructions.append는 발화를 끊지 못하고 다음 턴에 반영, 오디오 반사 입·출력 ~120KB/s, 출력 감시 predicate 실패, **위임 1회 7~16초**(Backend gpt-6-luna 생성 2번)
- 수정: 출력 오디오 타입 `session.output_audio.delta`(server·analyze), N3 표식 지연 계산(발화 묶음 시작 → 표식 delta 수신 시각)
- 다음: S0b(위임 지연 단축·대기 멘트·발화 중 N3·출력 감시 문구) — RAG 원본 이관 확인 후 진행

## 2026-11-03 — RAG를 원본 그대로로 교체 (사용자 지시: RAG는 다른 담당자 구현, 수정 금지)

- 삭제: `tools/rag/`(이전 이관 때 경로·설정·FAQ 출처를 바꾼 사본), `tools/tests`의 RAG 테스트 14개, 내가 만든 `scripts/index_manual.py`
- 원본 그대로 복사(바이트 동일 확인): `app/rag/`, `app/webhooks/faqs.py`, `manuals/`, `config/rag-*.json`, `prompts/rag_context.md`, `gpu/`, RAG `scripts/`(라이브 랩 3개 제외), `evaluation/`, `spec/rag.md`·`faq-sync.md`, `docs/rag-handoff.md`, 원본 RAG 테스트 13개(`tests/`, 원본 서버 앱 의존 4개 제외)
- 우리 쪽 호환판: `app/config.py`(ROOT·config_dir·prompts_dir·RagConfig·FaqSyncConfig·load_server_config의 rag/faq_sync/backend.timeout_sec), `app/backend_api.py`(→ backend_client), `app/webhooks/pbx.py`(→ pbx_webhook.sip.token_ok), `config/server.toml`([rag]·[faq_sync] 원본 섹션 + [backend].timeout_sec)
- `backend_client`: `faq_page` → 원본 인터페이스 `faq_entries`·`initial_faq_entries`(BE·가짜 BE 모두 원본 메서드 그대로)
- `tools/search_manual.py`가 `app.rag.schemas` 사용, Dockerfile·.dockerignore를 원본 규칙 기준으로 갱신(tiktoken 캐시 포함)
- 검증: pytest 329 passed(원본 RAG 테스트 포함, 호환 테스트 4개 신규), docker build·compose 스모크(컨테이너에서 원본 RAG 로드·Qdrant 인증 OK), `scripts.index_markdown --dry-run` OK
- 보완: 원본 `.gitattributes` 복사(RAG 원문·검색 설명·평가 데이터를 줄바꿈 변환 없이 저장 — 바이트 해시 보존). 앞 커밋에서 CRLF→LF로 정규화돼 저장됐던 `config/rag-search-descriptions.json`·`evaluation/datasets/*`를 원본 바이트로 다시 저장(blob == 원본 확인)
- 사고: 검증 중 불필요한 `git stash`/`reset --soft HEAD~1`로 HEAD가 한 커밋 뒤로 갔다가 reflog로 즉시 복구(유실 없음)

## 2026-11-03 — S0 결과 정정 (사용자 질문: 체감 대기가 길지 않았다)

- 로그 타임라인 재확인: Live는 위임 시작과 동시에 대기 멘트를 스스로 말한다(고객 발화 끝 → 0.1~0.9초, 4회 모두). 실제 공백은 대기 멘트 끝 → 결과 발화 6.8~11.3초. "그동안 침묵" 서술을 정정
- 정정: "312동 403호"는 고객이 실제로 말한 값 — "세부를 지어냈다"는 서술 철회. 남는 문제는 서버 기록 없이 "주소도 받아뒀어요"라고 말한 것
- `spikes/s0/RESULTS.md` 지연·출력 감시·S0b 질문 2·4 갱신

## 2026-11-03 — S0b 스파이크 준비 (사용자 승인: 대기 멘트 실험 제외 구성)

- `spikes/s0/server.py`: `SPIKE_BACKEND_SERVICE_TIER`(위임 `service_tier`, 비우면 생략), `SPIKE_FINAL_MODE=commentary`(도구 결과 뒤 `response.create` 대신 서버가 도구 결과만 근거로 사실을 `session.commentary.append` — SDK상 Responses 위임에는 `delegation_id` null만 허용), `SPIKE_PROBES`를 실험 이름 목록으로(기본 instructions), instructions 실험은 AI 발화의 3번째 전사 delta에서 송신(발화 도중), 출력 감시 문구를 "가장 최근 AI 문장" 기준(`asks_confirmation@o2`, `claims_done@o2`)으로, 통화 로그 `incoming`에 실험 설정 기록
- `spikes/s0/analyze.py`: 위임 경로 표(고객 끝→대기 멘트, 위임→함수 호출, 도구 결과→결과 발화, 공백), 실험 송신 시 발화 도중 여부·이후 계속된 글자/시간, AI 발화별 출력 predicate 최댓값, 실험 설정 표시. S0 로그 재분석 값이 수작업 타임라인과 일치(공백 11.2·8.1·6.8·9.6초). S0 instructions 실험은 발화 끝 0.35초 전(남은 1~5글자)에 보내졌음을 확인
- `test_analyze.py` 2개 추가(위임 경로·발화 도중 판정, `facts_text`), `.env.example`·README 3b절(회차 b1~b3)
- 검증: `pytest spikes/s0` 3 passed, 전체 329 passed, service_tier 설정 반영 확인. 실통화는 사용자 몫

## 2026-11-03 — S0b 결과 분석 (실통화 3건: b1 기본, b2 priority, b3 priority+commentary)

- priority tier: Backend 생성 1회 ~9초 → 0.5~0.9초(위임→함수 호출 0.65초, 고객 끝→결과 발화 3.1초). 기본 tier는 S0보다도 느렸다(9초)
- commentary로 최종 문장 생략: 도구 결과 뒤 response.create를 안 보내자 Live가 27초간 무발화·무위임(세션 정지) → 폐기, F6 유지
- 발화 도중 instructions.append: 4번 중 2번 발화가 끊겼지만 정정 문장은 다음 턴 — 미확정, N3은 다음 턴 반영 + 하드 gate로
- 출력 감시 `claims_done@o2`: 평범한 질문에도 0.54~0.85 → 안전장치로 못 씀(설계 그대로)
- Live가 도구 결과 전에 "성함 확인했습니다", 연락처 전 되읽기 → 하드 gate 필요 근거
- `analyze.py` 수정: 결과 발화를 다음 위임 전까지로 한정, 발화 도중 판정을 "보낸 시각에 발화가 끝나지 않음"으로(이전엔 끝난 직후 0.7초도 포함). `spikes/s0/RESULTS.md` S0b 절

## 2026-11-03 — 결정 기록: 위임 Backend priority

- `decisions.md` S0b 행: `service_tier="priority"`(Fast mode) 고정, 도구 결과 뒤 항상 `response.create`. 근거·가격(gpt-6-luna Fast = Standard 2배)·강등 감시 지표. `overview.md` §6 갱신

## 2026-11-03 — S1 기반·계약 (사용자 승인: "S1 진행해")

- `backend_client/api.py`: `BackendError(message, status, code)` + `_fail()`로 모든 HTTP 실패에 상태·error.code를 담음. 계약 불일치 수정(`be-api.md` §B): 503을 같은 키 재확인에 포함, PIN 409는 `DUPLICATE_RESOURCE`만 성공, 페르소나 토큰 없으면 "Bearer None" 대신 실패, insights 재시도 오류 처리 정리, 연결 풀 `limits` 인자. 기업 검색의 클라이언트 오류에 code(`ARGUMENT_INVALID`·`TRANSPORT`·`RESPONSE_INVALID`)
- `backend_client/mock.py`: 가짜 BE 오류에도 상태·코드
- 신규 `app/integrations/backend/gateway.py`: `BackendFailure(kind, code, http_status, error_code, retryable)`, `classify()`(error-recovery.md §2.1 표), `BackendGateway.read/write`(전역 세마포어, 세마포어 대기 포함 예산, 읽기만 1회 재시도, 계약 위반 ERROR 로그)
- 신규 `app/observability/trace.py`: `trace_id` contextvar, 로그 필터, `span()` + 훅(지표는 S7)
- 신규 `app/main.py`: lifespan에서 BE(실제/`BACKEND_MOCK`) + 게이트웨이 1개, `app.state.svc`는 원본 FAQ 웹훅이 읽는 모양(cfg·faq_events·faq_processor), `/healthz`. 통화 수신은 S4
- `app/config.py`·`config/server.toml` `[backend]`: max_concurrency·read/write 예산·submit 시간(원본 RAG가 읽는 timeout_sec 유지)
- 계약 테스트 `app/tests/test_be_contract.py` + 픽스처 `app/tests/fixtures/be_contract/a629c60/`(BE 원문 예시 그대로 5개): 원문 응답 해석, 모르는 필드 무시, 사용 필드 누락 → `BE_CONTRACT_VIOLATION`, 요청은 원문 필드만·좌표 없음, 가짜 BE 오류 분류 일치
- 테스트: 329 → 369 passed(게이트웨이 18, 계약 12, 클라이언트 동작 6, 조립 2 등). 실제 BE 연결은 미확인
- 남음: 카카오 공유 클라이언트·세마포어(S3 주소 실행기와 함께), Idempotency-Key UUID 검사, `be-api.md` §B 3·4·8·9·10

## 2026-11-03 — S0c: 트리거 대신 독립 Decision API (로그 재생, 사용자 승인)

- `spikes/s0c/replay.py`: S0·S0b 로그 6건의 고객 발화 57개마다 `POST /v1/decisions` 1회(직전 AI 발화 + 고객 발화만), 트리거 마지막 결과와 비교, delta 간격 분석
- 결과(`spikes/s0c/RESULTS.md`): 토큰 564k(트리거 2개) → 21k(1/27), 지연 웜 p50 251·p95 284ms(첫 4건 콜드 1.7~2.3초), 확인 질문이 아닐 때의 confirm=yes 오판정 4건이 not_answer로. delta 간격은 0.7초 이하/0.8초 초과로 갈림 → 발화 끝 = 0.8초 무 delta
- 다음: 설계 수정(트리거 제거 → 서버가 발화 끝에 독립 판정) — 사용자 확인 후

## 2026-11-03 — 설계 v3.1: Decision 트리거 제거, 서버 호출 독립 Decision (사용자 승인)

- `decisions.md` S0c 행 추가(결정·근거·남은 위험)
- `delegation.md` v3.1 재작성: §3 트리거 구성 → 서버 Decision 호출(발화 끝 800ms, 입력 = 직전 AI 발화 + 고객 발화, 단계별 질문 세트, confirm은 pending 있을 때만, 예산 1.0초, 웜업, `DECISION_STALE`), 출력 감시 제거(§3.4), R1 발화 연결을 `utterance_id`·`offset_ms`로, N3 = 서버 결정적 결과 문구 검사 → 다음 턴 정정, §6.2-2·5·§7.3·7.4 갱신, §8 세션 설정(triggers 없음, service_tier priority), §9 S0~S0c 결과표
- `conversation-state.md`: `readback_end_ms` → `issued_t`, G1·G3 재정의(직전 AI 발화가 pending 발급 뒤 시작 + 고객 답이 그 뒤), 조기 되읽기는 감지 대신 gate로
- `workflow-policy.md`: `[forbid].claims`(고위험 결과 문구), 층 5 출력 감시 → 결과 문구 검사
- `overview.md`(D3·D9·F1·Q2·Q3·Q4·Q5·다이어그램·§3·X1·X2·X5·S0·S5·§6), `error-recovery.md`(Decision 코드·시나리오), `latency-strategy.md`(경로 D·지표·L1·L13), `concurrency.md` §3.3, `call-lifecycle.md` §4, `test-strategy.md`(L0·이벤트 표·Decision 평가) 정합
- 코드 변경 없음

## 2026-11-03 — S2 정책·도메인 (사용자 승인: "S2 진행해")

- 정책: `policy/workflow.toml`(필드 목록·받는 순서 고정 단계·P1 수거 1시간·재질문 3회·확인 임계값·금지·결과 문구·읽기 규칙·Decision 질문 세트), `policy/default_prompt.md`(P2 대체 프롬프트, voice.md 기반)
- `app/policy/model.py`: 엄격 로더 + 정합성 검사(모르는 필드, 한 필드 두 단계, gate 단계 수집 항목, 질문 세트 누락, choice 2~255, 자유형 질문 타입 금지). `render.py`: `render_live`(promptText 우선·빈 값이면 기본 프롬프트 + 절차·위임 규칙·금지·읽기 규칙), `render_backend`, `decision_questions`(단계별, confirm은 pending 때만, pick은 후보 이름표로)
- `app/domain/`: `state.py`(FieldState·ParcelDraft·ConversationState·PendingConfirmation, 버전 규칙, 정정 실패 시 기존 값 유지), `assess.py`(단계·누락·blocked·readback_ready·결제 자동·재질문 초과·재확인 대기, `readback_facts`), `confirm.py`(G1~G5 관문, 확정 지연 뒤 G1·G2 재검사, release), `store.py`(P5 수정·B안 전송 스냅샷), `outcome.py`(COMPLETE/INCOMPLETE/CANCELLED/미전송 + 사유), `claims.py`(결과 문구 검사)
- `app/integrations/backend/mapping.py`: 도메인 스냅샷 → `Order` → `result_body`(BE 필드 이름은 기존 한 곳)
- 수정: S1 계약 테스트의 수량 필드 집합이 틀렸음(largeBoxCount 등 → BE 원문 documentCount·smallBoxCount·mediumBoxCount·bigBoxCount). 수량 4종을 다 쓰는 본문으로 다시 검사
- 테스트: 369 → 413 passed(정책 일관성 16, 도메인 28 등)
- 남음: 요금표(fare) 없음 → 실제로는 COMPLETE가 나오지 않음(be-api.md §8), 값 검증(전화번호·주소·수거 시각)은 S3 도구, G6·발화 묶기는 S5, 기본 프롬프트·정책 렌더링 문구는 실통화 조정 필요

## 2026-11-03 — 배송비 요금표 연결 (사용자 지시: 원본 그대로)

- `config/server.toml` `[fare]`: 원본 값·주석 그대로(서류 3850·소형 4950·중형 6050·대형 7150). `app/config.py` `FareConfig`(원본 정의 그대로), `load_server_config`가 `[fare]`도 읽음
- `app/domain/fare.py` `parcel_fare`: 원본 `Call.parcel_fare` 규칙 그대로(요금 없는 규격·기타 물품·물품 없음 → None)
- `app/main.py` `Services.fare_of` 연결. `decisions.md` FARE 행, `be-api.md` §8 갱신
- 테스트 423 passed(요금 규칙 7, 두 택배 COMPLETE 금액·합계, 기타 물품 INCOMPLETE, 조립 연결)

## 2026-11-03 — S0d: 스파이크 서버에 서버 호출 Decision 모드 (사용자 승인)

- 사용자 지적: Decision이 여전히 많이 호출됨 → 확인 결과 통화를 받은 것은 S0 스파이크 서버(트리거 2개 그대로)였다. v3.1은 문서·도메인·로그 재생에만 있고 실통화 미검증이었음(S2 보고에서 명시하지 않은 것은 누락)
- `spikes/s0/server.py`: `SPIKE_DECISION_MODE=server`면 트리거 미등록, 입력 delta마다 발화 끝 타이머(`SPIKE_UTTERANCE_GAP_MS`) 재시작 → 만료 시 직전 AI 발화 + 고객 발화로 `POST /v1/decisions` 1회(예산 1.0초, 오류·초과는 기록만), `decision_call` 로그, 관제 사건, 시작 시 웜업. 트리거 교체 실험은 server 모드에서 끔
- `spikes/s0/analyze.py`: "Decision 호출 수·토큰" 절(트리거 건수·토큰 / 서버 호출 수·토큰·발화 끝 감지·API 지연·마지막 delta → 결과)
- 발견·수정: `compose.yaml`이 `SPIKE_BACKEND_SERVICE_TIER`·`SPIKE_FINAL_MODE`를 컨테이너에 넘기지 않았다(Docker로 띄운 17:51 통화가 tier 없이 돎). 새 변수 포함 전달, `SPIKE_PROBES` 기본 0. `.dockerignore`에 `spikes/*/logs`(s0c 보고서 전사가 이미지에 들어가지 않게)
- `.env`(커밋 안 함): server 모드·priority·probes 0. `.env.example`·README 3c절
- 테스트: 발화 끝 묶기·직전 AI 발화·호출 1회(가짜 클라이언트), 분석 절. 컨테이너 안에서 server 모드 설정 확인

## 2026-11-03 — S0d 실통화 결과 기록

- 2건: Decision 429건/40만 토큰(트리거) → 9~10건/3.4~3.7천 토큰(서버 호출), 발화 끝 감지 ~0.8초, API p50 278~351·p95 441~943ms, 확인 답 판정 정확(yes·change·not_answer). 위험: API p95가 예산 1.0초 근접, Live가 결과 전 되읽기·틀린 번호 되읽기 → S3 검증·하드 gate. `spikes/s0/RESULTS.md` S0d 절

## 2026-11-03 — S3 도구·연동 (사용자 승인)

- 신규 `app/tools/`: `executor.py`(ModelTool 등록·strict spec, run_tool: call_id 결과 캐시 → 허용 확인 → 인수 검증 → 예산 실행 → ToolOutcome), `outcome.py`(status·code·facts·needs + 상태 요약), `context.py`(state·lock·policy·게이트웨이·주소·RAG·시계), `record.py`(record_fields: ① 버전 읽기 ② 잠금 밖 주소 보정 병렬 ③ 버전 검사 반영, 전화번호·P1 수거·not_found·ambiguous 1순위+후보 보관(P6)·장애 시 들은 값+geo 없음·상세주소 비우기·정정 실패 시 기존 값 유지·되읽기 gate 개방 시 확인 내용), `lookup.py`(find_destination·lookup_orders·search_manual·get_state, 후보는 state.candidates), `cancel.py`(서버 전용 취소: ops 키, 불확실 후 재조회)
- 도메인: `rules.py`(원본 normalize_phone 그대로 + parse_pickup P1), `candidates.py`(offer·apply_pick·reject), state에 Place·CandidateSet·call_session_seq·places·selected_order, 새 택배에 발신번호 자동(CALLER_ID)
- 연동: `app/integrations/address.py` AddressService(전용 스레드풀, 카카오 공유 클라이언트·세마포어, 예산 2.5초). `address_resolver`: `kakao.geocode(http=)` 공유 클라이언트 인자, `correct_blocking`. `app/main.py`에 주소DB 로드·AddressService 연결
- 삭제: 옛 `tools/` 패키지와 테스트(사례는 `app/tests/test_tools.py`로 옮김). `pyproject` testpaths, Dockerfile(`tools` 대신 S2에서 빠져 있던 `policy/` 복사 — 이미지에 정책 파일이 없던 버그 수정)
- 정정: S0d 결과에 "틀린 번호 010-283-54286은 S3 자릿수 검증으로 막는다"고 썼으나 11자리라 통과한다(테스트로 확인). 되읽기 확인으로만 잡힌다 — RESULTS.md 정정
- 문서: `tool-contracts.md` §0 현행 계약, `error-recovery.md` 내부 코드(TOOL_TIMEOUT·NOTHING_CHANGED)
- 테스트: 429 passed(도구 36: 규칙·실행기·기록·주소 확정/못 찾음/애매/장애/늦은 결과·되읽기 개방·받는 곳·조회·취소 중복/잠김/불확실·검색·상태), 이미지 빌드·정책·도구 로드 확인
- 남음: 결제·상담원 확인, 통화 결과 전송(아웃박스)·refer는 S5·S6, 주소 실행기 thread vs process는 S7 측정, 카카오 호출 한도 [미확인]

## 2026-11-03 — S4 세션·생명주기 (사용자 승인)

- 신규 `app/calls/`: `session.py`(CallSession: phase·closed·hangup_after_accept·tasks·timers·events, spawn/set_timer, event_id = trace_id:seq, 관제 스냅샷 — 값 없음), `registry.py`(session_id 중복 거부·동시 통화 상한·발신번호 색인), `service.py`(CallService: 수신 → 1단계 고객 확인 ∥ 페르소나(캐시, 실패 시 서버 기본 프롬프트 P2) → accept(정책 렌더링·Responses 위임 priority·트리거 없음) → sideband 수신 루프(오디오 반사 미파싱, 동기 핸들러 표) → session.started 만료·무발화 타이머 → 마무리(출력 정지 후 hangup) → 정리(closed → 타이머·작업 취소 → 진행 부작용 unknown → on_finalize 훅 → registry 제거). 2단계 통화 등록 1회(ops["stage2"])·call_session_seq 대기, PBX 종료 매칭(ended_at 전 시작한 통화만, ACCEPTING이면 accept 뒤 끊기), shutdown
- `app/config.py` CallConfig + `[call]` 설정, `app/main.py`에 통화 수신·PBX·관제 라우터(키 있을 때만)
- 테스트 13개(가짜 OpenAI·가짜 BE): 정상 경로·자원 0, 페르소나·1단계, 1단계 장애, 상한·중복, accept 실패, accept 중 PBX 종료, ACTIVE PBX 종료·재통화 보호, 2단계 1회, 무발화 마무리, 수신 루프 예외, 진행 부작용 unknown, 이미 끝나는 통화. 전체 통과
- 남음: 함수 호출 라우터·발화 끝 Decision·notifier(S5), 결과 아웃박스(S6), 페르소나 음성·회신, RAG 연결, 실통화 미검증

## 2026-11-03 — S5 Decision·위임·전달 (사용자 지시: 실통화는 가짜 BE)

- 신규 `app/calls/live.py` LiveFlow(CallService 핸들러 확장): 입력·출력 전사를 발화로 묶기(0.8초), 고객 발화 끝 Decision(단계별 질문, confirm은 확인 대기 때만, pick은 후보 이름표), 결과 적용(최신 발화만, 임계값), confirm yes → 관문 G1~G5 → G6 보류 → 확정 지연(새 입력 시 취소) → 담기/취소 실행 → N2, no·change 즉시 해제, task·switch(업무 시작·전환·담은 택배 수정·더 없음·마무리·상담원 미설정), pay 기록. 함수 호출 라우터(첫 업무 도구에 2단계 시작, 조회는 통화 번호 대기, 결과 → response.create). 전달 N1' thinking / N2 commentary(발화 정지·위임 완료 뒤) / N3 instructions(결과 문구 검사, 3회 후 이관 제안 사실), 같은 내용 1회
- 도메인: 취소 확인(`issue_cancel_confirmation`·`take_cancel`), 후보 kind=parcel(P5 고칠 택배 선택), 되읽기 facts의 물품을 읽을 수 있는 형태로(JSON 직렬화 버그 — 대본 테스트로 발견)
- 서비스: `begin_closing(after_speech)` — 마무리 인사가 나온 뒤 조용해지면 끊기, 정리 때 S5 타이머 취소. 관제 스냅샷에 전사, 통화 끝 `logs/calls/<trace_id>.json`
- 안전: `.env`에 `BACKEND_MOCK=true`(기존 `.env`에 실제 BE 주소가 있었음), compose 기본 `BACKEND_MOCK=true`, 시작 로그에 BE 종류. 메모리 `live-test-mock-backend`. 실행 안내 `docs/ops/live-test.md`
- 테스트: 대본 재생 3개(접수 끝까지·확인 내용 전 "네"는 확정 안 함·모델의 서버 전용 도구 호출 거부 + 결과 문구 N3). 전체 445 passed. 실통화 미검증

## 2026-11-03 — S5 실통화 2건(가짜 BE) 분석과 수정

- 결과: 두 통화 모두 수신 → 접수 의도 → 값 기록(위임 9~13회) → 되읽기 → 확인 → 담기(p1) → 마무리까지 진행. Decision 통화당 22~34회(고객 발화 수만큼)
- 문제·수정:
  1. 관제: 단계가 바뀔 때만 알림 → 전사·사건·도구마다(0.15초 묶음). 상세에 단계·빠진 항목·받는 중인 택배 값·담은 택배·수거·결제·확인 대기·후보·통계, 도구 호출 목록. 통화 기록에 최종 상태·도구 호출
  2. 결과 문구 오탐(2번 통화): "접수 완료 결과는 확인되지 않았습니다"를 N3로 잡아 Live가 100초간 "확인 중" 반복 → 문장 단위 + 정책 `claim_skip`(부정·미래·물음 표지)로 제외, N3에 사실(`truth`) 첨부
  3. 되읽기 도중 "네, 됐습니다"로 담김(2번 통화, 원본 11-02 사고 유형) → G3에 "직전 AI 발화가 확인 질문으로 끝났는가" 추가
  4. "더 보낼 택배?" → "아뇨"가 switch=none(1번 통화) → more_parcels 단계에 `more` 질문(more/no_more), no_more는 끊지 않고 N1'. closing·payment 단계에도 switch(끝내기·문의 감지 — 대본 테스트로 발견)
  5. 서버 결과(JSON) 뜻을 Live가 오해("담기"를 "접수 대기"로) → 정책 `[results]` "서버 결과 읽는 법"을 Live 지시문에 렌더링
  6. 물품 정정("중형 두 개" → "소형") 병합 시 중형이 남을 위험 → 물품은 매번 전체 구성으로 교체(Backend 지시문·인수 설명)
  7. Live가 고객이 말한 주소 다시 읽기를 거부 → 금지 항목을 "주소록 저장 값을 먼저 읽어 주기"로 좁힘
  8. 첫 판정 DECISION_TIMEOUT(1번 통화) → 서버 시작 시 Decision 웜업
  9. 마무리 인사 요청 후 Live가 말하지 않으면 15초 대기 → 4초 안에 말하지 않으면 끊기
- 테스트 447 passed(회귀: 오탐 문장, 되읽기 도중 답, 더 없음 → 끝내기 순서, 물품 교체, 관제 직렬화)
- 남음: 매뉴얼 검색 미연결(두 통화 모두 제주 운임 질문에 KB_UNAVAILABLE), 결과 전송(S6), 실통화 재확인

## 2026-11-03 — S5 실통화 3차: 관제 스냅샷 버그 수정, 지연 분석 준비

- 사용자 보고: 주문 접수 단계 지연 폭증, 관제 화면 비정상. 통화 기록 파일이 생기지 않아 서버 측 근거 없음
- 원인(재현 확인): 관제 스냅샷이 필드 값 + 문자열을 더해 숫자(물품 가액)·물품 객체가 기록되는 순간 TypeError → 관제 중단, 통화 끝 기록 실패, 단계 전이 알림에서 예외가 나 정리가 중간에 멈출 수 있었음. 기존 대본 테스트는 통화 끝(택배가 보관소로 옮겨진 뒤)에만 스냅샷을 봐서 놓침
- 수정: 값 문자열화, 관제 알림 예외를 통화 처리에서 격리(`CallSession.publish`, 통화당 로그 1번 + 통계 "관제 오류"), 통화 기록은 스냅샷이 실패해도 사건·전사·도구 기록을 남김. 회귀: 대본 테스트의 관제 알림마다 스냅샷 JSON 직렬화
- 지연 분석 준비: 사건에 위임 시작·함수 호출 도착·Backend 응답 끝·재개·N2 대기(1초 초과) 시각 기록. 완료 이벤트를 못 받은 위임이 N2(최대 8초)·G6 보류(최대 6초)를 붙잡지 않게 15초 넘은 위임은 진행 중으로 보지 않음
- 지연 원인은 미확인(이번 통화 기록이 없음) — 다음 통화 기록으로 구간별 확인
- 실수: 검증 중 불필요한 `git stash`를 다시 실행(변경 없음, 유실 없음, HEAD 그대로)

## 2026-11-03 — S5 실통화 4차(가짜 BE, 204초) 분석

- 흐름 정상: 접수 의도 → 값 기록 → 되읽기 → "네" → 담기(p1: 서류 2, 가액 5000, 수거 내일 14:00) → "없습니다"(more=no_more 1.00, 끊지 않고 문의 받음) → 제주 운임 문의(search_manual KB_UNAVAILABLE) → "끊어주세요"(end 0.99) → 마무리 인사 → 서버가 끊음. 관제·통화 기록 정상
- 지연: 서버 쪽 없음. 위임 → 함수 호출 0.7~1.0초, 도구 실행 1~189ms, Backend 최종 응답 1.0~1.9초. Decision 20회(고객 발화 ~19개)
- 관찰:
  - Live가 값마다 위임하지 않고 모아서 위임(첫 위임 70초, 보내는 분·주소·상세·받는 분·연락처를 한 번에). 지연은 줄지만 지시문("모았다가 한꺼번에 맡기지 않는다")과 다르고, 그사이 서버 상태가 비어 있다
  - "네"·"아니요 없습니다"에도 위임(도구 없이 끝남, 각 ~1.5초) → 확인 "네"는 G6 보류 1.5초 후 담기, N2 2.8초 대기
  - 되읽기에서 받는 분 연락처를 빠뜨림(확인 내용에는 있었음)
  - "하나당 오천원"(서류 2개)을 가액 5000으로 기록 — 물품 가액이 개당인지 합계인지 정책에 없음 [확인 필요]
  - 정정 2건(성함 한→현, 연락처 끝자리) 정상 반영
- 수정: 담은 뒤 마무리 단계에서 관제 "빠진 항목"이 전부로 보이던 표시(assess.missing)

## 2026-11-03 — S6 통화 결과·고객 등록·분석·이벤트 (BE 최신 규약 spec/ai-integration-current.md, 사용자 결정 1-b·2-b·3·주소 포함)

- 규약 대조: 원본 서버(S15P31D109/ai)의 신규 고객 등록(register_customer: 고객 등록 → 고객 확인 재호출 → 보내는 곳 PIN, 결과는 customerSeq) 확인. 리빌드 버그 A(미등록 고객 결과 이름 없음 → 신규 고객 통화가 늘 INCOMPLETE)·B(결제 질문 선택지에 billing 없음) 발견·수정
- 정책: 수거 일시 단계·필드 제거("결제 후 1시간 안에 방문" 안내), 결제 질문 선택지를 고객의 실제 가능 방식으로, `[results].order`(결과 상태 읽는 법)
- 도메인: payment_auto = 가능 방식이 하나일 때만(기본 billing 제거), Outcome.customer_name(보내는 분 성함), COMPLETE 조건에서 수거 시각 제외, Customer.status·initial_status
- 신규 `app/persistence/outbox.py`(SQLite, 결과·인사이트, 전송 전 영속·재시작 복구), `app/calls/results.py`(register·start/submit·_send·recover·finish·build_insights·_send_insight: 분석 7개 값 + 필수 필드, 이벤트 UTTERANCE·AI_ACTION·BUSINESS_RESULT(uuid5 eventId, 50개·90KiB 분할), 미답변 → QUESTION_UNANSWERED)
- 흐름: 보내는 분 정보가 차면 백그라운드 등록, "더 없음" + 결제 확정(또는 끝내기)이면 백그라운드 전송 — 대화는 기다리지 않음. 통화 중 결과가 오면 N1'(order 상태), 마무리 N2에 order 상태. 정리 훅에서 결과 대기 → 인사이트
- BE 클라이언트: create_customer(address), send_unanswered. 가짜 BE: 내 주소 검증, COMPLETE 수거 시각 불요, 분석 제거 필드 거절, 미답변. Docker: /app/state·/app/logs, compose 볼륨 ai_state, .gitignore state/
- 계약 테스트 픽스처 7da8876(주문·분석·이벤트 예시). 테스트 459 passed(아웃박스·전송 1회·무의미 미전송·불확실 후 같은 키 재확인·등록과 내 주소·등록 실패 시 customer·분석/이벤트/미답변·50개 분할·대본 끝까지)
- 남음: 하위 규약 최신본 확인, 페르소나 다음 통화 동기화, RAG 연결, 실통화 확인(가짜 BE)

## 2026-11-03 — BE 하위 규약 최신본 대조, 접수 후 수정·추가 잠금

- 최신화: 원본 저장소 fetch, origin/develop-backend `17d86ce`, 로컬 develop-ai를 `df93338`까지 빨리감기(guardrail 작업 폴더, 메인 작업 폴더는 미커밋 변경이 있어 건드리지 않음)
- 대조(a629c60 → 17d86ce): ai-integration-current.md는 spec 사본과 같음. call-events·unanswered-questions·order-submit·caller-context·customers·pins·persona 변경 없음
  - call-analysis.md: hasHandoffRequest = 고객의 상담원 연결 요구 여부(성공·실패 아님) — 우리 값(상담원 의도 시 켜짐)과 일치
  - order-submission-retry.md(신규): BE가 디버 10초 대기·10분 동안 1분 간격 재신청 후 SUBMISSION_FAILED. ACCEPTED만 성공 — S6 처리와 일치
  - ai-faq-integration.md: 단건 GET /api/ai/faqs/{id} 제거 — 리빌드·원본 모두 목록 API만 사용
  - develop-ai: backend_api.py 변경 없음. RAG(faq_index·faq_runtime 기동 시 GPU 검증 제거) 변경 — app/rag 사본은 옛판·최신판 모두와 다름(RAG 연결 때 기준판 결정 필요)
- 사용자 결정: 접수(결과 전송) 이후에는 수정하지 않는다
- 수정: ConversationState.order_submitted(결과 전송 시작 때 켬). 이후 record_fields는 rejected ORDER_SUBMITTED, 택배 수정 의도는 다시 열지 않고 {"order": "submitted"}. 정책 `[results].submitted`(바꿨다·담았다고 말하지 않고 담당자 확인 후 연락 안내)
- 테스트 461 passed(+2: 전송 후 값 기록 거절, 전송 시 잠금·수정 의도 미개방)

## 2026-11-03 — 붙여 쓴 한글 길 번호 재조회("인동구길")

- 원인: 통화 93f3d9에서 Live가 "인동구길 7-3"(9를 한글로 붙여 씀)을 넘김. 보정기는 한글 숫자를 "로" 뒤에서만 떼어 "인동구"를 찾다 not_found. 주소DB는 정상(띄운 "인동 구길"은 확정)
- develop-ai 확인(미적용): ai/app/address/corrector.py는 address_resolver와 동일. 유사 표기 재시도 unlink_gil("인동 국일"→"인동 구길")은 이미 있음 — 붙여 쓴 경우는 처리 안 함. place_score(PIN 유사 주소)도 이미 backend_client에 있음
- 수정: app/integrations/address.py split_gil — not_found일 때만 "한글숫자+(번)길"을 띄워 한 번 더 보정(보정기 원본 무수정). 실제 DB: "경북 구미 인동구길 7-3" → 경상북도 구미시 인동9길 7-3 확정, 없는 길은 not_found 유지
- 사용자 결정: 기동 시 RAG·리랭커 확인 안 함(현재 사본 이미 그러함), develop-ai 두 판정 방식 미적용
- 테스트 462 passed(+1)

## 2026-11-03 — RAG 연결(원본 RagService, 기동 확인 없음)

- app/main.py build_rag: 원본 develop-ai main.py lifespan 조립 순서 그대로(FAQ 알림 저장소[receive_enabled] → 관리 색인·처리기[process_enabled] → RagService). 원본 RAG 코드 무수정
  - 원본과 다른 점: 관리 색인 준비 실패(Qdrant 장애 등)로 서버가 못 뜨지 않게 그 기능만 끈다. 기동 때 리랭커 확인 없음(사용자 지시). RagService.warmup(Qdrant 문서 적재·BM25 준비)은 원본처럼 백그라운드 — 리랭커는 부르지 않고 실패해도 기동 무관
  - FAQ 웹훅 라우터(/internal/faqs/refresh) 포함, 종료 시 RagService·관리 색인 닫기
- CallDeps.rag·rag_min_score·rag_budget_sec([rag] 설정) → ToolContext → search_manual
- 검증: rebuild Qdrant가 비어 있어 원본 scripts/index_markdown.py로 manuals_dev_openai_large 색인(FAQ 32개). 실제 warmup 2.84s ready. 로컬 서버 기동 OK(healthz 200, FAQ 웹훅 401). 검색은 리랭커(GCP GPU VM) ConnectTimeout — VM 자동 중지 상태로 추정, 끝까지 검증 못 함
- docs/ops/live-test.md: Qdrant·색인·리랭커 VM 켜기 절차
- 테스트 463 passed(+1: Qdrant 키 없이도 기동, RagService·FAQ 라우트 연결)

## 2026-11-03 — 페르소나 다음 통화 적용, 컨테이너 이미지를 새 서버로

- 계약: spec/ai-integration-current.md §7, origin/develop-backend backend/docs/ai-persona-next-call.md(17d86ce). 원본 develop-ai ai/app/persona.py·webhooks/persona.py 동작을 옮김
- 신규 app/calls/persona.py(PersonaManager): 알림·새 통화 진입이 같은 잠금 → PENDING 조회·검증 → APPLIED/FAILED(errorCode) 회신 → 응답 ACTIVE·버전·applicationId 확인 → 새 통화 기본값 교체. activeCallCount 대기 없음, 409는 재조회, 회신 유실은 unresolved(새 통화 503 거절)
  - 원본과 다른 점(P2): ACTIVE 없음·쓸 수 없음은 거절하지 않고 서버 기본 프롬프트(버전 null). turnWaitLevel null은 AI 기본(NORMAL)으로 허용
  - 진입 확인 예산 persona_budget_sec(1.0s) — 고객 확인(stage1)과 병렬, 넘으면 마지막 ACTIVE
- 신규 app/webhooks/persona.py: GET /internal/persona/options(직접 JSON), POST /internal/persona/refresh(202, 힌트 검증만). Bearer AI_PERSONA_TOKEN
- service: PersonaCache 제거, 통화마다 버전 고정(분석 aiPersonaVersionSeq), voiceId → session audio.output.voice. main: 기동 때 persona.run()(재시작 복구)
- config [call]: persona_cache_sec 제거, persona_retry_sec·persona_report_attempts·persona_max_prompt_chars
- Dockerfile CMD → app.main:app(스파이크 제외), /app/logs/calls. compose: BACKEND_MODEL(없으면 SPIKE_BACKEND_MODEL)·BACKEND_EFFORT·LOG_LEVEL, 스파이크 변수 제거, ./logs:/app/logs. .env.example 갱신
- 검증: 컨테이너 재빌드·기동 healthy(주소DB·가짜 BE·Qdrant 준비·Decision 웜업), /internal/persona/options 401/200, refresh 202, /monitor 401(인증)
- 테스트 470 passed(+7 test_persona: PENDING 즉시 적용, 잘못된 설정 FAILED·ACTIVE 유지, 회신 유실 시 거절 후 재확인, ACTIVE 없음 → 기본, 검증, 통화 버전·음성 고정, 웹훅 인증)

## 2026-11-03 — 확인 대기 중 "접수해 주세요"(proceed), 진행 안내 검사, Decision 응답 시간, 이름 말끝 정리

- 원인(통화 512a1b): 되읽기 → 문의(RAG 3번) 뒤 고객 "그럼 접수해 주세요"가 확인 질문의 답이 아니어서(G3) not_answer·한 번은 DECISION_TIMEOUT. 서버가 다시 묻게 하지 않았고 Live는 "접수 진행하겠습니다"만 반복 → 확정 없이 종료(INCOMPLETE NO_CONFIRMED_PARCEL). 단계(readback)는 정상
- (a) Decision confirm 선택지 proceed(질문 없이 진행 요청). 확정하지 않고 N2 {"confirmation":"ask_again","readback":…} → Live가 되읽고 "이대로 접수할까요?" → 그 답(yes)만 기존 관문으로 확정. G3 유지
- (b) 정책: [results].confirmation, [forbid] 확인 없이 진행 안내 금지. [[forbid.claims]] "진행하겠·진행할게·진행 요청 확인…"(unless=no_pending, use_skip=false — 미래형이라 claim_skip 미적용). truth에 awaiting_confirmation
- (c) Decision: 응답 시간 ms를 사건에 기록, 통계에 P50·P95. 시간 초과는 늦은 답을 쓰지 않고 실제 도착 시간만 "Decision 늦은 응답"으로(추가 호출 없음), 입력 글자 수 기록
- 이름: record_fields가 *_name 말끝(입니다·이니다·이에요·이요·예요·요·라고 합니다) 제거. "이…" 말끝은 앞 글자 받침이 있을 때만(박소이요 → 박소이), 남는 이름 2글자 이상일 때만
- 테스트 473 passed(+3: proceed → 다시 묻기 → yes 확정, 진행 안내 검사, 이름 정리)

## 2026-11-03 — 통화 중 끊김(무발화 타이머) 수정, 지연 로그 분석

- 원인(통화 363d19): 무발화 타이머(silence_sec 30)가 고객 입력 delta에만 다시 걸려, 고객 마지막 말(144.3s) 뒤 AI가 긴 되읽기를 하는 동안 174.9s에 마무리 → 끊김(close_requested). 스파이크의 통화 길이 제한(SPIKE_MAX_CALL_SEC)은 새 서버에 없음. 세션 만료 타이머는 GPT-Live expires_at 기준(이번 원인 아님)
- 수정: AI 출력 delta에도 무발화 타이머를 다시 건다(고객·AI 모두 조용할 때만 30초)
- 지연 분석(최근 5통화): 위임→함수 P50 ~1.0–1.1s, 도구 P50 0.15–0.4s, 재개→AI 발화 P50 1.5–2.4s — 이전과 같은 수준. P95 증가 원인: search_manual 5.8s(리랭커 VM 꺼짐 → 연결 시간 초과 5s 후 KB_UNAVAILABLE), 한 위임에 도구 2개 연속(record_fields → search_manual). Decision P50 333ms·P95 831ms(16건, 시간 초과 2)
- 별건(통화 98b348): Live가 "도림로143길 27, 리버뷰 신안 인스빌"(건물명 포함)을 넘겨 ADDRESS_NOT_FOUND. 도로명만이면 확정 — 미수정(보고)
- 테스트 474 passed(+1: AI가 말하는 동안 무발화로 끊지 않음)

## 2026-11-03 — 주소 재조회: 쉼표 뒤 건물 이름 떼기

- 통화 98b348: "도림로143길 27, 리버뷰 신안 인스빌" ADDRESS_NOT_FOUND. app/integrations/address.py retries(): 못 찾았을 때만 ① 붙인 한글 길 번호 띄우기 ② 쉼표 앞(도로명·건물번호)만 ③ ②에 ① — 찾으면 멈춤. 보정기 원본 무수정
- 실제 DB: 위 주소 → 서울특별시 영등포구 도림로143길 27 확정, 없는 길은 not_found 유지. 떼어 낸 건물 이름은 기록하지 않는다(상세주소는 따로 받음)
- 리랭커 장애 시 빠른 실패(제안 1)는 사용자 결정으로 하지 않음
- 테스트 475 passed(+1)

## 2026-11-03 — develop-ai 반영 준비(원본 Jenkinsfile 기준, 이전 서버는 ai/old)

- 원본 ai/Jenkinsfile·ai/deploy/(upload.sh·deploy.sh·compose.deploy.yaml·apply-faq-runtime.py·gcp/·known_hosts)를 그대로 가져옴(수정은 compose.deploy.yaml 로그 볼륨만)
- 배포 호환: compose BACKEND_MOCK 기본 false·BACKEND_API_URL/PBX_WEBHOOK_SECRET 필수·BACKEND_MODEL 기본 gpt-6-luna·config/prompts 마운트, /health 추가, .dockerignore에 old·deploy·Jenkinsfile, compose.deploy.yaml에 ai_logs 볼륨, tests/test_faq_deploy_runtime.py(원본) 추가
- docs/ops/deploy.md
- 테스트 482 passed
- 반영 브랜치: 원본 저장소 worktree S15P31D109-rebuild, feature/ai-rebuild(origin/develop-ai df93338 기준). 기존 ai/ 파일은 git mv로 ai/old/, Jenkinsfile·deploy/는 제자리. push·MR 안 함

## 2026-11-03 — 스파이크 정리, 운영 .env(Jenkins credential) 준비

- spikes/ 코드 삭제(server·analyze·replay·테스트·README). 측정 기록은 docs/spikes/s0-RESULTS.md·s0c-RESULTS.md로 이동, decisions.md·test-strategy.md·monitor.md·docker.md·live-test.md 참조 갱신
- SPIKE_* 제거: .env·.env.example, app/main.py·compose의 SPIKE_BACKEND_MODEL/EFFORT 대체, .dockerignore spikes 줄. 로컬에 남은 spikes/*/logs(통화 기록, 미추적)는 지우지 않음
- 운영용 .env.deploy(커밋 안 함, .gitignore .env.*): 리빌드 .env 비밀값 그대로 + BACKEND_MOCK=false, BACKEND_MODEL/EFFORT·LOG_LEVEL·MONITOR_RETAIN_ENDED_SEC, AI_PORT 비움, AI_IMAGE·ADDRESS_DATA_DIR·QDRANT_URL·로컬 경로 키 제외. 배포 compose(--project-name dva-ai + compose.deploy.yaml) config 통과
- 리빌드 .env 비밀값은 원본 로컬 ai/.env와 키별로 모두 같음(값 비교만, 출력 안 함). Jenkins dva-ai credential 현재값과의 대조는 못 함
- 반영 브랜치 이름 refactor/ai-rebuild로 변경
- 테스트 482 passed

## 2026-11-04 — develop-ai 잘못 반영 되돌림, refactor/ai-rebuild 재구성·push

- 사고: 반영 브랜치를 `worktree add -b … origin/develop-ai`로 만들어 upstream이 develop-ai로 잡힘 → 2026-11-03 22:23:18 push로 develop-ai가 e76fbe1(리빌드)로 갱신. 원인은 추적 브랜치를 끊지 않은 것(--no-track 미사용)
- 조치: revert 커밋 ae2745d(트리 = df93338) → develop-ai push. refactor/ai-rebuild는 ae2745d 위에 revert의 revert 72a32ef(트리 = e76fbe1)로 재구성 → push, MR !210 → 65756aa로 머지

## 2026-11-04 — 상담원이 먼저 인사

- 원인: 첫 인사를 지시문(default_prompt "고객이 말하기 전에 먼저 인사")에만 맡김 → 최근 6통화 중 4건은 고객 "여보세요" 뒤에 인사. 원본 서버도 서버 신호 없음
- 수정: LiveFlow.on_started — session.started 때 AI가 아직 말하지 않았고 고객도 말하지 않았으면 N2(commentary) {"call_started": true}. 정책 [results].call_started("바로 첫 인사, 한 번만")
- 테스트 483 passed(+1). 실통화 미확인(이중 인사 여부)

## 2026-11-04 — 지시문 파일 분리(페르소나만 BE), 등록 출발지 인사, 매뉴얼 연속 미답변 → 상담원 권유

계획: docs/architecture/prompt-layout-plan.md v5 단계 2·3(계약과 무관한 부분). 합의 계약: docs/be-requests/2026-11-04-pickup-callback-handoff-pins.md
- 프롬프트 분리: policy/persona_default.md(페르소나, BE promptText 없을 때) · policy/business_rules.md(업무 규칙, "페르소나보다 우선") · policy/backend_rules.md(Backend 지시문 + 번호 부분 정정 d). policy/default_prompt.md 삭제
- render_live: 페르소나 → 업무 규칙 → 정책 절차(workflow.toml 렌더) → 통화 정보. "충돌 시 페르소나 우선" 문장 삭제. render_backend는 파일 읽기
- 제시 프롬프트 반영 시 고친 문장: 진행 상태 → 서버 결과, 확인 답 위임 삭제(b), 번호 확인은 phones_to_read(c), 부분 정정(d), 상담원은 "담당자가 확인 후 연락"(전환 없음), 검색 결과는 한 번에 근거 최대 3개, 마무리 멘트 고정. 주소 맞장구(i)는 페르소나, "주소를 다시 말하지 않음" 삭제
- f: Customer.origin_address(고객 기본 주소, 없으면 최근 출발지 도로명) → 등록 고객 통화 정보 "등록된 출발지"(상세주소 제외)
- h: search_manual 연속 미답변 3회(config [call].unanswered_agent_after) → 도구 결과 facts.agent="suggest", 답이 나오면 0. shortcut: 질문 동일성은 보지 않음. [results].agent에 suggest 뜻 추가
- 보류(계약 대조 후): a 수거 일시(규칙 파일은 현재 서버 동작 유지), e 이관 요청 전송, g 주소록 갱신
- 테스트 486 passed(+3: 지시문 순서·우선순위·기본 페르소나, 규칙 파일의 결과 키, 등록 출발지, 연속 미답변)

## 2026-11-04 — 접수 시점 문구 정정

- 업무 규칙(사용자): 접수(결과 전송)는 더 보낼 택배가 없다고 확인되면 한다. 그 전까지 담은 택배는 세션에 보관하고 고칠 수 있다
- 어긋난 문구 수정: workflow.toml [results].parcel_added, claims.py truth.submit_when("통화를 마칠 때" → "더 보낼 택배가 없다고 확인되면"). 코드 동작(_maybe_submit)은 그대로
- 테스트 486 passed

## 2026-11-04 — 관제: 지연 시간 표·백엔드 통신 내역, 확정 경로 계획

- 관제 기록: app/observability/trace.py current_call(통화 태스크 ContextVar)·observe_backend → BackendGateway._once가 BE 호출마다 op·결과·HTTP·오류·ms를 지금 통화에 기록(세마포어 대기 포함, 통화 밖 호출은 버림). 페르소나 동기화는 게이트웨이를 거치지 않아 "페르소나 확인" 지연으로만 보임
- 지연 구간(CallSession.timings, 구간별 최근 200개): 통화 준비(accept 전)·페르소나 확인·고객 확인(1단계)·accept·연결→첫 AI 발화·고객 말 끝→AI 말 시작·Decision(시간 초과분)·위임→도구 호출·도구 <이름>·재개→AI 발화·N2 대기(AI 발화 끝)·N2→AI 발화·확인 '네'→담기·BE <op>
- 스냅샷 latency(구간·횟수·최근·P50·P95·최대)·backend_calls(최근 100), monitor/static/index.html "지연(ms)"·"백엔드 통신" 칸
- 계획: docs/architecture/confirm-path-plan.md(실측 8.1s 분해, P1~P6, 목표 P50 ≤ 3s, 기준 측정 먼저)
- 테스트 487 passed(+1 게이트웨이 기록, 끝-끝 테스트에 지연 표·BE 통신 확인)

## 2026-11-04 — 수거 요청 시각(업무 규칙 a, BE 계약 feature/ai-call-updates)

- app/domain/pickup.py: 기본 = 지금 + 60분(10분 올림), 09시 전 → 당일 09:00, 17시 초과 → 익일 09:00(today_unavailable). 조정 검증 PICKUP_TOO_SOON·PICKUP_OUT_OF_HOURS(17:00 정각 허용)·PICKUP_TOO_FAR(3일, 임시). 주말·공휴일 구분 없음
- workflow.toml [pickup] open·close·max_days_ahead·next_day_default, [speech].pickup·[results].pickup 문장, Policy.Pickup 필드
- record_fields.pickup_at(ISO 8601 + 시간대): parse_pickup → check_pickup, 거절이면 needs + facts.pickup.allowed. 되읽기 개방 때 수거 시각이 없으면 기본값을 Source.SERVER로 기록하고 facts.pickup{at,today_unavailable,allowed}
- Outcome.pickup_at = 기록된 수거 시각 → 결과 본문 pickupRequestedAt(BE가 보존, 늦은 결제는 BE가 결제+1시간을 09~17시로 맞춤)
- Backend 지시문 끝에 현재 시각(한국) — "내일 10시"를 날짜로 바꾸기 위해. business_rules.md 수거 절, backend_rules.md pickup_at 규칙
- 테스트 489 passed(+2, 본문 pickupRequestedAt 단정 갱신)

## 2026-11-04 — 상담원 연결: 근무 시간 밖 콜백(hasCallbackRequest)·통화 전환 열어 둠(업무 규칙 e)

- 사용자 결정: 통화 전환 기능은 열어 두고, 근무 시간 밖이라 이관 불가 + 고객 동의 시 hasCallbackRequest=true
- LiveFlow._agent_route(용건 agent): hasHandoffRequest(agent_transferred) 기록 → 근무 시간 밖(config [call] agent_open·agent_close·agent_days, 임시 평일 09~18시) → N2 callback_offer + Decision 질문 callback(제안 중에만) → yes면 callback_requested(N2 callback_registered), no면 callback_declined. 근무 시간 안 + agent_transfer_uri → N2 transferring → 안내가 끝나면 live.sessions.refer(실패 → transfer_failed + 콜백 제안). URI 비어 있음(지금) → not_configured
- 분석 hasCallbackRequest: BE 계약(feature/ai-call-updates)은 별도 API 없이 최종 분석 필드. 048 + 새 BE 전에는 구버전이 400 → config [backend].analysis_callback_field=false(배포 후 true)
- workflow.toml [[decision.callback.questions]]·[results].agent 상태별 문구, business_rules.md 상담원 절
- 테스트 492 passed(+3)

## 2026-11-04 — 되읽기 때 주소 저장 동의 → 고객 기본 주소·주소록 저장(업무 규칙 g)

- 사용자 결정: 주소 저장 동의는 되읽기 확인 때 함께. BE 계약(feature/ai-call-updates): 고객 동의 후에만, 기본 주소 PATCH는 진행 중 통화 + call_session_seq 헤더, PIN 추가는 종료 후도 가능, 주문 저장은 자동 갱신 안 함
- app/domain/address_book.save_offer: 등록 고객 + 확정 주소(geo) 기준 — 보내는 곳이 기본 주소와 다르면 sender, 받는 곳이 주소록·이력·기업에서 고른 곳이 아니면 receiver. shortcut: 고른 PIN을 고친 경우는 새 PIN 추가(PIN 번호 미보유)
- record_fields 되읽기 개방 때 facts.address_save + state.address_offer. Decision 질문 save(제안 중·답 전만). 동의 yes + 택배 담김(commit) → ResultService.save_addresses(백그라운드): update_customer_address(PATCH /api/customers/{id}, call_session_seq 헤더) · create_pin(receiver). 거절이면 제안 버림. 실패는 관측만
- BackendAPI.update_customer_address, MockBackend 흉내. Customer.default_address(고객 확인 default_origin)
- workflow.toml [[decision.save.questions]]·[results].address_save, business_rules.md 문장
- 미등록 고객은 기존 등록 절차(고객 등록 + 보내는 곳 PIN)를 그대로 둠
- 테스트 495 passed(+3)

## 2026-11-04 — 택배 정보 없는 통화의 빈 주문 방지(계획 customer-scenario-plan.md §3)

- 원인(운영 통화 3a0b9c7f): 담은 택배·받던 값이 없는데 결제 가능 방식이 하나라 paymentMethodType=billing이 자동으로 들어감 → BE가 주문 정보로 보고 COLLECTING orderSeq 59 생성(BE 규칙: parcels 없고 paymentMethodType·pickupRequestedAt·totalAmount 미수집이어야 NO_ORDER)
- decide_outcome: 담은 택배도 받던 값도 없으면 결제 방식을 넣지 않음(수거 시각은 원래 이 경로에 없음) → BE NO_ORDER
- 가짜 BE: 같은 조건이면 NO_ORDER(orderSeq null)로 흉내
- 운영 orderSeq 59는 AI가 지우지 않음(BE 확인 필요)
- 테스트 496 passed(+1 운영 통화 재현)

## 2026-11-04 — 인사 질문에 동의 → 접수 시작, 접수 시작 알림에 빠진 항목(계획 §2)

- 원인(운영 통화 3a0b9c7f): 인사 "택배 접수 도와드릴까요?"에 "예" → task=chit_chat, "아뇨 아뇨 해주세요" → order 0.28(기준 미달). 접수가 정해질 때 알림이 {"intent":"order"}뿐 → Live가 "어떤 택배 보내실 건가요?"(순서 밖)
- workflow.toml task: "직전 AI 발화가 접수를 도와드릴지 물었고 동의·진행을 바라면 order", "상담원 연결을 권했고 동의하면 agent". switch에도 agent 동의
- _on_intent: order면 알림에 summary(state_summary: stage·missing·fields) — missing 첫 항목이 다음 질문
- 실제 Decision API 확인(gpt-6-luna): "예" → order 0.93, "아뇨 아뇨 해주세요" → order 1.00, "아니요 그냥 물어볼 게" → inquiry 0.78, 상담원 권유 뒤 "네" → agent 1.00
- 테스트 497 passed(+1 알림에 missing 첫 항목 sender_name)

## 2026-11-04 — 기존 고객 보내는 분 미리 채우기(계획 §1)

- 출발지 후보 Customer.origin_place: 1단계 default_origin(고객 기본 주소, PROFILE) — 인사 "○○님, {출발지}에서 보내시는 택배 접수 도와드릴까요?"로 묻는 것으로 봄(origin_offered). 없으면 2단계 recent_origin(이전 접수 출발지, HISTORY) — 접수 시작 알림에 origin_confirm("{주소}에서 보내시나요?")
- Decision 질문 origin(제안 뒤 답 전만). 같은 발화의 용건보다 먼저 처리("예" = 접수 + 그 출발지)
- prefill_sender(app/domain/address_book.py): yes → 보내는 분 성함·주소(+geo)·상세를 Source.PROFILE로(고객이 말한 값은 덮지 않음), no → 성함만. 후보 없는 등록 고객은 성함만. 접수 알림 origin=prefilled|name_only + summary(missing 첫 항목 = 받는 분 성함/보내는 곳 주소)
- 되읽기: 저장된 상세주소(PROFILE)는 기존 읽기 규칙대로 넣지 않음. 기본 주소와 같은 출발지는 저장 제안 없음
- task 기준에 "출발지가 달라도 보내려는 것이면 order" 추가
- 실제 Decision API(gpt-6-luna): 인사 뒤 "예" → order 0.99·origin yes 1.00, "네 거기서요" → order·yes, "아니요 오늘은 회사에서 보내요" → order 0.98·origin no 0.72, "아니요 조회하려고요" → lookup·not_answer, 최근 출발지 질문 뒤 "네" → yes, "아뇨 다른 데요" → no 1.00. 부작용: "아니요 그냥 물어볼 게 있어서요" → inquiry 0.46(기준 미달, 접수로 오판하지는 않음)
- 테스트 499 passed(+2)

## 2026-11-04 등록 고객 성함을 처음부터 채움
- 원인(운영 통화 d62b7162): 보내는 분 성함은 출발지 답이 확정된 뒤 `_origin_step`→`prefill_sender`에서만 채워졌다. 인사 뒤 "아니요, 다른 데서 보낼게요"가 origin=no 0.52(기준 미달)로 버려져 채우기가 실행되지 않았고, Live가 성함을 다시 물어 고객이 "저고요"라고 답한 뒤에야 기록됐다(등록 정보로 들어간 것 아님)
- 수정: `ConversationState.field_of`에서 택배 초안을 만들 때 발신번호와 같은 자리에서 등록 고객 성함(customer_seq·name 있을 때)을 Source.CALLER_ID로 채운다 — 출발지 질문과 무관. CALLER_ID라 빈 택배 판정(empty)·시도 횟수에서 빠지고(빈 주문 방지 유지), 되읽기에서는 성함을 읽는다(번호·저장 상세주소만 제외). 고객이 다른 이름을 말하면 record로 덮는다
- 출발지 질문 축소(계획 2번)는 적용하지 않음(사용자 결정: 1·3·4만). prefill_sender의 성함 처리는 이미 VALID라 건너뛴다
- 테스트: 기대값 3곳(성함 출처 CALLER_ID, missing 첫 항목 sender_address) 수정 + 새 테스트 2개(출발지 답 없이도 채움·빈 택배·되읽기·정정·다음 택배 / 미등록은 비움). 501 passed

## 2026-11-04 — S15P31D109-159 통화 종료 후 실제 미답변 검토 초안

- 브랜치: feature/S15P31D109-159-unanswered-reporting, 기준 develop-ai f34343f. 기존 RAG 검색·임베딩·BM25·RRF·리랭커·Live 도구는 변경하지 않음.
- 기존 ResultService는 search_manual.facts.answerable만으로 미답변과 faqAnswerCount를 계산했음. 검색 성공 후 Live가 안내하지 못한 경우·실패 후 재검색으로 해결한 경우를 구분하기 위해 종료 후 전사 전체를 검토하는 선택적 경로 추가.
- app/calls/unanswered.py + prompts/unanswered_review.md: Responses 구조화 출력으로 문의별 ANSWERED/UNANSWERED/CLARIFICATION/UNKNOWN 판정. 고객 원문·AI 직접 인용·검색 참조·시각·전체 검색 포함 여부 검증. 같은 문의 반복 검색은 한 항목에 묶음. 사유는 모델이 쓰지 않고 마지막 연결 검색 상태로 KB_NO_ANSWER/KB_UNAVAILABLE 결정. 모델 장애를 KB_UNAVAILABLE로 오인하지 않음.
- Outbox review_jobs: 원본 입력을 먼저 저장하고 판정·전송 예정 본문을 원자적으로 확정. 확정 후 재판정하지 않음. 발생 ID는 고객 발화 위치+질문 원문 해시로 고정하며 고객 질문 시각을 사용.
- 종료 훅은 저장 후 서비스 소유 작업을 시작하고 반환. Live 보고 도구나 통화 중 추가 추론 없음. 재시작·전송 응답 유실 시 동일 본문 재전송. 실행 중 주기적 복구와 판정 재시도 상한 추가.
- 사용자 확인: 백엔드 reason 필드 추가 예정. 현 계약은 여전히 추가 필드 거절. docs/contracts/unanswered-reason-proposal.md에 전달안·확인 항목 분리. 운영 전송은 reason_contract_enabled 게이트로 보호하고 [unanswered_review].enabled도 기본 false. .env·운영 서버·배포 설정은 수정하지 않음.
- 한계: 실제 모델 의미 판정은 아직 미평가. 검토 FAILED 시 그 통화 이벤트·분석은 보류(주문/통화 결과 전송 유지). 전사 300행 도달·입력 한도 초과는 판정 오류로 보존. 단일 프로세스 소비자 전제. 운영 활성화 전 계약·실모델 검증·보류 건 처리 절차 필요.
- 테스트: 신규 20개 포함 전체 **521 passed, 1 warning / 19.63초**. 가짜 모델·백엔드만 사용. 기존 langchain-community deprecation 경고 1건. git diff --check 통과.
- 테스트 환경 문제: 제한 환경의 Windows asyncio socketpair 생성에서 정지. faulthandler로 socket.accept 위치 확인 후 멈춘 테스트를 종료하고 같은 테스트를 제한 밖에서 실행하여 통과. 구현 오류로 단정해 asyncio 코드를 바꾸지 않음.
- 커밋·푸시·병합·실제 API/전화 호출은 아직 수행하지 않음. 구현 계획·인계·한계는 docs/architecture/unanswered-reporting.md 참고.

## 2026-11-04 — S15P31D109-159 백엔드 reason 병합 계약 확인

- 사용자 안내에 따라 origin/develop-backend만 fetch하여 277cf1c → fbbaca1 갱신. feature/unanswered-reasons(e0a0658) 병합 확인. 현재 AI 작업 브랜치·미커밋 구현·output/tmp는 유지하고 백엔드 브랜치 자체를 병합하지 않음.
- docs/api/unanswered-questions.md·backend/docs/unanswered-question-reasons.md와 실제 DTO·저장·해시 코드를 대조함. 기존 6필드는 필수, reason은 선택이며 KB_NO_ANSWER/KB_UNAVAILABLE/null 허용. 생략/null은 미분류. 명시한 사유 변경·삭제는 동일 eventId 재전송에서 409, 과거 미분류 사후 분류 불가. 기존 AI 본문과 일치하여 전송 코드 변경 불필요.
- 관리자 목록 reason 및 통화 처리 결과 unansweredReason 제공. QUESTION_UNANSWERED 이벤트 입력에 사유를 복사하지 않고 기존 질문 번호 연결 유지. UNCLASSIFIED는 조회 전용.
- AI 계약 스냅샷 2개와 출처 README, 설계·인계 문서 갱신. 가짜 HTTP 계약 테스트 4개(두 코드/null/생략, 201→200, 인증·경로·동일 바이트 재전송) 추가. 관련 테스트 **60 passed / 1.32초**, git diff --check 통과. 실제 백엔드/모델/DB 호출은 하지 않음.
- 코드 병합과 운영 적용은 구분: 백엔드 자체 작업 기록에도 실제 운영 DB·배포는 미실행으로 명시됨. DB 백업 → migration 049 적용 → 새 BE 배포 → 실제 모델 검증·AI 활성화 순서를 유지. 두 활성화 플래그는 false 그대로이며 커밋·푸시·배포는 하지 않음.

## 2026-11-04 — S15P31D109-159 백엔드 배포 확인 및 실모델 사전 검증

- 사용자가 백엔드 배포 완료를 확인함. 운영 DB·수집 API를 AI가 직접 검사한 것은 아님. 현재 AI 브랜치는 그대로 유지.
- scripts/check_unanswered_review.py 추가: 개인정보 없는 가상 전사·검색 상태로 실제 종료 판정 모델만 호출한다. 백엔드·전화·RAG 요청은 하지 않으며 각 판정·기대값·시간을 JSON에 남김. 오류도 실패로 명시하며 인증 정보가 포함될 수 있는 예외 본문은 기록하지 않음.
- 최초 uv run은 기존 lock에 따라 환경 패키지를 동기화한 뒤 BACKEND_MODEL 미설정으로 API 호출 전에 종료. 의존성 명세·lock은 변경 없음. 이후 --no-sync와 현재 compose 기본 모델 --model gpt-6-luna를 명시함.
- 실제 OpenAI 가상 통화 **8/8 통과**: 검색 성공 후 미답변, 검색 장애, 부정형 정상 답변, 장애 후 해결, 확인 중 이후 해결, 명확화, 확인 중만 남은 경우, 두 문의 혼재. 인용·분류 결과도 확인함. 작은 사전 검증이며 전체 실통화 정확도의 증명은 아님.
- 판정 시간 2.181~4.468초, 평균 3.026초. 통화 종료 후 처리이며 통화 중 응답 지연과 구분. 결과 output/unanswered-review/backend-deployed-20261104.json에 저장(개인정보 없는 가상 데이터).
- config/server.toml의 enabled·reason_contract_enabled를 true로 준비. 클래스 기본 false는 유지하며 구버전 환경은 꺼야 함. AI 코드·설정을 실제 배포해야 운영에 반영됨. 운영 AI는 아직 배포하지 않았고 실제 관리자 미답변 수집 검증도 남아 있음.
- 전체 로컬 테스트 **525 passed, 14 warnings / 23.00초**. langsmith의 Python 3.14 asyncio deprecation 13건과 기존 langchain-community 1건. .env 원문 조회·수정 없음. 커밋·푸시·병합·운영 배포 없음.

## 2026-11-04 — S15P31D109-159 커밋·원격 브랜치 공유 준비

- 사용자 요청에 따라 종료 후 미답변 구현·프롬프트·설정·검증 스크립트·테스트·계약/설계/작업 기록을 Jira 159 기능 커밋으로 정리한다.
- 검증 근거는 전체 525개 테스트 통과와 실제 모델 가상 통화 8/8 통과. 이후 동작 코드 변경 없이 커밋 범위와 git diff --check를 확인했다.
- 기존 output/·tmp/ 및 개인 개발로그·인증 파일은 커밋 대상에서 제외한다. feature/S15P31D109-159-unanswered-reporting에 커밋 후 같은 원격 브랜치에 푸시한다. develop-ai 병합은 사용자가 직접 진행하며 이 작업에서는 병합·운영 배포를 하지 않는다.

## 2026-11-04 Backend 주소 기록 규칙 복원
- 원인(운영 통화 d62b7162): 리빌드 backend_rules.md에 주소 받아쓰기 규칙이 없었다. "신정이펜일로 오십삼백십이동 사백삼호" → "…53" / "12동 403호"로 잘못 나눠 ADDRESS_NOT_FOUND 3회 후 51로 오확정. 보정기(address_resolver)는 기존 서버와 같음
- 수정: 기존 서버 old/prompts/backend.md "값 기록 규칙"의 주소 항목 1~7을 policy/backend_rules.md로 옮김(들은 그대로 기록, 기본/상세 같은 호출에 분리·상세 없으면 "", 쉼 사이 숫자 합치지 않기·동/호는 상세, 길·건물번호·번지·호수만 숫자로·도로 이름 소리는 한글 그대로, 시·도/시·군·구 유지, 지역만이면 기록 안 함, 서버가 바로잡은 주소 다시 고치지 않기). 못 찾음 고정 문장(8)은 적용 안 함(사용자 결정)
- 실호출(gpt-6-luna, 대화 2줄만): 신정이펜일로 50/312동 403호, 인의동 565-3/아슬란 305호, 인동 9길 7-3/"", 영천구 목동로 212/3층, "서울로 보내요" 기록 안 함. 단 상태 없는 2줄 대화라 보내는 곳 질문에도 receiver_*로 넣음(실통화는 N1' 상태 요약이 단계를 줌 — 운영 통화로 확인 필요)
- 테스트 test_policy에 규칙 포함 확인 1줄. 501 passed

## 2026-11-04 — S15P31D109-159 MR 로그 충돌 해결

- develop-ai 최신 6fa05a0의 주소 기록 규칙 복원 및 관련 테스트를 기능 브랜치에 반영한다. develop-ai 자체의 병합은 사용자가 진행한다.
- 충돌은 docs/worklog.md의 파일 끝 기록 추가 1곳뿐. Jira159 개발·검증 기록과 팀원의 주소 규칙 복원 기록을 모두 보존했다. 코드 충돌은 없었으며 팀원 주소 지시문·테스트 변경도 그대로 유지한다.
- 기존 output/·tmp/와 개인 파일은 포함하지 않는다. 충돌 해소 후 전체 테스트와 충돌 표식·git diff --check를 검증하고 기능 브랜치에만 커밋·푸시한다.
- 검증 결과: 전체 **525 passed, 14 warnings / 19.55초**. 충돌 표식 없음, git diff --check 통과. 실제 모델·전화·백엔드 API는 호출하지 않았으며 운영 배포도 하지 않았다.

## 2026-11-04 주소는 들으면 바로 맡기기(C')
- 원인(운영 통화 8ffabaca): Live가 받는 곳 주소(46.7s)를 듣고 맡기지 않은 채 "주소는 이렇게 적었습니다"라고 말하고, 47초 뒤 물건 가격과 함께 맡김 → 주소 확인(ADDRESS_NOT_FOUND)이 늦게 드러남
- 수정: business_rules.md 주소 듣기에 "주소를 말하면 다른 정보를 더 모으지 말고 바로 맡긴다(확인하는 동안 대화 계속)", "서버 결과 전에는 따라 말하기만, 적었다·기록했다·저장했다고 말하지 않는다" 추가. 문구 검사(forbid.claims)는 정상 안내("총 천 원으로 기록했습니다")까지 걸려 넣지 않음
- 테스트 test_policy 1줄. 501 passed. 실통화 확인 필요

- Jira159 MR 추가 충돌 처리: 이전 해결 후 develop-ai가 6fa05a0 → 5c2bbec로 갱신되며 위 기록 5줄이 추가됐다. 이번 변경은 worklog.md만이므로 양쪽 기록을 모두 보존하고 충돌 표식·git diff --check를 확인했다. 동작 코드·테스트 파일 변화가 없어 이전 525개 테스트 결과를 유지하며 반복 실행하지 않았다. 기능 브랜치만 갱신하고 MR 최종 병합은 사용자에게 남긴다.

## 2026-11-05 주소 보정 교체 0단계 — 회귀 시험지·기준선
- 목적: address_resolver(구 서버 보정기) 교체 전 기준점. 코드 변경 없음
- 추가: evaluation/datasets/address_v1.json(105문항: 표준 20·도로명 오인식 12·지역 변형 11·한글 숫자 10·길 번호 12·도로명 안 숫자 5·다시 6·말끝 6·덧붙인 건물명 4·지번 11·없는 주소 8). 정답은 고객이 뜻한 주소(보정기 출력 아님), 실제 주소DB에 있는지 스크립트가 먼저 확인. 출처: 기존 테스트, worklog 운영 통화(93f3d9·98b348·8ffabaca·d62b7162), 신규
- 추가: scripts/evaluate_address.py — 서버 경로 그대로 AddressService.resolve(보정+재시도), 카카오는 끔. 결과 evaluation/results/address_v1_baseline.json
- 기준선(실제 data/address.db): 정답 있는 97문항 중 정답 기록 85(확정 83·애매→1순위 정답 2), 틀린 기록 0, 못 찾음 12. 없는 주소 8문항 중 못 찾음 7, 틀린 기록 1
- 못 찾음 12: 숫자 사이 붙은 '다시' 3, 말끝(요·이요·입니다) 6, 쉼표 없는 건물명 2, 지번 "태평로 일가" 1
- 틀린 기록 1: "테헤란로 210"(없는 번호) → ambiguous 1순위 "테헤란로 510"이 P6로 기록됨
- 지연(보정만, 로컬): 첫 호출 P50 10ms·P95 115ms·최대 337ms, 반복 P50 9ms·P95 111ms·최대 432ms(역삼동 지번 3건이 300ms대). 105건 동시 2.31s ≈ 순차 합 2.40s → 전역 락으로 병렬 처리 안 됨 확인
- 한계: 시험지를 보정기의 알려진 약점을 보고 만들었으므로 독립 정확도가 아니라 회귀 기준이다. 말끝 사례가 실제로 얼마나 들어오는지는 현재 backend_rules.md 기준으로 미확인

## 2026-11-05 주소 보정 교체 1단계 — address_resolver를 app/address로(동작 동일)
- 목적: 구 서버 보정기를 현 서버 구조로 옮기고 구조 문제(전역 상태·전역 락·dict 결과·Geo 두 벌·의존 방향)만 정리. 점수·기준값·말 다듬기 로직은 그대로
- 이동(git mv): corrector.py → app/address/matcher.py(찾기·판정) + phonetic.py(소리 비교) + parse.py(말 다듬기·재시도 표기 — integrations의 split_gil·retries 포함), stt_preprocess.py → numbers.py, db.py → gazetteer.py, kakao.py → app/integrations/kakao.py, 테스트 → app/tests/test_address.py·address_sample_db.py·fixtures/roads_sample.csv. address_resolver/ 삭제
- 바뀐 구조: 결과는 Resolution(status, address, candidates) dataclass(쓰지 않던 "weak" 키 삭제). 전역 _db·load() → gazetteer.open_db()로 열어 AddressService(db)에 주입(main.py). 전역 threading.Lock 제거, SQLite 연결은 스레드마다. 재시도 루프는 matcher.resolve()로(순서 동일). kakao.geocode는 도메인 Geo를 돌려주고, BE 모양 Geo(pydantic)는 backend_client/order.py로. backend_client는 app.address.phonetic·parse를 씀
- 유지한 계약: AddressService.resolve() → AddressResult(status·address·alternatives·geo), 도구 결과 코드, P6, ADDRESS_DB·KAKAO_REST_API_KEY, data/address.db 스키마(재빌드 불필요)
- 검증: 전체 525 passed(이전과 같음). 시험지 address_v1 105문항 기준선과 사례별 상태·기록 주소·후보 차이 0(evaluation/results/address_v1_stage1.json). 빈 캐시 주소DB를 스레드 8개로 동시에 3회×210건 — 기준선과 차이 0
- 지연: 반복 P50 7.5ms·P95 103ms(기준선 8.8·111). 105건 동시 2.13s ≈ 순차 2.12s — 락을 없애도 GIL(순수 Python 편집거리) 때문에 병렬 이득 없음. 3단계에서 프로세스 풀 등 측정 후 결정
- 기타: Dockerfile COPY address_resolver, pyproject testpaths, README·concurrency.md·test-strategy.md·tool-contracts.md 갱신. Docker 이미지 빌드는 이번에 확인 안 함

## 2026-11-05 주소 보정 교체 2단계 — 못 찾았을 때 다시 볼 표기를 한곳에서
- 원칙: 들은 그대로 먼저 보고 찾으면 그대로 돌려준다(기존에 찾던 주소는 바뀌지 않는다). 못 찾았을 때만 다시 본다
- app/address/parse.readings(): 고침 5개(말끝 떼기·붙인 한글 길 번호 띄우기·쉼표/번호 뒤 건물명 떼기·숫자 사이 붙은 '다시' 띄우기·"일가"→"1가")의 조합을 적게 고친 것부터. 말끝 "이요"는 앞 글자 받침이 있으면 두 해석을 한 묶음으로 — 둘 다 실제 주소면 ambiguous(확정이 있으면 확정만 봄). 건물명 떼기는 번호 뒤가 '다시'면 자르지 않음(본번만 남아 다른 건물이 되는 것 방지 — 구현 중 발견)
- matcher.resolve(): 묶음 8개·1초 상한(넘으면 not_found — 예산 2.5초를 넘기면 "장애"로 들은 값이 기록되므로). integrations의 split_gil·retries 순차 재시도를 대체. 되돌려졌던 '다시'·'이요' 수정(5769438·7213a84)은 기본 해석을 바꾸지 않는 방식으로 다시 넣음
- 시험지 address_v1: 기준선에서 못 찾던 12건 모두 정답 확정, 나머지 93건 결과 동일. 고친 뒤 새로 쓴 holdout 16문항(정답 먼저 정함): 실제 주소 9/9 정답, 없는 주소 6/7 거부
- 남은 틀린 기록 2건(k05 "테헤란로 210", n05 "테헤란로 이백십요"): 없는 번호 → 번호를 고쳐 ambiguous → P6 1순위(510) 기록. 2단계 고침과 무관한 판정·P6 문제 — 사용자 결정 필요
- 지연(보정만): 반복 P50 9.7ms·P95 110ms·최대 561ms(없는 지번 "역삼동 99999" — 기본 경로)
- 테스트 528 passed(+3: 고침별 단위, 두 해석·붙인 '다시'·건물명·없는 주소, 시간 상한)

## 2026-11-05 주소: 건물번호를 고쳐야만 맞는 주소는 못 찾음(사용자 결정 B)
- 원인: 없는 번호("테헤란로 210")를 소리 거리로 510·203에 맞춰 ambiguous → P6 1순위(510) 기록. 사용자 결정: 번호를 고쳐야만 맞는 주소는 not_found(다시 물음). P6보다 정확도 우선
- 수정: app/address/matcher._correct — 실제 건물번호(지번)가 들은 번호와 같은(읽는 소리 기준, "07"=7) 주소만 후보. NUM_MAX·NUM_CONFIRM_MAX와 "많이 고친 뒤 번호까지 바꾼" 예외 분기 삭제(이 규칙이 포함). 길 번호·도로명 소리 보정은 그대로
- 시험지 121문항: 틀린 기록 2 → 0(k05·n05 not_found), 정답 기록 106 그대로. 남은 ambiguous 2건(b02 "대핸란로 212", f03 "신정 2-1로 50")은 후보 1개(도로명을 많이 고침)라 1순위 자동 확정 시 정답
- 영향: 고객이 부번을 빼고 말했거나("7-3"→"7") STT가 번호를 틀리게 받아써 없는 번호가 되면 이전처럼 비슷한 번호로 맞추지 않고 다시 묻는다(재질문 증가 가능, 실통화 확인 필요)
- 테스트 528 passed(기대값 2곳: "테헤란로 112"는 not_found, 도구 ambiguous 경로는 "대해남노 211"로)

## 2026-11-05 대시보드 이탈 단계·대기시간 전송(BE 계약 ai-dashboard-ai-integration.md)
- 계약: POST /api/ai/calls/{id}/stage-metrics·response-wait-metrics(신규, BE 배포 완료 — 설정 토글 없음). analysis 204 뒤에만, 두 항목은 서로 독립. 기존 analysis 본문은 그대로(새 값을 넣으면 400)
- 전송(app/calls/results.py): 통화 종료 때 두 본문을 analysis와 함께 한 번 계산해 insights 아웃박스에 저장(재전송은 같은 본문). 항목별 진행(done/failed) — 5xx·연결은 그 항목만 다시(행 PENDING), 409 충돌·422·400 등은 그 항목만 멈춤. 배포 전에 저장된 본문(키 없음)은 보내지 않음
- 이탈 단계(dropoff_stage): 끊긴 순간 진행 중이던 단계. 접수 sender/receiver/item/readback/payment → SENDER_INFO/RECIPIENT_INFO/ITEM_INFO/CONFIRMATION/PAYMENT_GUIDANCE, "더 보낼 것" 단계는 결제 선택이 남았으면 PAYMENT_GUIDANCE 아니면 NONE, closing → NONE. 접수 중 마지막 도구가 FAQ 검색이면 FAQ_ANSWER. 문의·조회는 결과가 나온 뒤 AI가 말했으면 NONE 아니면 FAQ_ANSWER/ORDER_LOOKUP, 취소는 완료면 NONE 아니면 ORDER_CANCEL. 시스템 종료(shutdown·expiring·연결 오류·accept 실패 등)·상담원 연결·업무 미정은 미판정(보내지 않음)
- 대기(totalWaitMs): 고객 말 끝 → AI 말 시작 구간 합계(CallSession.wait_ms, 구간이 순서대로라 겹침 없음). 고객 말 뒤 AI 말 없이 끝나면 끝나는 단계로 들어간 시각(ended_t)까지. 통화 시간으로 자르지 않음(422면 멈춤)
- 레이턴시(latencyStats): CallSession.measure로 통화 단위 합계·횟수. 고객 조회=caller_context 1·2·3, 정보 입력=record_fields, 주소 조회=주소 보정 1회(record._resolve)+find_destination, FAQ=search_manual, 접수 내역=lookup_orders, 취소=cancel_parcel, 접수 저장=결과 전송(submit). 실패·시간 초과도 셈. 측정 없는 유형은 뺌
- 한계: 대기는 서버가 전사 글자를 받은 시각 기준(실제 음성 재생 시각과 차이). 불편 판정(complaints)은 여전히 미판정(null)
- 테스트 550 passed(+22: 단계표·미판정·대기 합계·열린 구간·측정 없는 유형·analysis 뒤 전송·항목 독립·실패 항목만 재전송·배포 전 본문·API 경로·인증)
- 제외: policy/business_rules.md의 커밋 안 된 수정(다른 작업)은 건드리지 않음

## 2026-11-05 업무 규칙 문구 추가(policy/business_rules.md)
- 접수 확인: "접수 내용 확인 부탁드릴게요." 뒤 기록된 주문 내용을 말해 확인받음. 접수 완료는 서버 전송 성공 뒤에만 말함
- 무관한 요청: 1억 이상 같은 터무니없는 가격·택배와 무관한 요청은 처리하기 어렵다고 응대, 계속되면 안내 후 상담 종료
- 사용자가 작성한 수정을 요청에 따라 커밋(코드 변경 없음)

## 2026-11-05 — FAQ 응대 근거 배열 연동 구현

- 사용자 요청으로 구현 재개. Jira 번호 없이 진행하라는 지시에 따라 origin/develop-ai e5a9dee에서 feature/faq-answer-evidence 생성. 기존 로컬 develop-ai c296bfa·output/tmp 보존.
- 첨부 faq-question-examples-ai-integration.md를 계약으로 사용: 기존 events API, FAQ_ANSWERED 한 건에 faqEntrySeqs 배열, 질문/답변 UTTERANCE 참조. 추가 questionText·단건 필드·FAQ별 분리 이벤트를 보내지 않음. 원문 스냅샷은 docs/be-contract/backend에 보관(로컬 상대 링크만 수정).
- 현재 원격 develop-backend 0848174와 원격 FAQ 관련 브랜치들을 조회했지만 새 배열 DTO는 확인되지 않음. 첨부 계약대로 구현하되 [unanswered_review].faq_answered_enabled=false 기본/파일 설정을 유지. migration 052와 배열 지원 BE 배포 확인 후 true로 전환. 기존 미답변/사유 기능은 유지.
- Inquiry.used_evidence: 검색 번호·청크 ID·근거 직접 인용·답변 직접 인용 추가. 실제 전달 Top3, 관련 검색, 원문 인용, 답변 인용, backend-faq:N 양의 int32를 검증해 서버에서 FAQ 번호를 계산함. 모델이 번호만 만들어 내는 방식을 사용하지 않음. 근거 특정 불가이면 빈 배열 허용.
- 다중 질문이 같은 검색을 공유하도록 이전 전역 중복 금지를 조정하되 범위·개별 목록 중복·전체 검색 포함·발화 순서 검증은 유지. 한 질문/답변 발화 쌍은 FAQ 번호를 합쳐 이벤트 한 건, 별도 응대이면 같은 문장도 별도 이벤트. FAQ 청크가 여러 개여도 번호는 한 번만 전송. faqAnswerCount는 기존 문의 수이며 FAQ 수로 늘리지 않음.
- 빈 전사 행을 건너뛴 실제 UTTERANCE 순번으로 변환. 발화 화자·원문·20,000자 절단 범위를 확인. 실제 답변 기록 시각을 사용하고 검토/전송 시각으로 바꾸지 않음. 기존 발화 뒤에 이벤트를 배치해 발화 저장 선행 조건을 충족.
- v2 판정·배열 이벤트는 기존 Outbox에 확정/저장. 구버전 READY·전송 완료 데이터는 다시 판정/소급 보강하지 않음. 응답 유실·재시작 때 동일 ID/순번/본문으로 재전송하고, 배열 전송을 꺼도 확정 본문을 변조하지 않고 보류.
- 새 테스트 24개 포함 **593 passed, 14 warnings / 21.71초**. 가짜 모델·백엔드로 복수 근거·검색 공유·부분 미답변·조작 인용/ID·발화 순번·절단·배치·구버전 복구·응답 유실·HTTP 배열 계약 검증. 기존 주소·대시보드 테스트 포함 전체 통과.
- 실제 gpt-6-luna 가상 통화 8건 **8/8 통과**. 단일/복수 FAQ, 근거와 모순된 답변 제외, 미답변/검색 장애/명확화, 같은 FAQ 두 청크, 동일 문장 별도 응대 포함. 결과 output/faq-evidence/faq-evidence-v1-20261105.json. 최신 경계 검증으로 저장 판정 오프라인 재검증도 8/8. 운영 backend·전화에는 쓰지 않음.
- 종료 후 판정 2.110~6.033초, 평균 3.644초. 기존 미답변 검토와 같은 모델 호출이며 통화 중 추가 호출 없음. 표본이 달라 이전 평균과 차이를 기능의 순수 지연으로 단정하지 않음. 모델의 사후 근거 판정이며 Live 내부 선택의 직접 관찰은 아님.
- 실행 스크립트 scripts/check_faq_answer_evidence.py와 가상 데이터 evaluation/datasets/faq_evidence_v1.json, 설계/실행 안내 docs/architecture/faq-answer-evidence.md 추가. git diff --check 통과. .env 내용 조회·수정, 커밋·푸시·병합·운영 배포 없음.

## 2026-11-05 — FAQ 배열 지원 백엔드 최신 병합 확인

- 사용자 요청으로 origin/develop-backend를 다시 fetch해 0848174 → **6a141a0** 갱신. feature/faq-question-examples의 1313f27 구현·c08c530 문서 병합 확인.
- 실제 DTO는 faqEntrySeq 단건과 faqEntrySeqs 배열(1~100, 양의 int32, 중복 없음)을 지원한다. 입력 정규화 코드에서 두 필드 동시 전송을 400으로 거절하고 배열은 정렬한다. FAQ_ANSWERED 외 action에 참조를 보내도 400이다.
- migration 052-faq-question-examples.sql과 고객 질문 사례 수집/검증 코드 존재 확인. 첨부 연동 문서와 원격 문서가 일치함(보관 사본의 로컬 상대 링크 조정만 제외). 현재 AI 배열 구현과 호환돼 동작 코드 수정은 불필요.
- 계약 출처·설계 문서의 초기 미병합 안내를 갱신. 원격 코드 확인이며 운영 DB migration 적용·배포까지 확인한 것은 아님. 배열 전송 스위치는 false 유지. 문서만 갱신했으므로 통과한 593개 테스트/실모델 8건을 반복 실행하지 않음. 커밋·푸시·운영 쓰기 없음.

## 2026-11-05 — FAQ 배열 전송 활성화 전 운영 배포 점검

- 사용자 푸시/병합 준비 문의에 따라 운영 서버를 읽기 전용 점검. DB는 READ ONLY 트랜잭션으로 faq_question_examples 테이블 존재 여부만 확인(false), 실행 중 백엔드의 컴파일된 create-call-events DTO에서 faqEntrySeqs 지원 여부 확인(false).
- 원격 코드 병합과 달리 운영은 아직 배열 기능 미적용이다. faq_answered_enabled=false를 유지하고 백엔드 migration 052 적용·새 BE 배포 후 활성화하도록 안내했다. 임의로 운영 DB를 변경하거나 백엔드를 배포하지 않았다. 이 확인 단계에서는 커밋·푸시·병합도 하지 않음.

## 2026-11-05 — FAQ 배열 운영 배포 재확인·develop-ai 최신 반영 및 병합 준비

- 사용자 요청으로 운영 재점검. PostgreSQL READ ONLY 조회에서 faq_question_examples 테이블 존재=true, 실행 중 백엔드의 컴파일된 DTO에 faqEntrySeqs 존재=true 확인. 이전 보류 이후 배포가 반영됐으며 작업 브랜치 server.toml의 faq_answered_enabled=true로 준비했다. 실제 운영 DB/설정에 쓰거나 AI를 배포하지 않음.
- origin/develop-ai e5a9dee → 5330e0d로 갱신. 주소 개선 머지 되돌림이므로 해당 최신 트리를 그대로 반영하고 우리 작업으로 주소 변경을 재도입하지 않음. 기존 로컬 develop-ai 브랜치·개인 output/tmp 보존.
- 최신화 전에 충돌 가능한 worklog.md만 stash 1893e74로 보존하고 기능 브랜치를 fast-forward했다. 새 develop-ai 로그 위에 우리 기능 기록만 복원해 되돌린 주소 로그를 다시 넣지 않았다. 원본 stash는 백업으로 유지하며 기존 다른 stash는 건드리지 않음.
- 새 기준 전체 **574 passed, 14 warnings / 20.36초**. 이전 593개와의 차이는 develop-ai 되돌림으로 바뀐 테스트 구성이며 실패 없음. FAQ 배열 테스트와 기존 통화/미답변/대시보드 회귀 포함. 이번 재확인에서는 실제 모델 API를 다시 호출하지 않았고 기존 가상 검증 8/8 결과를 유지한다.
- 사용자 병합 준비 요청에 따라 기능 코드·프롬프트·설정·테스트·가상 데이터/검증 스크립트·계약·문서만 커밋하여 feature/faq-answer-evidence로 공유한다. Jira 번호 없이 진행하라는 사용자 지시를 따른다. output/tmp·인증 파일·개인 개발로그는 제외. 최종 develop-ai 병합은 사용자가 직접 진행한다.

## 2026-11-05 결제 방식 질문·안내 제거(사용자 결정)
- 결제 단계 삭제: 택배를 다 받고 "더 없음"이면 바로 결과 전송·마무리로(more_parcels → closing). 결제 방식 Decision 질문(pay)·N1' payment_choice/payment 알림·[fields.payment]·[[stage]] payment 제거
- 결제 방식은 서버가 고객 자격(availablePaymentMethods)으로 정함 — app/domain/assess.auto_payment: groupBilling > credit > 하나뿐인 방식, 빈 배열이면 미정(paymentMethodType 생략 → INCOMPLETE PAYMENT_UNKNOWN, 기본 billing 금지 유지). 결과 본문의 paymentMethodType 데이터는 그대로
- Live 지시문: business_rules.md "결제 안내" → "요금"(결제 방식은 묻거나 안내하지 않음, 결제 완료·카드번호 금지 문장과 요금 문장 유지), [results].order의 notPaid 결제 대기 안내 삭제(그 밖과 같이 "담당자가 확인 후 안내"). 금지 항목·"결제 완료" 문구 검사는 유지(오안내 방지)
- 대시보드 이탈 단계: PAYMENT_GUIDANCE를 더 만들지 않음(more_parcels·closing → NONE). BE 코드 값 자체는 계약에 남음
- 미변경: policy/backend_rules.md(결제 판단 금지 문장 — 여전히 맞음, 커밋 안 된 다른 수정 있음), docs/call-flow/flow.toml(옛 설계, 실행에 안 쓰임)
- 테스트 553 passed(결제 자동 선택 6가지, 결제 단계 없음, Decision 질문 세트, 지시문에 결제 방식 없음)

## 2026-11-05 — 종료 검토와 기본 기록 전송 분리

- 통화 228은 종료 검토의 고객 참조/인용 검증 실패로 전사·분석까지 전송되지 않았다. 실패 원시 출력이 없어 정확한 오인용 문구는 확인 불가. 운영 데이터는 수정하지 않았다.
- fix/postcall-review-delivery에서 기본 전사·업무 이벤트를 먼저 보내고, 검토 후 FAQ/미답변·분석을 별도 단계로 전송하도록 수정했다. 모델에는 명시적 발화/검색 ref를 제공한다. 잘못된 문의/인용은 해당 항목만 제외하고 보호된 Outbox에 원시 판정과 오류를 남긴다.
- 검토 실패는 KB_UNAVAILABLE 또는 KB_NO_ANSWER로 바꾸지 않는다. 기존 두 사유의 의미와 백엔드 계약은 유지한다. 미확정 FAQ 답변 수는 null이며 0으로 단정하지 않는다.
- 기존 확정 전송 본문/ID는 유지하고 과거 FAILED를 자동 재처리하지 않는다. FAQ 추가 이벤트 실패가 기본 분석 전송을 막지 않는다.
- 전체 단위 테스트 592 passed, 14 warnings. 공개 가상 대화 실제 모델 1차 8/9: 동일 FAQ의 중복 청크를 모호한 서로 다른 FAQ로 취급해 근거를 누락했다. 같은 source_id의 중복과 서로 다른 FAQ의 모호함을 구분하도록 프롬프트를 보완했다. 상세 설계: docs/architecture/postcall-review-delivery.md.
- 로컬 구현·검증이며 운영 배포/통화 228 재전송은 하지 않았다.

- 프롬프트 보완 후 같은 공개 가상 9건 재검증: 9/9 통과. 반복 실행 한 번의 통과이며 모든 실통화의 정확성을 보장하지 않는다.

## 2026-11-05 대기 중 채우는 말을 고정 문장 없이, 끼어들기 대응
- 프롬프트: render.py "백엔드에 맡기기"의 "짧은 대기 안내만" → 원칙만(정해진 문장 없이 고객이 방금 한 말에 이어지는 한마디를 그때그때, 짧게·되풀이 없이, 바로 답할 수 있으면 생략 / 결과·판단·되읽기·다음 질문 금지 / 고객이 말하면 바로 멈추고 받기, 늦게 온 결과는 고객이 방금 한 말에 맞춰 필요한 것만). 페르소나와 무관하게 항상 들어감(운영 페르소나에도 적용)
- persona_default.md: "## 대기 안내" 고정 3문장 삭제, 끼어들기의 고정 "네 고객님" → "짧게 받은 뒤 기다린다"
- 코드(app/calls/live.py): 위임 결과 재개(resume → response.create)와 N2(_wait_quiet)가 고객이 말하는 중(rt.cust)이면 말이 끝날 때까지 기다림(_customer_quiet, 상한 8초). 이전에는 고객이 끼어들어 말하는 중에도 앞선 결과로 Live를 재개할 수 있었음
- 영향: 고객이 결과 도착 중에 말하면 결과 안내가 그 발화 끝(+utterance_gap_ms)까지 늦어짐. 실통화로 겹침이 실제로 있었는지는 미측정(로그 없음)
- 테스트 579 passed(+2: 고객 발화 중 재개·N2 보류 — 보강 전 코드에서 실패 확인, 지시문에 고정 대기 문장 없음·원칙 포함)

## 2026-11-05 — 종료 검토 수정 최신 develop-ai 통합 검증

- 사용자 승인으로 fix/postcall-review-delivery에 origin/develop-ai d0e7d1b를 병합했다. 팀원의 채우는 말/끼어들기 처리 변경을 그대로 유지했다. worklog 동시 추가 충돌은 양쪽 기록을 모두 보존해 해결했다.
- 통합 전체 테스트 **594 passed, 14 warnings / 21.12초**. 실제 모델 공개 가상 평가 9/9 결과는 이전 프롬프트 검증이며 이번 최신 병합 후에는 추가 모델 호출 없이 전체 회귀 테스트를 실행했다.
- 수정 커밋 9de6327 및 최신 통합 이력을 작업 브랜치에 푸시하고 develop-ai 대상 MR을 준비한다. 사용자 개인 output/tmp와 비밀 설정은 커밋하지 않는다. 운영 배포·통화 228 재전송 없음.

## 2026-11-05 — 부분 검토에서 검증된 FAQ 응대 건수 보존

- 백엔드 팀이 보고한 통화 232의 FAQ_ANSWERED 3건/faqAnswerCount null 불일치를 코드와 로컬 재현으로 확인했다. 원인은 검토 complete=false이면 검증된 ANSWERED 문의도 집계에서 null로 바꾸던 처리였다. 이번에는 운영 통화/DB를 직접 조회하거나 수정하지 않았다.
- 사용자 승인으로 최신 origin/develop-ai f229c41에서 fix/faq-answer-count 별도 worktree(tmp/faq-count-fix)를 생성했다. 다른 문서 작업 브랜치의 수정/미추적 파일은 그대로 보존했다.
- 정상 검증된 ANSWERED 문의가 있으면 부분 검토에서도 그 수를 전송한다. 완전 검토+답변 없음=0, 불완전 검토+확인된 답변 없음=null, 검토 전체 실패=null은 유지한다. 숫자는 확인된 문의 응대 수이며 FAQ 번호 배열 길이/검색 수/전체 응대 보장값이 아니다.
- 질문/답변 원문·근거 검증과 KB_UNAVAILABLE/KB_NO_ANSWER, FAQ 이벤트, 모델 호출 횟수, API 계약은 변경하지 않았다. 정상 3개+질문 띄어쓰기 오류 1개의 가상 사례에서 이벤트 3건과 분석 3건을 함께 확인했다. 오류는 내부 검토 기록에 남는다.
- 전체 **595 passed, 14 warnings / 23.96초**, git diff --check 통과. 모델 API 추가 호출 없음. 확정된 과거 Outbox/분석은 변조·자동 재전송하지 않으므로 통화 232의 기존 null 복구는 별도 처리다. 커밋/푸시 후 MR 준비하며 최종 병합·배포는 하지 않는다.

## 2026-11-05 — 기본 주소 저장 제안: 상세주소만 바뀌어도 제안(BE 확인 4번)
- BE 담당자 확인사항 3건(통화 등록 번호 유실·SENT_UNCERTAIN 주기 재확인 없음·상세주소 비교 누락)을 코드로 대조해 모두 사실로 확인했다. 이번에는 4번만 고쳤다.
- 원인: `save_offer`(app/domain/address_book.py)가 도로명 문자열만 비교해, 101호→102호처럼 상세만 바뀌면 저장 제안이 나가지 않아 `PATCH /api/customers/{id}`를 부르지 못했다. 상세주소는 BE 응답→`_pin_place`→`origin_place`까지 이미 들어오고 있었고, 비교용 `default_address`만 도로명으로 잘라 두고 있었다.
- 수정: `Customer.default_address_detail` 추가(state.py), `_apply_context`에서 `default_origin.address_detail or ""`로 채움(service.py), `save_offer`가 (도로명, 상세) 쌍을 비교(address_book.py), PATCH 성공 뒤 상세도 갱신(results.py). 되읽기 전에는 상세가 반드시 채워지고(없다고 하면 "") BE도 생략을 ""로 정규화하므로 None은 비교에 오지 않는다.
- BE API·계약 변경 없음. 테스트 595 passed(+1: 상세만 다름→sender 제안, 같음→없음, 양쪽 ""→없음).
- 남은 일(미구현): 1번 통화 등록 번호는 context 응답 즉시 보관하고 이력 조회를 분리, 2번 SENT_UNCERTAIN 주문 결과를 실행 중에도 같은 키·본문으로 재전송.

## 2026-11-05 — 2단계 통화 등록: 번호를 먼저 보관하고 이전 접수 주소는 별도 조회(BE 확인 1번)
- 원인: `_stage2`가 `caller_context(recent_limit=5)` 한 호출(예산 3초)로 통화 등록 POST → 출발지 이력 → 도착지 이력을 순서대로 했고, 게이트웨이 `wait_for`가 코루틴 전체를 취소해 등록이 끝났어도 이력이 늦으면 `callSessionSeq`를 잃었다(요청 1건 timeout 3초 × 3건 vs 예산 3초). 실패한 stage2는 그 통화에서 재시도하지 않아 조회·취소 `CALL_NOT_REGISTERED`, 종료 후 이벤트·분석·주소 저장 생략으로 이어졌다.
- 수정(app/calls/service.py): `_stage2`는 `recent_limit=0`으로 등록만 하고 즉시 `_apply_context`로 번호를 보관·`done`. 등록 고객이면 `_stage2_history`를 별도 작업으로 띄워 ORIGIN 1건·DESTINATION N건을 `gather`로 병렬 조회(각각 게이트웨이 기본 읽기 예산 3초). `BackendFailure`는 note("이전 접수 주소 조회 실패")만 남기고 번호에 영향 없음. 받은 이력은 `_apply_context`를 한 번 더 불러 반영.
- `call_session_seq()`를 기다리는 조회·취소 도구는 이제 등록만 기다린다. 최근 도착지 후보는 수십~수백 ms 뒤 들어온다(record 도구는 원래 stage2를 기다리지 않아 같은 창이 있었음).
- `api.caller_context`의 내부 이력 조회 블록과 시그니처는 유지(backend_client 테스트·mock 의존). 새 설정값 없음. BE 계약 변경 없음. 문서 call-lifecycle.md §2.2 2단계 행 갱신(이미 "병렬"로 적혀 있었고 코드가 순차였음).
- 테스트 596 passed(+1 `test_stage2_keeps_call_seq_when_history_lookup_fails`: 이력 503이어도 번호 보관·stage2 done·PIN만·기본 주소는 context에서). 수정 전 코드에서는 번호 없음으로 실패 확인.
- 하지 않음: 등록 POST 자체 실패 시 재시도(BE context는 같은 providerCallId면 멱등이라 추후 가능).

## 2026-11-05 — SENT_UNCERTAIN 주문 결과를 실행 중에도 같은 키로 재확인(BE 확인 2번)
- 원인: `POST /api/orders`가 503·연결 끊김·시간 초과로 불확실해지면 아웃박스에 `SENT_UNCERTAIN`으로 남는데, 재전송 함수 `_send(row)`는 기동 시 `recover()`에서만 불렸다. 주기 작업 `review_loop`는 검토·인사이트만 다뤄 프로세스가 계속 떠 있으면 장애가 풀려도 그대로였다.
- 수정: `ResultService.resend_loop/resend_unfinished`(app/calls/results.py) — `unfinished_results`를 돌며 같은 키·같은 본문으로 `_send`. 이 프로세스가 전송 중인 행(`tasks`에 미완료)과 `updated_at`이 전송 예산(`submit_budget_sec`) 안인 행은 건너뛴다. 기동 `recover()`와 같은 `result_lock`을 써 동시 전송을 막는다. 아웃박스 `result()`가 `updated_at`을 돌려주게 함(outbox.py). 설정 `[backend] result_resend_sec`(기본 60초, 0이면 재시작 때만) 추가(config.py·server.toml), main.py에서 작업 시작·종료 시 취소.
- 멱등: 키·본문은 아웃박스에 고정돼 있고 BE는 같은 `Idempotency-Key`면 기존 결과를 200으로 돌려준다(backend_client/api.py submit_result). 새 키를 만들지 않으므로 중복 주문 없음. BE API·계약 변경 없음.
- 테스트 597 passed(+1 `test_uncertain_submit_is_rechecked_while_running`: 예산 안 행 건너뜀 → 전송 중 행 건너뜀 → 재확인 후 DONE·같은 키로 주문 1건). 편집 중 `recover()` 끝의 `recover_reviews()` 호출이 밀려 `test_v1_confirmed_review_is_not_backfilled`가 깨진 것을 잡아 되돌렸다.
- 범위 밖: 재전송이 나중에 성공해도 그 통화의 분석(registeredParcelCount 등)은 고치지 않는다(기동 복구도 동일). `FAILED`(400·404·422)는 재시도하지 않는다. 포기 조건 없음(`attempts` 누적).
- 문서: error-recovery.md 통화 결과 행 갱신.

## 2026-11-05 주소 저장 질문을 접수 확인과 나누고, 보내는 곳·받는 곳 동의를 따로(사용자 결정)
- 문제: "이대로 접수할까요? 받는 곳 주소도 주소록에 저장해 드릴까요?"를 한 번에 물어, 저장에 대한 "아니요"가 접수 확인 no로 읽혀 확인 대기가 풀리거나, "네" 한마디면 저장 동의가 비어 저장되지 않음. sender·receiver를 yes/no 하나로 받아 "받는 곳만"도 기본 출발지까지 바뀜(BE는 PATCH 고객 주소·POST PIN으로 원래 따로)
- 흐름: 되읽기 도구 결과에 address_save를 넣지 않고(record.py, 제안은 상태에만) → 택배를 담은 N2에 address_save(아직 답 없는 항목) → Live가 저장만 따로 묻고 → 답 뒤 더 보낼 택배
- 상태: address_consent bool → 항목별 dict(state.py). _save_pending(live.py) = 담은 택배의 제안 중 답 없는 항목(담기 전에는 없음 → 되읽기 중 저장 판정 안 함)
- Decision: save 질문을 save_sender·save_receiver로 나누고 제안한 항목만 보냄(render.decision_questions save=항목). 저장 답을 기다리는 동안 more(더 없음)를 빼 저장 "아니요"가 더 없음 → 즉시 결과 전송으로 이어지지 않게 함
- 저장(_maybe_save_addresses): 답한 항목만 처리 — 동의한 항목만 save_addresses로(백그라운드), 거절 항목은 버림, 답 없는 항목은 남았다가 통화가 끝나면 저장하지 않음(다시 묻지 않음)
- 지시문: business_rules.md·workflow.toml(parcel_added·address_save·save 질문 2개) — sender는 기본 출발지를 바꾼다는 뜻을 명시, 고정 문구 없음
- 테스트 599 passed(기준 598, 새 테스트 2·기존 1 교체: 항목별 저장·거절·남김, 담기 N2에 제안·저장 대기 중 more 없음·apply 항목별 기록, 되읽기 결과에 제안 없음). 기존 끼어들기 테스트의 타이밍 불안정(Windows sleep 오차로 1/6 실패) — 전사 간격 30→10ms, 20회 0실패
- 남은 한계: 한 발화에 저장 답과 "더 없어요"를 같이 하면 더 없음은 판정하지 않아 한 번 더 물음. 주소록에서 고른 받는 곳을 고친 경우 기존 PIN 수정 없음(shortcut 그대로). 실통화 미확인

## 2026-11-05 주소 저장 동의를 다시 한 번의 답으로(사용자 결정, 접수와 저장 분리는 유지)
- 되돌림: 항목별 동의(address_consent dict, Decision save_sender·save_receiver)를 bool 하나·save 질문 하나로. 제안한 주소(보내는 곳·받는 곳) 전체를 한 번의 답으로 정함 — 동의면 둘 다 저장, 거절이면 둘 다 버림
- 유지: 되읽기 결과에 address_save 없음, 담은 뒤 N2로 저장만 따로 묻기, 저장 답 대기 중 more 판정 제외, 답 없으면 저장 안 함(다시 묻지 않음), sender가 기본 출발지를 바꾼다는 지시문
- save 질문 지시문에서 "접수 확인에만 답하고…" 제거(담은 뒤에만 묻으므로 접수 확인과 섞이지 않음)
- 테스트 599 passed(항목별 테스트 → 한 번의 답으로 둘 다 저장·거절, apply는 save 하나)
- 다시 적용: !285(항목별 동의 버전)는 develop-ai에 병합됐다가 의도적으로 revert됨(665559a). revert는 유지하고 그 위(973b9d0)에 최종 버전(접수·저장 분리 + 보내는 곳·받는 곳 한 번의 동의)을 새 커밋 하나로 얹음(브랜치 fix/address-save-after-commit). 위 두 항목의 변경을 합친 결과와 같다

## 2026-11-05 — FAQ 후보 표시와 최종 근거 판정 분리

- 사용자 승인으로 최신 develop-ai 5a1f14c의 별도 worktree/브랜치 fix/faq-evidence-outcome에서 수정했다. 다른 문서 작업/개인 파일은 보존했다.
- 통화 242를 읽기 전용 대조: FAQ_SEARCH 6건 모두 AI가 근거 있음으로 전송, 날씨 후보는 무관한 FAQ였다. 미답변 인용/발화 ref는 실제와 일치했으나 마지막 재검색이 발화 시작보다 0.55초 늦어 INVALID_AGENT_QUOTE가 났다. 초기 인용 오류 가설을 정정했다. 과거 데이터 변경/재전송 없음.
- 검색 직후에는 후보 N건 반환만 표시한다. 검증된 FAQ_ANSWERED는 답변 근거 있음, 확정 QUESTION_UNANSWERED는 KB_NO_ANSWER의 답변 근거 없음/KB_UNAVAILABLE의 검색 장애로 구분한다. UNANSWERED는 앞선 관련 검색 뒤의 실제 거절 인용을 인정하되 ANSWERED의 마지막 검색 이후 조건과 원문/참조 검증은 유지한다.
- 전체 **605 passed, 14 warnings / 25.41초**. 공개 가상 실제 모델 **10/10 통과**, 날씨+안내 도중 재검색 사례 포함. 초기 테스트 MockBackend 래퍼 접근 2건 오류는 body.reason을 검사하도록 바로잡았다. 모델 호출 단계/API 계약/RAG 임계값은 변경하지 않음.
- 설계 및 프론트 전달 사항: docs/architecture/faq-search-outcomes.md. 과거 표시 매핑은 프론트 보완 필요, 검토 실패를 근거 없음으로 간주하지 않는다. 기존 확정 Outbox/분석/이벤트는 수정하지 않는다. 운영 배포와 과거 통화 재처리는 별도다.

## 2026-11-05 — Live 입력 선검증·프롬프트·업무 흐름 분석(구현 없음)

- 원격 develop-ai를 fetch하고 af9dd88에서 `codex/analyze-live-validation-conflicts` 브랜치를 생성했다. 기존 미추적 output/·tmp/는 보존했다.
- 분석 문서: `docs/architecture/live-validation-audit-20261105.md`. 가액 0~1억 허용과 프롬프트의 1억 이상 거절, 박스 합계 검사 누락, 서류 99개 상한을 사용자 확정 규칙과 대조했다.
- 제시된 9개 지적 중 2~9는 현행 코드에서 확인했다. 1번 운영 페르소나 원문은 제시된 로컬 경로에 없어 미확인으로 구분했다. 기본 페르소나와 운영 promptText 유입 경로는 확인했다.
- 가짜 클라이언트 재현: 가액 0·1억 허용/2억 거절, 서류 100 거절, 박스 11 허용, 조회→접수 intent 유지, PIN 마지막 선택 뒤 pending 누락, 작성 건 없는 취소 재확인 무알림, more 후속 처리 없음, 잘못된 번호 정정의 오류 필드 제외, 상세주소 되읽기 포함. +72시간 30분 허용과 기본 수거 59분 30초 결함도 확인했다. 재현 스크립트·결과는 개인 output/live-validation-audit/에 보관했다.
- 관련 기존 테스트 131 passed, 13 warnings / 7.60초. 초기 샌드박스 실행은 Windows asyncio 내부 socketpair 대기로 중단했고 최소 재현으로 환경 문제 확인 후 승인된 외부 실행으로 완료했다. 운영·모델 API 호출 없음.
- 권고: 고정 제한을 Policy 한곳에서 Live 안내·도구 스키마·서버 검사로 공유하고 Live 즉시 재질문 허용. 저장·확정 검증은 유지한다. 종료/전환·PIN 확인·취소 재확인·more·수거 시간은 작은 흐름 수정으로 별도 해결한다.
- 서비스 코드·외부 계약·운영 데이터 변경 없음. 실제 주문 BE 구현은 이 체크아웃에 없어 계약 문서와 구분했다. 실통화 지연 개선은 미측정이다.
