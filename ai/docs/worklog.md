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

## 2026-11-05 — develop-ai 최신화 및 프로젝트 구조 점검
- origin fetch 후 develop-ai를 f34343f에서 2ac6717로 fast-forward(27개 커밋). 기존 미추적 output/, tmp/ 보존.
- 실제 진입점 app/main.py 기준으로 calls(통화·위임·결과), domain(업무 상태·확인), tools, address, rag, persistence(outbox), monitor, backend_client 구조 확인. 소스코드·외부 API 계약 변경 없음.
- 이 브랜치의 frontend는 .gitkeep만 있고 backend는 NestJS 상태 확인용 기본 코드. 전체 서비스 구현 범위와 혼동하지 않도록 각 개발 브랜치 구분 필요.
- README 및 architecture/current-state.md의 부품 모음·서버 부재 설명은 현재 구현과 차이 있음. Dockerfile은 현재 app.main:app을 실행하며 단일 워커 사용.
- 검증: 기존 가상환경(Python 3.14.7)에서 플러그인 자동 로딩·pytest 캐시를 끄고 test_dashboard_metrics.py의 이탈 단계·대기시간·측정 범위 테스트 18 passed, 4 deselected. 전체 테스트와 확대 실행은 완료되지 않아 중단(일부 오류 표시 포함, 원인 미확정). 전체 통과로 판단하지 않음.
- 실제 OpenAI·PBX·백엔드·카카오·Qdrant 통합 검증 및 배포는 수행하지 않음.

## 2026-11-05 — LIVE-1 위임 대기 발화 원인 조사
- docs/architecture/live-waiting-speech-investigation.md에 코드·기존 실험·공식 문서 근거와 다음 검증 계획 기록. 구현·외부 계약 변경 없음.
- 공통 정책은 결과 전 짧은 대기 안내를 요구하고, 기본 페르소나는 안내 문구 혼합을 요구함. 운영 BE ACTIVE 페르소나 적용 여부는 미확인.
- Responses 위임 중 LIVE 자율 발화와 이후 결과 안내가 이어지는 현상을 유력 원인으로 분류. 문장 중단·무관한 발화의 정확한 원인은 최신 녹음·이벤트 부재로 미확정.
- 공식 문서의 자동 acknowledgment 억제는 client 위임용이며 현재 Responses에 직접 적용 불가. 설치 SDK에도 해당 delay 필드는 없음.
- 검증은 코드·설치 SDK·공식 문서·기존 실험 보고서 읽기만 수행. 테스트·실통화·유료 API 호출 없음.

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

## 2026-11-05 — 개인정보 변경 문의의 검색 누락 후속 분석(구현 없음)

- live-validation-audit-20261105.md §6에 규칙 단일 출처의 의미와 개인정보 변경 문의 경로 분석을 추가했다.
- 로컬 웹 FAQ 원본에 ‘회원 정보 변경’과 마이페이지 안내가 있음을 확인했다. 운영 관리 FAQ 색인 포함 여부·해당 통화 로그는 미확인이다.
- inquiry 분류만으로 검색은 실행되지 않으며 Live 위임→Responses 도구 선택이 별도로 필요하다. 이름 정정 즉시 재질문·등록 고객 접수 유도·missing 복귀 지시와 회원정보 안내 예시 누락이 검색 전 경로 이탈의 유력 원인이다. 실제 모델 오분류 여부는 단정하지 않았다.
- 이번 택배 sender_name 기록과 고객 원장 이름 변경은 다르다. AI에는 독립 고객 이름 수정 도구가 없고 기본 주소 PATCH는 택배 담기 뒤 저장 동의 경로에 연결됨을 확인했다. 웹 FAQ 안내와 전화 수정 실행 가능 여부를 구분하도록 권고했다.
- 코드·외부 계약 변경 없음. 정적 분석·로컬 FAQ 읽기만 수행했으며 모델·운영 API를 호출하지 않았다. 문서 변경이므로 테스트 재실행은 하지 않았다.

## 2026-11-05 — 입력 규칙을 Policy 한곳에서 Live·Responses·서버에 적용

- 사용자 구현 승인에 따라 기존 분석 브랜치에서 진행했다. `policy/workflow.toml` version 2026-11-05.2에 `[input_limits]`(가액 1~99,999,999원·박스 합계 10·서류 별도 100)와 기존 허용 형식을 유지하는 `[phone]`을 추가했다. 수거는 기존 `[pickup]`을 사용한다.
- model.py에 정책 범위·시각·전화번호 정합성 검사를 추가했다. render.py는 같은 정책으로 Live·Responses 제한을 생성하고 business_rules의 수거 문구를 치환한다. 명백한 입력 오류의 즉시 재질문, 혼합 발화의 정상 정보 보존, 오류 status/code/needs 우선 해석을 명시했다. 기존 1억 이상 처리 불가 문구는 범위 설명·재질문으로 교체했다.
- record_args가 정책별 인자 모델을 캐시 생성하고 executor·세션 구성에서 같은 정책으로 검증·도구 스키마를 만든다. 박스 합계는 서버 validator로 검사한다. 수량은 현재 parcel 단위이며 동일 수령지의 서로 다른 parcel을 자동 합산하지 않는다. 인자 오류는 기존 TOOL_ARGS_INVALID로 호출 전체를 거절하며 이전 정상값은 보존한다.
- 수거는 최신 요청의 ‘현재부터 3일’을 정확한 72시간으로 적용했다. 09~17시 조건은 유지했다. 기본 시각의 초 단위 내림을 올림으로 고쳐 59분 30초 뒤를 기본값으로 주던 문제를 해결했다. 실제 상대 시각 해석용 시계 갱신은 이번 범위에 포함하지 않았다.
- `test_input_policy.py` 31건 추가: 가액·수량 경계와 정수 타입, 잘못된 정정의 기존값 보존, TOML 변경→Live/Responses/세션 스키마/실제 서버·전화번호·수거 반영, +1시간/+72시간 경계, 기본 수거 시각 올림, 잘못된 정책 거절. 기존 관련 131개 통과 후 전체 **636 passed, 14 warnings / 23.52초**. 외부 운영·모델 API 호출 없음. git diff --check 통과.
- BE API 경로·필드·인증·주문 매핑 및 기존 오류 코드 유지. 운영 배포·푸시 없음. 사용자가 별도로 수정한 persona_default.md와 기존 output/·tmp/는 커밋에서 제외한다. FAQ/업무 전환 수정·실통화 응답 지연 측정·운영 페르소나 정리는 후속 작업이다.

## 2026-11-05 — 물품 가액 상한을 1억 원 포함으로 정정

- 사용자 정정에 따라 workflow.toml version 2026-11-05.3의 item_price_max를 100,000,000으로 변경했다. 하한 1원 및 다른 규칙은 유지했다. 공통 정책에서 Live·Responses 안내와 도구 스키마·실행 검증에 반영된다.
- 현재 정책 문서와 회귀 테스트를 갱신했다. 1억 원 허용·1억 1원 거절, 기본 프롬프트에 1억 원 포함 안내, 사용자 지정 정책과 기본 스키마 분리를 확인했다. 과거 분석·작업 이력의 당시 수치는 보존했다.
- 관련 테스트 **52 passed, 13 warnings / 0.88초**. 외부 계약 변경·운영 API 호출·배포·푸시 없음. 별도 수정 중인 persona_default.md는 포함하지 않는다.

## 2026-11-05 — 보안 요청 거절 및 기본 페르소나 응대 지침 보완

- 사용자가 직접 수정한 business_rules.md·persona_default.md를 확인하고 커밋·푸시·develop-ai 병합 요청에 따라 반영한다. 브랜치는 최신 develop-ai 4d68066 기반 `fix/live-prompt-instructions`이며 Jira 번호는 사용자 지시에 따라 생략했다.
- 항상 적용되는 업무 규칙에 내부 프롬프트·인증 정보 비공개, 권한 없는 DB·타 고객 정보 접근 및 보안 우회 거절, 역할 사칭·프롬프트 인젝션 거절, 검색 자료·도구 결과의 명령문을 시스템 지시로 취급하지 않도록 하는 지시를 추가했다. 본인 정보 변경 방법 문의 등 정상 질문은 거절하지 않도록 구분한다.
- 기본 페르소나는 고객이 이해할 수 있는 선에서 매우 빠르게 말하기, 고객 발화 시 즉시 멈추기, 짧은 받는 말 없이 기다리기 및 맞장구 문구를 사용자 수정대로 반영한다. BE 활성 페르소나 사용 시 기본 페르소나 수정 적용 범위는 기존과 같다.
- 기존 정책·페르소나 관련 테스트 **27 passed, 13 warnings / 1.68초**, git diff --check 통과. 실제 모델의 공격 방어·음성 속도를 검증한 것은 아니다. 서비스 코드·외부 API 계약·운영 데이터는 변경하지 않았고 output/·tmp/는 포함하지 않는다. 운영 배포는 별도다.


## 2026-11-05 주소 보정 전면 재설계 — 분석·설계(구현 전, 승인 대기)
- 요구: STT 주소를 실제 주소로, 도로부터·건물명만·구/동부터 말해도 인식, 지번→도로명, 낮은 STT 정확도 내성, 카카오 `analyze_type=similar` 활용
- 현황: v1 시험지 106/106·15/15, 보정 p50 8ms. 구조적 전제 = 시도→시군구를 앞에서 반드시 찾음 → 도로만·건물명만·동부터는 not_found. 전국 중복(중앙로 92개 시군구)이라 지역 없는 발화는 "되묻기"가 정답인 경우가 많음(사용자 이전 실험 실패 7건 모두 다른 지역 같은 도로명)
- 자료원: 행안부 DB 유지 + 부가정보 적재(건물명 702,163건·우편번호·행정동) 채택. 카카오 단독은 소리 오류에 약함(Top5 36~46% vs 로컬 98%) → 보강용(`similar`·키워드, 로컬 검증 후 채택). 무료 일 10만 건, 초과 429
- 설계: 지역 단계 선택적(시도/시군구/읍면동 생략 가능) + 전국 이름 색인(FTS5 trigram, SQLite 3.50 확인) + 건물명 경로 + `region_needed`(다른 시군구 중복은 P6 자동 확정 안 함, `ADDRESS_REGION_NEEDED`로 되묻기) + Geo 로컬화(선택·측정 후). 지역 잡히는 발화는 기존 경로 그대로(회귀 0)
- 문서: docs/architecture/address-redesign-plan.md(격차표·자료원 비교·설계·영향 범위·측정 계획·단계·결정 6건·위험). 코드 변경 없음

## 2026-11-05 주소 보정 재설계 0단계 — v2 시험지·현 코드 기준선
- 사용자 결정: 결정 1(다른 시군구 중복은 되묻기)·2(되묻은 지역은 모델이 앞 주소와 합쳐 재전달)·4(새 DB 없으면 기동 실패) 권고안 채택, 카카오 REST 키 보유, 6(고객 맥락 미사용) 권고대로. push는 지시 전까지 하지 않음. DB 구조는 효율적으로 바꿔도 됨(1단계 반영)
- 추가: evaluation/datasets/address_v2.json 71문항 — 도로만 12·시도만 8·동부터 5·동+지번 8·건물명 16·POI(카카오 필요, 태그 kakao) 6·지역 되묻기(expect_status=region_needed) 10·없는 주소 6. 정답은 주소DB(2026-09-30)로 먼저 확인(도로명 전국 시군구 수·번호 있는 곳, 법정동 중복, 부가정보 건물명→주소). 부가정보 건물명 표기 주의: "롯데월드타워앤드롯데월드몰", "카카오 판교 아지트", "부산광역시청, 부산광역시의회" → 부분 일치 필요. 63빌딩·국회의사당·DDP·"서울시청" 약칭은 부가정보에 없음 → 카카오 키워드 몫
- scripts/evaluate_address.py: --dataset 선택, expect_status(되묻기 정답) 분류 asked/wrong/missed와 요약 ask 항목, positive.missed를 정답 문항만 세도록 수정
- 기준선(현 코드 65a462d, 카카오 끔): v2 정답 문항 55 중 기록 1(d05 "강남구 역삼동 테헤란로 212"만), 못 찾음 54, 틀린 기록 0 · 되묻기 10 중 0 · 없는 주소 6/6 거부. v1은 106/106·15/15 그대로(스크립트 변경 회귀 없음). 결과 evaluation/results/address_v2_baseline.json

## 2026-11-06 주소 보정 재설계 1·2단계 — 주소DB 확장, 지역 없이·동부터·건물명 찾기, 지역 되묻기
- 사용자 지시: 땜질(사례용 예외) 금지, 근본 원인 수정. DB 구조는 효율적으로 바꿔도 됨
- 1단계 app/address/gazetteer.py: buildings에 우편번호·행정동(hdongs) 열, building_names(부가정보 시군구용·건축물대장 건물명), 전국 이름 색인 names(도로명 174,386·법정동/리/읍면동 19,804·건물명 578,758) + 외부 내용 FTS5 trigram(원문 중복 없음) + fts5vocab. 복합 건물명은 빌드 때 구성 이름으로 풀어 적재(name_variants: "A앤드B"·"A, B"·"이름(본옥)") — 보정기에 부분 일치 규칙을 두지 않기 위해. 전체 번호 읽기(numbers·jibun_numbers)는 점 조회(lookup·jibun_lookup)로 교체(번호는 정확 일치만 보므로). open_db는 옛 스키마(names 없음)면 RuntimeError(결정 4). 빌드 91초, 851MB(기존 612MB), data/address.db(.gitignore)
- 2단계 app/address/matcher.py: 시군구를 못 잡으면 wide_scope — 시도만 → 그 시도 전체, 법정동·읍면 → 그 동이 있는 시군구들(area_regions, 정확히 들린 이름만), 둘 다 없으면 전국. 후보는 색인(search_names)에서 뽑고 점수 체계는 기존 그대로. 지번 전국 경로도 같은 범위. 건물명 경로(building_candidates)는 도로·지번이 없고 번호 토큰이 없을 때만, 지역을 뗀 이름과 전체 이름 둘 다 봄("강남파이낸스센터"처럼 지역 낱말이 이름 안에 있음). judge: 후보가 다른 시군구에 걸치면 region_needed(결정 1), 지역을 전혀 안 말했으면 소리까지 정확한 이름(거리<1)만 확정하고 아니면 그 지역을 되묻음(전국엔 비슷한 소리가 늘 있음). resolve는 확정이 아니면 다시 볼 표기를 보고 확정이 나오면 채택("킨텍스요")
- 계약·정책: AddressResult/Resolution status region_needed, record_fields needs_input ADDRESS_REGION_NEEDED + needs[].regions(최대 3)·heard. business_rules(지역 묻기 문구), backend_rules(되물은 지역은 heard와 합쳐 재전달, 결정 2). docs: tool-contracts·error-recovery·decisions(P6는 같은 시군구 안에서만)
- 지연: 못 찾는 발화가 재시도마다 전국 FTS를 태워 v1 p95 100→525ms로 커짐 → 측정(전체 trigram 70~220ms, 드문 4~6개 12~50ms, 1위 동일) 후 trigram을 드문 것부터 posting 합 5만 이내(최소 4개)만 사용 → v1 warm p50 6.5·p95 181·max 237ms, v2 p50 93·p95 197·max 400ms
- 결과: v1 106/106·15/15(회귀 0, evaluation/results/address_v1_redesign_s2.json). v2 정답 55 중 48 기록·틀림 1·못 찾음 6, 되묻기 10/10, 없는 주소 6/6(address_v2_redesign_s2.json). 남은 것 — 틀림 p01 "63빌딩"(부가정보에 인천의 동명 건물만 있음: 건물명 단독은 약한 근거라 3단계에서 카카오 키워드로 교차 확인), 못 찾음 p02~p06(상호·약칭, 카카오 몫), b10 "포스코 센타"(지역 없이 소리를 고친 이름은 되묻기 — 설계상)
- 시험: 전체 통과(+8: 색인·건물명·복합 표기 풀기·옛 스키마 거부·지역 없이 찾기·되묻기·도구 ADDRESS_REGION_NEEDED). 샘플 DB에 올림픽로·두 지역 중앙로·건물명 추가

## 2026-11-06 주소 보정 재설계 3단계 — 카카오를 두 번째 근거로(키워드·similar, 로컬 검증 뒤 채택)
- app/integrations/kakao.py: 공통 요청(_documents)·has_key, search_places(키워드 장소 검색, 상호·약칭·POI), search_addresses(analyze_type=similar). 결과는 도로명주소 문자열, 상위 3개
- app/address/matcher.py: Resolution.weak(지역 없이 건물명만으로 확정, 또는 지역 없이 소리를 고친 이름 하나뿐인 되묻기 — 부가정보 "63빌딩"이 인천의 다른 건물인 것처럼 건물명 단독은 약한 근거). verify(카카오 주소를 주소DB로 검증, 이름 소리까지 정확), with_witness(검증된 주소만, 들은 번호가 있으면 같은 번호 + 들은 도로명(길 번호 포함)이 소리로 같은 주소만 — v1 k08 "테헤란로 21"이 "테헤란로87길 21"로 확정되던 문제의 근본 원인 수정 _same_road. 로컬 확정이 1순위, 지역이 엇갈리면 되묻기, 한 지역이면 확정)
- app/integrations/address.py: 로컬이 not_found이거나 weak이고 키가 있을 때만 카카오 둘을 병렬 호출(세마포어·공유 클라이언트·타임아웃 유지) → with_witness. 여러 지역에 실제로 있어 되묻는 경우(강한 근거)는 카카오가 덮지 못함
- scripts/evaluate_address.py --kakao(키 필요). 측정(_same_road 수정 전, 재측정 필요): v2 카카오 켬 54/55·틀림 0·되묻기 10/10·없는 주소 6/6, p01 "63빌딩"은 인천·영등포 두 지역 되묻기로 안전하게 전환(address_v2_redesign_s3.json). v1 카카오 켬 106/106, 없는 주소 14/15 — k08이 번호만 같은 다른 길로 확정(address_v1_redesign_s3.json) → _same_road로 고치고 단위 시험 추가, 전체 650 passed
- 남은 것: _same_road 반영 후 v1·v2 --kakao 재측정, 지연(p95) 재확인, 4단계(Geo 로컬화) 미착수, push 미실행

## 2026-11-06 3단계 재측정(_same_road 반영, 카카오 켬)
- v1 106/106·없는 주소 15/15(k08 해결), warm p50 8.6·p95 223·max 300ms (address_v1_redesign_s3.json)
- v2 정답 55 중 54 기록·틀림 0·되묻기 10/10·없는 주소 6/6, warm p50 115·p95 260·max 527ms (address_v2_redesign_s3.json). 남은 1건 p01 "63빌딩"은 부가정보(인천)와 카카오(영등포)가 엇갈려 두 지역 되묻기 — 틀린 기록이 아니라 안전한 되묻기
- 남은 것: 4단계 Geo 로컬화(사용자 결정 대기), push(지시 대기), 운영 서버 address.db 재업로드

## 2026-11-06 STT 오류 내성 측정과 결함 수정("지역 없음" 판정)
- 측정(전국 무작위 60건, 지역 말함, 도로명에 STT 혼동 자모 n개): 정상 60/60 · 자모1 52 · 자모2 48 · 자모3 32 · 자모4 18 · 음절 탈락 18(오답 7: 같은 시군구의 다른 실제 도로에 붙음) · 시군구 자모1+도로명 자모1 57 · 번호 한 자리 오류는 번호가 실제로 있으면 다른 건물로 확정 27(설계상 구별 불가 → 되읽기로 잡음)
- 결함: 시도 없이 시군구만 말한 발화("강남구 테헤람로 212")에 "지역 없음" 엄격 규칙(소리 정확한 이름만 확정)이 적용돼 되묻기로 빠짐 — `_correct`가 match_region 결과를 보지 않고 wide_scope만으로 판정. 수정: 시군구·시도·동 모두 없을 때만 엄격. 시험 추가, v1·v2 결과 불변

## 2026-11-06 주소 보정 재설계 4단계 — 접수용 지번·법정동·우편번호를 주소DB에서(Geo 로컬화, 결정 P12)
- 사전 확인(사용자 요청): 카카오 dongName = 지번 객체 region_3depth_name(문서 "동 단위", 실측 법정동; 읍면 지역은 "풍천면 갈전리"), 산은 "읍내리 산 45-1", 개편 시도명은 카카오도 새 이름(전남광주통합특별시 등) 사용, 시도 줄임은 특별시·광역시·도만 두 글자, 카카오 지번 = 지번 파일 대표여부 1인 행(3건 확인). 사용자 확인: 상호 검증이 아니라 DB에서 만들고 카카오는 보완
- gazetteer: jibun.rep(대표여부) 적재·재빌드(102초, 859MB), AddressDB.geo(도로명주소 → 대표 지번·"동"/"읍면 리"·5자리 우편번호, 카카오 표기 규칙 kakao_sido), 색인 jibun_building·roads(road, sido) 추가(없으면 지번 820만 행 전체 스캔으로 p50 392ms → 추가 후 7.7ms). 샘플 DB에 우편번호·행정동·비대표 지번
- AddressService: 확정 뒤 db.geo(실행기) → None이면 카카오 geocode. 보정 꺼짐(off)은 카카오 그대로
- 검증 scripts/compare_geo.py: 시험지 정답 주소 + 무작위 100건 = 146건에서 로컬·카카오 세 값 일치 145, 다름 0, 로컬 없음 0, 카카오 없음 1 → 전환
- 결과: v1 106/106·15/15 warm p50 7.7·p95 172ms, v2 48/55(카카오 끔)·되묻기 10/10·없는 주소 6/6 p50 100·p95 211ms (address_v*_redesign_s4.json). 시험 +3(geo 표기·시도 줄임·서비스 로컬 우선과 카카오 보완). 문서: tool-contracts·error-recovery·decisions P12
- 운영 반영 시: address.db 재업로드(859MB, 새 색인 포함) 필요. 다음: 1번 방안(확인 질문 띠) 재검토
=======
## 2026-11-05 — S15P31D109-162 업무 무관 질문 응답 제한 작업 준비

- 사용자 요청으로 origin/develop-ai를 fetch하고 최신 6c8499f에서 `fix/S15P31D109-162-live-off-topic-guard` 브랜치를 생성했다. 로컬 develop-ai의 미병합 문서 커밋 2개와 기존 output/·tmp/는 보존했다.
- 고정 business_rules.md에 무관한 요청 거절 규칙이 있으나, ‘고객이 무슨 말을 하든 응대’ 지시와 ‘정상적인 응대가 어렵다고 판단될 경우’라는 조건이 함께 있음을 확인했다. 실제 라면 추천 발화의 로그·운영 페르소나는 확인하지 않아 원인으로 확정하지 않는다.
- 후속 수정안: 고정 업무 규칙에 상담 범위와 일상 질문의 짧은 업무 복귀 응대를 명시하고, 정상 배송 문의·인사·혼합 발화를 구분한다. 프롬프트 검증과 실제 모델 대화 평가로 효과를 확인한 뒤 추가 서버 제어 필요성을 판단한다.
- 이번 요청 범위는 분석과 작업 준비다. 서비스 코드·프롬프트·외부 계약 변경 및 모델 호출·테스트·커밋·푸시·배포 없음.

## 2026-11-05 — S15P31D109-162 상담 범위 및 FAQ 자료 열람 제한

- 사용자가 수정한 business_rules.md·backend_rules.md를 검토하고 커밋·푸시·develop-ai 대상 MR 생성 요청에 따라 반영한다. fetch로 origin/develop-ai 6c8499f와 작업 브랜치 기준이 같음을 확인했다.
- Live 고정 업무 규칙에 택배 상담 범위와 정상 서비스 문의 구분, 업무 밖 답변·추천 제한, 확인·선택 단계 복귀를 명시했다. 무관한 요청 반복 시 종료 지시를 제거하고 범위 안내로 대체했다. 마무리의 일반 종료 금지 문장은 사용자 수정대로 삭제했으며 workflow.toml의 기존 금지 규칙과 서버 closing 절차는 유지한다.
- Live·Backend 양쪽에 FAQ 번호·문서 ID로 자료 열람·목록·원문·요약을 요청하는 경우 검색·공개하지 않는 지시를 반영했다. Backend에는 순차 읽기·번역 및 이미 검색된 자료 반환 제한과 혼합 요청의 정상 서비스 질문만 검색하는 지시를 추가했다.
- 기존 정책·페르소나·공통 입력 제한·RAG 프롬프트 테스트 64 passed, 13 warnings / 2.53초. 샌드박스 실행은 비동기 테스트 대기로 중단한 뒤 동일 테스트를 외부 실행으로 완료했다. git diff --check 통과. 사용자 QA 결과와 별개로 이번 작업에서 실제 모델 공격 방어·실통화·응답 지연은 검증하지 않았다.
- 서비스 코드·외부 API 계약·검색 접근 권한 변경 없음. 프롬프트만으로 기밀 보호를 보장하지 않으며, 비공개 자료의 검색 권한 분리는 별도 작업이다. output/·tmp/는 커밋에서 제외하고 운영 배포·병합은 수행하지 않는다.

## 2026-11-05 — 접수 완료 단계에서 마무리 인사 뒤 자동 종료

- 브랜치 `fix/auto-close-after-flow`(develop-ai 6c8499f 기반). 지시문(workflow.toml·business_rules.md)은 다른 개발자가 수정 중이라 변경하지 않았다.
- 문제: 종료는 고객이 끝내겠다고 말할 때(Decision end)뿐이었다. "더 없음"으로 assess 단계가 closing이 돼도 N1' more_parcels만 보내고 무발화 30초까지 통화가 유지됐다.
- live.py: no_more 뒤 단계가 closing이면 `_finish` — 결과 전송 시작 → 결과를 `closing_result_wait_sec`(기본 5초)까지 기다림(실패·초과면 pending) → 기존 고객 종료와 같은 N2 `{more_parcels:false, closing:true, order}` → `begin_closing("flow_complete")`. 인사 문구는 기존 지시문의 closing 규칙을 따른다. 고객이 먼저 끝냈거나 마무리 중이면 실행하지 않는다.
- service.py: 마무리 인사를 요청하고 4초 안에 말이 없으면 closing N2를 1번 다시 보낸다(고객 종료 경로도 같음). 상한 `closing_max_sec`에 걸려도 마지막 출력 전사 뒤 `closing_quiet_ms`는 지킨다(계속 말하면 +5초까지). `closing_quiet_ms`는 설정 검증 1000 이상(운영 1200 유지).
- 관제: "마무리 결과 대기", "마무리 마지막 발화→끊기", "마무리 오디오 끝 추정−전사 수신"(session.started + 출력 전사 end_ms 기준 추정 — 미실측이라 끊는 시점에는 쓰지 않고 기록만).
- 테스트: 접수 E2E를 "더 없음 → 결과 → 마무리 인사 → 1초 이상 뒤 끊김"으로 바꿈, 접수 도중 고객 종료, 결과 미수신 pending·무발화 재요청·1초 보장, closing_quiet_ms<1000 거부. 전체 **640 passed**.
- 외부 계약(BE API·PBX hangup·Live 이벤트) 변경 없음. 미확인: 전사 수신과 실제 오디오 재생·PBX 전달 지연의 차이(실통화로 관제 값 확인 필요), 결과 대기 5초의 적정성. 남은 한계: 마무리 중 고객 발화는 듣지 않고 끊는다. 조회·취소·문의는 state에 완료 단계가 없어 범위 밖. 결과 대기 동안 "궁금한 점 있는지 묻는" 기존 지시문 문구(more_parcels)와는 N1' more_parcels를 보내지 않아 충돌하지 않지만, 지시문 수정 시 closing 규칙과 맞춰야 한다.

## 2026-11-05 — S15P31D109-162 최신 develop-ai 병합 충돌 해결

- origin/develop-ai 70c839c의 접수 완료 후 자동 종료 변경을 작업 브랜치에 병합했다. 충돌은 worklog.md 끝의 기록 추가 부분 1곳이며, 양쪽 기록을 모두 보존했다. 팀원 코드와 사용자 프롬프트는 수정하지 않았다.
- 정책·페르소나·입력 제한·RAG 프롬프트·통화 서비스·통화 흐름 회귀 테스트 98 passed, 13 warnings / 16.01초. git diff --check 통과. 실제 모델·실통화 검증 및 develop-ai 병합은 수행하지 않는다.

## 2026-11-05 — 관제페이지 글씨 크기·통화 상태 표시 개선
- 사용자 요청으로 develop-ai에 origin/develop-ai af62245 병합. 로컬 문서 커밋 2개를 보존했고, worklog 끝의 추가 기록 충돌은 양쪽 내용을 모두 유지해 해결했다.
- monitor/static/index.html: 가운데 받아쓰기 말풍선 글씨를 18px에서 16px로 축소. 왼쪽 통화 목록에 active는 파란색 ‘통화중’, ended는 빨간색 ‘통화 종료’ 배지로 표시. accepting은 중립색 ‘연결 중’, 알 수 없는 상태는 기존 값 표시.
- 기존 SSE 갱신 흐름으로 종료 시 배지도 즉시 갱신. 외부 API·인증·통화 처리 로직 변경 없음.
- 검증: 기존 관제 테스트 5 passed. Node 실행으로 SSE active→ended 갱신, accepting·미지 상태 표시와 HTML 이스케이프 확인. git diff --check 통과. 제한 환경 pytest는 출력 없이 대기해 권한 확장 실행으로 검증 완료.
- 운영 URL은 웹 도구로 접근하지 못해 운영 화면의 시각 검증은 미수행. 서버 배포·원격 push는 수행하지 않음.
- 사용자 지시에 따라 Jira 이슈 번호 없이 design/monitor-readability 브랜치로 작업을 분리했다. develop-ai는 수정 전 최신화 병합 상태(5bb221d)로 복원하고, 수정 커밋 제목을 팀 규칙의 한국어 형식으로 정리했다.

## 2026-11-05 — 고객·기업 검색 API 서비스 토큰(AI_BUSINESS_TOKEN)

- BE 요청: POST /api/customers/context, POST /api/customers, PATCH /api/customers/{id}, GET /api/companies/search에 `Authorization: Bearer <AI_BUSINESS_TOKEN>`. 요청 본문·응답 해석·call_session_seq 헤더는 그대로. 페르소나·분석 API는 기존 토큰 유지, 쿠키는 보내지 않는다.
- GET /api/customers/{id}는 통화 흐름이 쓰지 않지만 요청 목록에 있어 `customer_detail`(200 data·404 None)을 토큰과 함께 추가(MockBackend도 같은 메서드). /api/customers/{id}/pins·addresses는 요청 범위 밖이라 토큰을 붙이지 않았다.
- 토큰 미설정이면 헤더 없이 호출하고 시작 시 경고(BE 인증 적용 전 배포 호환). 401은 gateway에서 `BE_AUTH_FAILED`(kind contract, 재시도 없음, 경보 로그)로 분류.
- .env.example·compose.yaml에 AI_BUSINESS_TOKEN 추가. 테스트: 5개 호출 헤더·상세 404·미설정·기존 토큰 분리·401 1회. develop-ai 병합 후 전체 **647 passed**.

## 2026-11-06 — 조회·취소 확인 결과에 주문 상태의 뜻을 서버가 함께 전달

- 브랜치 `fix/lookup-order-status-text`(develop-ai 20e7e12 기반). 통화 293에서 통화 267의 주문(orderSeq 97, COLLECTING)을 "현재 수거 진행 중"으로 잘못 안내. 원인: `_parcels`가 주문 상태 원문을 넘기고 `lookup_orders`·취소 확인(`_order_facts`)이 뜻 없이 모델에 전달, 지시문에도 조회 상태의 뜻이 없음(옛 `[status_names]`는 새 구조에서 빠짐).
- `app/tools/lookup.py`에 `ORDER_STATUS_TEXT`·`status_text` 추가, 조회 결과 orders와 취소 확인 cancel_target에 `status_text`를 붙임(`status` 원문은 유지). 문구는 BE 계약 기준, 사용자 결정: ACCEPTED = "접수 완료"만, 수거·배송 언급 없음, COLLECTING에 "결제 전" 언급 없음, 결제 완료도 말하지 않음(PAID = "접수 대기 중"), 모르는 상태 = "확인 필요".
- 표는 지시문이 아니라 서버 코드에 둔다: 다른 개발자가 수정 중인 지시문과 간섭하지 않게(사용자 결정, 코드 주석에 명시). 정책 단일 출처 원칙과는 어긋나므로 지시문 정리 후 옮길지 별도 결정.
- 테스트: COLLECTING 조회에 "접수 미완료", 7개 상태 전부 문구 있음, 수거·배송·결제 단어 없음, 모르는 상태, 취소 확인 결과. 전체 **649 passed**. BE API·응답 형식·취소 가능 상태 판정 변경 없음. 실제 모델이 status_text대로 말하는지는 실통화 미확인.

## 2026-11-06 — 고객 정보(성함·기본 주소) 자동 갱신, 주소 저장 동의 절차 제거

- 브랜치 `feat/auto-save-customer-info`(develop-ai c2a9661 기반). 사용자 결정: 기존 고객이 접수 중 보내는 분 성함·보내는 곳을 바꾸면 고객 정보도 PATCH로 갱신하고, 동의는 묻지 않는다. 기존 주소 저장 제안(보내는 곳 기본 주소·받는 곳 PIN)도 묻지 않고 자동 저장.
- `save_offer`(address_book.py): 보내는 분 성함(앞뒤 공백 제거)이 등록 이름과 다르면 `name` 추가. 저장 시점은 그대로 택배를 담을 때(되읽기 중에는 저장하지 않음).
- `BackendAPI.update_customer_address` → `update_customer(customer_seq, call_session_seq, fields)`: name·address를 PATCH /api/customers/{id} 한 번에(customers.md:30 "name·address 중 한 개 이상"). 헤더(call_session_seq·AI_BUSINESS_TOKEN)는 그대로. MockBackend도 같은 이름·검증(빈 이름·지원 외 필드 400).
- `ResultService.save_addresses`: PATCH 성공 뒤 통화 중 고객 정보(`customer.name`·`default_address`·`default_address_detail`) 갱신. 실패는 기존처럼 관측만.
- 동의 절차 제거: `address_consent`·`_save_pending`·Decision `save` 질문 세트·`[results].address_save`·parcel_added의 저장 질문 문장. business_rules.md는 "저장 여부를 묻지 않는다" 한 줄로 교체.
- 계약 차이: BE 문서(ai-call-follow-up.md)는 "AI가 고객 동의를 받은 경우에만 저장"이라 되어 있다. 사용자 결정으로 동의 없이 저장하며, BE와 공유 필요.
- 테스트: 성함 다를 때 name 대상, 이름+주소 한 번의 PATCH 본문, 담을 때 묻지 않고 저장·N2에 address_save 없음·more_parcels에 save 질문 없음. 전체 **648 passed**(교체 테스트 2→1). 실통화·실 BE 미확인.


## 2026-11-06 — 문의·조회로 시작한 통화가 접수 뒤 마무리를 못 하던 문제(업무 의도 고정)

- 브랜치 `fix/intent-lock-after-inquiry`(develop-ai 9765f25 기반). 운영 로그(11/5 23:42 자동 종료 배포 이후 21건) 점검: 접수가 들어간 11건 중 4건(8df5dd7f·6cb7ff73·7a77756f·b8f3795c)이 업무 의도 inquiry로 고정된 채 진행. 8df5dd7f는 "아니요 없어요"를 판정하지 못해 "접수 결과를 확인하고 있습니다"로 30초 멈춘 뒤 무음 종료(결과는 통화 뒤 전송). 6cb7ff73은 "제가 끊을까요?"에 AI가 "임의로 끊지 않는다".
- 원인: (1) `_business`가 의도가 비었을 때만 정해, 문의·조회 뒤 접수 도구를 불러도 의도가 그대로. (2) `decision_questions`가 정책 단계가 아닌 업무(inquiry·lookup·cancel·agent)에 질문 0개 → 끝내기·전환·더 없음을 못 들음.
- 수정: `_business`(live.py) — 접수 도구(record_fields·find_destination)가 오면 다른 업무 의도를 order로 바꾸고 관제에 "업무 전환" 기록. 접수 중 조회·문의 도구는 의도를 바꾸지 않음(기존). `decision_questions`(render.py) — inquiry·lookup·cancel·agent 단계에 collect 세트(switch: 끝내기·업무 전환)를 묻는다. Decision의 order 판정으로는 의도를 바꾸지 않는다(조회 중 받는 분 성함을 접수 정보로 오판할 위험).
- 테스트: 문의 의도에서 "끊어 주세요" → 마무리 인사 뒤 끊김, 네 업무 의도 모두 switch 질문·접수 도구 뒤 order 전환(readback 단계), 접수 중 조회·문의 도구는 order 유지. 수정 전 코드에서 두 테스트 실패 확인. 전체 **650 passed**.
- 남은 점검 항목(별도 작업): 확인 '네' 신뢰도 미달(CONFIRM_UNCLEAR) 때 Live에 알리지 않아 멈춤(b8f3795c), 마무리 중 Decision 반영·고객 발화 중 끊기, 끝내기 경로의 결과 미대기. switch 지시문은 "하던 접수와 다른 일"이라는 표현 그대로(접수 단계 판정에 영향 주지 않으려고) — 문의·조회 단계 판정 정확도는 실통화 미확인.

## 2026-11-06 — 상담 용어를 ‘발송 주소’로 통일

- `fix/dispatch-address-wording`(`develop-ai` 9765f25 기준, Jira 이슈 없음). 택배를 보내는 곳의 주소는 요청·재질문·되읽기에 ‘발송 주소’를 쓴다. 동·호수는 기존 문구로 묻는다.
- 고객이 ‘발송 주소’, ‘보내는 주소’, ‘보내는 곳’, ‘출발지’라고 말하면 발송 주소로 이해한다. `sender_address`·`sender_address_detail`, BE 주문의 `origin` 및 주소록 저장 데이터는 유지했다.
- 초안은 전체 테스트 648개, 문구 정리 후 상담 정책·도구·통화 흐름·BE 계약 테스트 93개 통과. 실제 통화 음성은 미확인.

## 2026-11-06 — 애매한 확인 답('네' 신뢰도 미달)에 다시 묻기

- 브랜치 `fix/confirm-unclear-reask`(develop-ai 1e1b8dd 기반, MR 318과 독립). 운영 통화 b8f3795c: 되읽기 뒤 "아 그렇게 접수해줘"가 confirm=yes 0.56(yes_min 0.7 미만) → 관문 CONFIRM_UNCLEAR로 확정하지 않으면서 Live에 아무것도 보내지 않음. AI는 "접수 진행 여부를 확인하겠습니다" 뒤 32초 멈췄고 무음 종료, 결과 INCOMPLETE NO_CONFIRMED_PARCEL.
- 수정(live.py `_on_confirm`): CONFIRM_UNCLEAR이면 확정하지 않고 기존 '다시 묻기'(N2 confirmation=ask_again + 되읽기 값)를 보낸다. 같은 발화로 위임이 돌고 있으면(고친 값의 되읽기가 따라옴) 묻지 않는다. 다른 관문 실패(되읽기 도중 '네'·내용 바뀜·통화 끝)는 그대로.
- `ask_confirm` 후속: 같은 내용이어도 다시 보낸다(again — 두 번째 애매한 답에도 멈추지 않게). 취소 확인 대기면 택배 되읽기 대신 cancel_target(받는 분·상태)을 준다(이전에는 받던 택배가 있으면 택배 되읽기를 줄 수 있었음). workflow.toml [results].confirmation에 cancel_target 함께 오면 취소 여부를 다시 묻고, 처리했다고 말하지 않는다는 문장 추가.
- 확인 기준(yes_min 0.7)은 바꾸지 않았다(정확도 우선).
- 테스트: 애매한 '네' 두 번 → ask_again 두 번·확정 없음 → 분명한 '네'로 확정, 취소 다시 묻기는 cancel_target. 수정 전 코드에서 두 테스트 실패 확인. 전체 **650 passed**. 실통화 미확인.

## 2026-11-06 — 택배 접수 물품 검증 경로 확인

- `feat/parcel-item-validation`(`develop-ai` 4878a08 기준). 접수 도구는 규격별 수량·물품 가액·기타 설명 길이를 검사한다. 박스 내용물은 별도로 기록하지 않고, FAQ 검색 결과는 물품 기록·확정 조건에 연결되지 않는다.
- 주소·결제 등 다른 조건을 채운 가상 접수에서 도구 호출부터 고객 확인 후 제출 본문 생성까지 확인했다. 현금을 기타 설명으로 저장하면 박스를 함께 입력해도 `INCOMPLETE / FARE_UNKNOWN`이다. 소형 박스 수량만 저장하면 `COMPLETE` 본문(4,950원)이 만들어진다.
- 상담 지침은 서류와 박스 규격을 받지만 FAQ는 기타 접수도 안내한다. 기타 포장과 박스 내용물의 제한을 구분해야 한다. 운영 통화의 도구 호출과 실제 주문 상태는 확인하지 않았다.

## 2026-11-06 — 전화 택배 접수 물품 검증 설계

- [설계서](architecture/parcel-item-validation-plan.md)에 전화 접수 규격 네 가지, 고객이 언급한 내용물의 검증, 이미 확인한 택배의 차단, 여러 묶음과 통화 종료 시 처리, 검증 사례를 정리했다.
- 배송 FAQ에서 일반 안내로 표시한 제한 항목은 서비스 적용 기준을 확인한 뒤 활성화하도록 설계했다. 서비스 코드는 수정하지 않았다.

## 2026-11-06 — 전화 택배 접수 물품 검증 구현

- 배송 FAQ의 취급금지·일반 제한 품목을 전화 접수 정책에 반영했다. 현금성 물품, 위험물, 살아 있는 동물과 동물 사체, 귀중품, 인화성 물질·가스, 냉장·냉동·부패성 물품, 운송 제한품을 분류한다. 배터리 단독 발송, 누수·완충 포장, 한 변 160cm·무게 30kg 초과는 각각 검사한다.
- 기존 record_fields와 통화 전사에 물품 검사를 연결했다. 내용물을 말하지 않은 서류·박스 접수는 그대로 진행한다. 금지·미확인 상태는 택배별로 관리하며 이미 확인한 묶음도 다시 확인하기 전에는 완료할 수 없다. 문의와 접수 검증을 지침에서 분리했다.
- 네 가지 전화 접수 규격으로 FAQ 원본을 정리했다. 주문 백엔드 계약은 변경하지 않았다. 운영에 등록된 FAQ와 실통화는 확인하지 않았다.
- 전체 AI 테스트 668개 통과. 금지 품목 전 분류, 조건별 재질문과 해제, 규격 경계, 문의·정정, 늦은 결과, 여러 택배, 모델 호출 누락 상태의 통화 종료를 검증했다.

## 2026-11-06 — 이미 채운 접수 항목의 반복 질문 방지

- Live 업무 지침에 현재 택배의 최신 서버 결과에서 missing 첫 항목만 묻고, valid 항목이나 응답 대기 중인 항목은 반복해서 묻지 않도록 보강했다. 정정, 서버 재질문, 되읽기·선택 확인은 기존대로 따른다.
- 정책 렌더링·페르소나·가상 통화 흐름 테스트 49개 통과. 모델 실통화는 확인하지 않았다.

## 2026-11-06 — 운영 통화 56c133c8 멈춤 분석(확인 대기 해제 뒤 '네'에 응답 없음)

- 통화 56c133c83d0e(08:50~08:59 KST, 배포 4878a08 = fix/confirm-unclear-reask 포함). 되읽기 뒤 "네, 근데 더 빨리는 안돼요"(confirm=not_answer 0.66) → "네, 그리고 승용차로 해주세요"(confirm=change 0.91) → 서버가 확인 대기를 해제(release, N1' cancelled_by_customer).
- 그 뒤 record_fields는 PICKUP_TOO_SOON(needs 있음)이라 확인 대기를 다시 열지 않았고, 다음 위임(ZRw971)은 함수 호출 없이 끝났다. Live는 서버 되읽기 없이 스스로 "…접수 내용 확인 부탁드릴게요. 이대로 접수할까요?"를 물었다(금지 항목 "서버가 확인 내용을 주기 전에 확정 질문하기" 위반).
- 고객 "네"(447초): pending이 없어 Decision에 confirm 질문 자체가 없었고(origin만 판정) 후속 알림이 없었다. Live는 확인 답을 서버가 처리할 것으로 보고 침묵(b8f3795c와 같은 양상) → "여보세요" 2회 뒤 43초 만에 고객이 끊음. 결과 INCOMPLETE NO_CONFIRMED_PARCEL.
- CONFIRM_UNCLEAR 수정(47bc9d5)은 이 경우를 덮지 못한다: 관문 이전에 pending이 없어 `_on_confirm`에 들어가지 않는다. 코드 변경 없음(분석만).
- 서버 통화 로그 114건 전수 조사(고객 발화 뒤 AI 발화 없이 15초 이상): 20건에서 발생. 같은 구조(Live가 서버를 기다리는데 서버가 아무것도 보내지 않음)의 유형: ① 확인 답 버림(56c133c8·28713d01 change 뒤 재되읽기 없음, 25317d3f·b8f3795c confirm=not_answer/UNCLEAR) ② 확인 밖 짧은 '네'가 Decision 타임아웃·신뢰도 미달(67d29fc5 인사 "네" 15초, 3001ee9e·339a7062) ③ 값 발화를 Live가 맡기지 않는데 서버 안전망 없음(03d23c97 19초 무이벤트, 0b1144e8) ④ 위임·RAG 지연(05cc6bc7 22초, cd39ecfa KB_UNAVAILABLE). 구 설계의 '위임 안전망'(flow.md delegate_wait_sec)은 새 app에 없음(grep 확인). 15초 지표는 고객이 연달아 말한 구간도 포함하므로 상한 추정.

## 2026-11-06 — 확인 대기가 풀린 뒤 되읽기를 다시 열기(운영 통화 56c133c8)

- 브랜치 `fix/readback-pending-reissue`(develop-ai 4878a08 기반). 원인: `change`로 확인 대기(pending)를 푼 뒤 record_fields가 거절(needs)이거나 도구 호출 없는 위임이면 대기가 다시 열리지 않음 → Live가 스스로 "이대로 접수할까요?"를 묻고 '네'는 Decision에 confirm 질문이 없어(pending 없음) 버려짐 → 무음.
- 상태(state.py): `awaiting_fix` — no·change로 대기를 푼 뒤 고친 값이 기록될 때까지 되읽기를 다시 열지 않는다(release가 켜고 record_fields가 값을 기록하면 끈다). 거절 직후 같은 내용을 되읽지 않게 하는 보호.
- live.py: ① 위임이 최종 완료(도구 미결 없음)되었는데 readback 단계·pending 없음·awaiting_fix 아님이면 확인 대기를 발급하고 ask_again 되읽기(N2)를 보낸다. 재질문·실패 결과(status≠ok)가 난 위임에는 얹지 않는다. ② readback 단계면 pending이 없어도 Decision에 confirm 질문을 넣고, yes·proceed(yes_min 이상)인데 pending이 없으면 확정하지 않고 발급 후 ask_again, no·change면 awaiting_fix. 시간 기반 감시 없음(사건 기반).
- record.py: NOTHING_CHANGED여도 pending 없음·awaiting_fix 아님이면 발급해 readback을 같은 결과에 담는다(별도 N2 턴 없이).
- 테스트: 56c133c8 재현(change → 수거 시각 거절 → 도구 없는 위임 → ask_again → '네' 확정), '아니요' 뒤 되읽기 반복 없음·정정 기록 시 새 되읽기, 도구 단위(같은 값 반복·release·awaiting_fix). 수정 전 코드에서 3개 실패 확인. 전체 **655 passed**. 실통화 미확인.
- 남은 위험: readback 단계에서 고객이 문의만 한 뒤 도구 없이 끝난 위임에도 되읽기를 다시 보낸다(정책 "다른 질문에 답했으면 '이대로 접수할까요?'로 끝낸다"와 일치, 같은 내용은 notify 중복 제거로 한 번만). assess.py:28 주석("수거 일시 VALID")과 코드(수집 필드만)가 다름 — 미수정.

## 2026-11-06 — 물품 검증 브랜치에 최신 develop-ai 반영

- 되읽기 대기 재발급과 택배 물품 차단을 함께 유지하도록 live.py와 record.py 충돌을 해결했다. 양쪽 작업 기록을 보존했다. 병합 후 전체 AI 테스트 671개 통과.

## 2026-11-06 — 관제페이지 실시간 발화 자동 스크롤

- 최신 develop-ai a6146c2에서 `fix/monitor-transcript-autoscroll` 생성. 가운데 받아쓰기가 맨 아래에 있으면 새 발화를 따라가고, 위로 올려 이전 발화를 읽는 중이면 위치를 유지한다. 다른 통화를 선택하면 최신 발화부터 표시한다.
- 기존 관제 테스트 5개 통과. Node에서 발화 추가, 이전 위치 유지, 맨 아래에서 자동 추적 재개, 발화가 그대로인 갱신, 통화 전환을 확인했다. 운영 화면은 검증하지 않았다.

## 2026-11-06 — 관제 화면·통화 기록 상세화(Decision 입출력·Backend 출력 문장·도구 인수/결과·전달 원문)

- 브랜치 `feat/monitor-call-log-detail`(develop-ai c9457cd 기반). 지금까지 기록은 Decision 요약 한 줄, 전달 앞 200자, 도구 인수 원문 문자열뿐이었고 Backend 모델이 낸 문장은 전혀 남지 않았다.
- session.py: `note(kind, text, data=None)` — 사건에 펼쳐 보는 상세를 붙인다. 기록 상한 200 → 3000(스냅샷은 최근 400). 스냅샷 전사에 시각 `t`.
- live.py: Decision(입력 문장·질문·답별 choice/confidence/확률·ms·단계·pending, 시간 초과·장애 때도 입력 남김), 위임 시작(id·target·response_id·offset·직전 고객 발화), 함수 호출 인수(dict), `response.output_item.done`의 message 문장(`Backend 출력`)·reasoning 요약(`Backend 추론 요약`), 응답 끝 상태·error·incomplete_details·usage·위임 경과, 도구 카드에 위임 id·call_id·인수 dict·끝난 시각·Live에 실제로 넘긴 결과, 전달 N1'/N2/N3 원문 전체.
- main.py: 통화 기록 파일에 `backend_calls`·`timings`·`stats` 추가.
- 관제 화면: 가운데 칸 `대화`/`타임라인` 전환(받아쓰기·Decision·위임·Backend 출력·도구·전달을 시간순, 종류별 색), 사건·도구 상세 펼치기(다시 그려도 펼친 상태 유지).
- 테스트: 흐름 테스트 1개 추가(Decision 입력·확률, 위임 메타, Backend 출력·추론 요약, 도구 인수·결과, usage, 전달 원문, 스냅샷 전사 시각). app·monitor 테스트 426 passed, 3 failed(로컬 `data/address.db` 스키마가 옛것이라 lifespan 기동 실패 — 변경 전에도 같은 실패). 화면 JS는 `node --check`와 Node에서 타임라인 순서·이스케이프·중복 제거·펼침 유지만 확인, 브라우저 실화면 미확인.
- 확인 안 된 것: Responses 위임에서 sideband `response.event`로 message·reasoning 항목이 실제로 오는지(SDK 주석은 "세부 출력 이벤트로 받으라"고만 함). 오지 않으면 `Backend 출력`이 비어 있고 나머지 기록은 그대로다. reasoning 요약은 Backend 요청에 summary 설정이 있어야 나온다.

## 2026-11-06 — Live 업무 규칙 중복·충돌 검토

- 작업 트리의 `business_rules.md`를 기본 페르소나, `workflow.toml`에서 생성한 상담 절차, 위임 지시문, 통화 처리·도구 코드와 대조했다. 기존 인사 중 끼어들기 수정은 유지했다.
- 첫 인사 뒤 접수 질문, 되읽기 중 상담원 연결·종료 판단, 접수 완료 단계의 추가 문의, 상세주소 되읽기, 최근 출발지 확인, 상담원 권유 기준에 차이가 있다. 질문 순서·결과 신호·수거 범위·안내 문구는 한 곳에서 관리할 후보로 분류했다.
- 프롬프트와 코드 변경 없이 검토만 진행했다. 운영 페르소나와 실통화는 확인 범위에 포함하지 않았다.
- 정책·최근 출발지·매뉴얼 연속 미답변 테스트 22개 통과. 확대 테스트는 실행 환경에서 완료 결과를 얻지 못해 중단했다.

## 2026-11-06 — Live 업무 규칙 정리 및 통화 흐름 수정

- 인사 중 고객의 용건을 먼저 받고, 접수 정보를 수집하는 동안에만 최신 `missing`을 따르도록 정리했다. 수거 범위, 재질문, 연락처 확인, 서버 결과별 안내는 자동 생성 절차에 모았다. 고정 인사·마무리 문구와 전화 응대 예시는 업무 규칙에 뒀다.
- 되읽기 단계에 업무 전환 판정을 추가했다. 연결·종료 요청이 같은 발화의 접수 확인보다 우선한다. 기본 주소만 인사에 포함하고, 최근 출발지는 접수가 시작된 뒤 확인한다.
- 정상 접수 마무리는 결과 안내 뒤 인사하고 서버가 종료하는 흐름으로 정리했다. 상세주소는 고객이 직접 말하고 서버가 되읽기에 넣어 준 경우에만 읽도록 명시했다.
- 관련 테스트 164개, 전체 AI 테스트 690개가 통과했다. 기본 샌드박스에서는 Windows asyncio의 로컬 루프백 초기화가 멈춰 해당 제약을 풀고 가짜 통화 환경에서 테스트했다. 운영 페르소나와 실통화는 검증하지 않았다.

## 2026-11-06 — 사용자 수정 업무 규칙과 주변 코드 재검토

- 사용자 작업본을 기준으로 자동 생성 절차와 서버 결과를 대조했다. 개인 주소록 후보 이름표에 저장된 상세주소가 들어갈 수 있음을 재현했고, 접수 확인을 다시 요청하는 서버 결과에 수거 시각이 빠진 경로와 SIP 연결 대상 미설정 시 별도 콜백 등록이 없는 분기를 확인했다.
- 질문 순서, 수거 기본 안내, 요금, 마무리 인사, 상담원 상태별 멘트의 중복은 자동 생성 쪽에서 줄일 수 있다. 물품 검증·서버 재질문·선택 확인이 일반 수집 질문보다 앞선다는 지시는 유지할 대상이다.
- 정책 생성·인사 주소·상세주소 되읽기 테스트 23개 통과. 업무 규칙과 실행 코드는 검토만 했다.

## 2026-11-06 — 타인 번호로 접수한 택배 조회 안내

- Live 보안 규칙에 현재 통화의 발신번호로 접수한 내역만 조회하고, 다른 사람의 번호로 접수한 내역은 접수 여부와 배송 상태도 공개하지 않는다는 지시와 고객 안내 문구를 추가했다. 조회 도구는 통화 세션으로 조회하며 다른 발송인 번호를 인자로 받지 않는다.

## 2026-11-06 — 다른 번호·다른 고객의 접수 조회 거절(운영 통화 c156341e)

- 분석: 이여름 님(010****2446)이 오전에 김일 님(010****5701, 멈춤 통화 56c133c8, 주문 119 COLLECTING)이 접수한 택배를 찾음. 조회는 BE 통화 번호(call_session_seq) 범위라 남의 주문은 원래 보이지 않는데, ① '김일'을 받는 분 필터로 넣어 0건 ② 다른 번호를 불러 주자 번호 인자 없이 본인 주문 2건(COLLECTING)을 받아 "그 번호로 접수된 건이 두 건"이라고 잘못 안내 ③ "접수 완료된 택배는 조회가 되지 않아요"라는 근거 없는 말로 끝남.
- 결정(사용자): 다른 번호의 접수 기록은 조회할 수 없어야 하고 '다른 고객의 접수 정보는 안내드릴 수 없음'을 안내한다.
- 브랜치 `fix/lookup-other-customer`. `lookup_orders`에 `other_customer`(다른 전화번호·다른 사람이 접수한 택배를 찾으면 true) — true면 BE를 부르지 않고 `rejected`·`ORDER_OTHER_CUSTOMER`·`scope`(안내 문구). 모든 조회 결과(0건·1건·여러 건)에 `scope`(지금 전화한 번호로 접수된 택배만)를 실어 본인 주문을 다른 번호의 결과처럼 말하지 않게. policy/ 안의 시스템 프롬프트는 고치지 않는다(사용자 지시). 도구 설명·인수 설명(코드, Live 'Backend tools'·Backend 함수 스키마에 렌더링)은 허용 범위라 같은 범위 문구로 바꿈.
- 고객 범위 자체는 그대로 BE 헤더(call_session_seq)가 강제한다(외부 계약 변경 없음).
- 테스트: 도구 단위 1개 추가(다른 고객 거절·상태 불변·남의 주문 안 보임·범위 사실). app·monitor·backend_client 487 passed, 3 failed(로컬 address.db 스키마 — 이전과 같음). 실통화 미확인: 모델이 `other_customer`를 실제로 켜는지, '김일 님이 접수한 거'처럼 접수자를 이름으로만 말할 때(번호 언급 없음)는 false로 불러 0건 + scope로 안내될 수 있음.

## 2026-11-09 — Jira 175 배송 초안 연동 재적용

- 리버트된 `develop-ai`(`b72842a0`)에서 고객이 확인한 택배를 통화 중 즉시 `READY`로 저장하고, 통화 종료 후 백엔드가 `READY` 건만 하나의 주문으로 묶도록 연동했다. 저장 응답을 받기 전, 확인 완료, 필수 정보 부족을 구분해 안내한다.
- 기존 조회 도구에서 이번 통화의 배송 초안과 기존 주문을 함께 조회한다. 이번 통화의 초안만 수정·취소 대상으로 삼고, A를 확인한 후 B만 취소하면 A만 주문에 포함한다. 응답 유실 시 같은 초안 ID로 재시도한다.
- 재적용 당시 전체 AI 테스트 702개 통과. 당시 배송 초안 설정은 꺼져 있었다. 실제 백엔드와 실통화는 검증하지 않았다.
- 후속 확인에서 리버트 전 175번 병합(`7b1a665f`)의 배송 초안 설정이 `true`였음을 확인하고 복원했다. 설정 복원 후에도 전체 AI 테스트 702개가 통과했다. 실제 백엔드를 쓰는 환경은 `AI_BUSINESS_TOKEN`이 필요하다.

## 2026-11-09 — Jira 178 확인한 택배 접수 안내

- 운영 통화에서 고객 확인과 `READY` 저장은 한 번 처리됐고, 두 차례 조회 결과에 포함된 통화 종료 문구를 상담원이 반복했다. 이 구간에는 N3 정정이 없었다.
- 백엔드가 `READY`로 확인한 택배의 첫 안내에서만 “택배가 접수됐습니다”를 허용한다. 조회는 “이번 통화에서 접수된 택배”로 안내하고 통화 종료 문구는 조회 결과에서 제거했다.
- 전체 AI 테스트 703개, 최종 프롬프트 관련 테스트 97개 통과. 기존 주문의 `ACCEPTED` 조회 문구는 현재 통화의 주문 완료 여부를 보는 기존 검사와 충돌할 수 있다. 변경 후 실통화는 검증하지 않았다.

### 조회에서 선택한 택배의 정보 전달

- 여러 후보를 구분할 때는 이름표를 쓰고, 택배를 고른 뒤에는 선택한 택배의 상태와 백엔드에서 받은 안내 가능 항목을 한 번에 넘긴다. 한 건만 조회되면 같은 결과를 바로 준다.
- 기존 주문과 이번 통화 초안 모두 조회 응답에 이미 있는 정보를 사용한다. 선택 뒤에 새 백엔드 호출을 하지 않는다. 발송 주소와 받는 곳 주소는 기본 주소만 넘긴다.
- 전체 AI 테스트 703개 통과. 변경 후 운영 실통화는 검증하지 않았다.

### 발송 주소와 상세주소 표현 정리

- 상담원 안내는 발송 주소와 받는 곳 주소로 구분한다. 고객이 말한 출발과 도착 방향을 각각 대응하는 항목에 기록한다. 방향을 말하지 않으면 직전 주소 질문을 따르고, 그래도 불분명하면 다시 확인한다.
- 상세주소 질문에는 먼저 항목명만 사용한다. 고객이 무엇을 말해야 할지 모를 때 건물 이름·동·호수를 예로 든다. 이미 기록한 다른 발송 주소에 저장된 상세주소가 붙지 않도록 자동 입력을 제한한다.
- 전체 AI 테스트 704개 통과. 변경 후 실통화는 검증하지 않았다.

### 물건 이름으로 박스 후보 제안

- 첫 물품 질문은 “어떤 물품을 보내시나요?”로 안내한다. 고객이 규격과 개수를 직접 말하면 기존 수량 기록을 사용한다. 물건 이름만 듣고 제안할 근거가 있으면 박스 후보를 임시로 보관하고 고객에게 확인한다. 크기나 개수가 애매하면 소형·중형·대형과 개수를 직접 확인한다.
- 후보 동의는 최종 접수 확인과 별도로 판단한다. 고객이 동의한 뒤 기존 물품 기록을 실행한다. 직접 정정한 값과 금지 품목·포장 조건 검증이 후보보다 우선한다.
- 전체 AI 테스트 707개 통과. 변경 후 실통화는 검증하지 않았다.

### 제한 품목의 문맥 구분

- 제한 단어가 감지되면 실제로 그 품목을 보내는지 고객 발화에서 확인한다. 다른 물건 이름에 들어간 단어라면 같은 발화에서 그 구절에 해당하는 보류만 해제한다. 다른 구절이나 앞선 발화의 제한 근거는 유지한다.
- 냉장·냉동고 자체는 냉장·냉동식품으로 분류하지 않는다. 실제 제한 품목이 함께 언급된 경우와 규격 초과는 별도로 검사한다.
- 제한 단어가 들어간 물건 이름, 실제 제한 품목의 동시 언급, 이전 보류 유지, 규격 초과를 자동 테스트에서 확인했다. 전체 AI 테스트 711개 통과. 변경 후 실통화는 검증하지 않았다.

### 주문·PIN·FAQ API에 AI_BUSINESS_TOKEN 인증 헤더 추가 (2026-11-09)

- 요청 목록 12개(GET·POST /api/orders, GET·PATCH /api/orders/{id}, POST /api/orders/{id}/cancel·parcels/cancel·submit, GET /api/customers/{id}/addresses, GET·POST /api/customers/{id}/pins, PATCH /api/pins/{id}, GET /api/ai/faqs)에 기존 `_business_headers()`로 `Authorization: Bearer <AI_BUSINESS_TOKEN>`을 붙인다. 토큰이 비어 있으면 기존처럼 헤더 없이 보낸다.
- call_session_seq·Idempotency-Key·요청 본문은 그대로 유지한다. FAQ 조회는 통화 헤더 없이 Bearer만 보내며 AI_FAQ_TOKEN은 쓰지 않는다.
- 클라이언트에 없던 5개(PATCH 주문 수정, 전체 취소, submit, PIN 목록, PIN 수정)는 계약 문서(order-update·order-cancel·order-submit·pins.md)대로 메서드를 추가하고 MockBackend에도 둔다. 현재 통화 흐름은 이 5개를 부르지 않는다.
- 전체 AI 테스트 707개 통과. 실제 백엔드(배포 전·후)에서의 헤더 수용 여부는 검증하지 않았다.

### Jira 178 브랜치 최신화

- `develop-ai`의 `6bfaaa4e`를 반영했다. 작업 기록에 두 브랜치의 변경 내용을 함께 남겼다. 반영 후 전체 AI 테스트 714개 통과.

## 2026-11-09 — 주소 분리·수사 변환 서버 이관 재적용(feat/address-detail-split-v2)

- 배경: `feat/address-detail-split`(efc3ffd5..5beecda6, P13)은 763fdbdf로 병합됐다가 되돌림(4704d18d, develop-ai를 f9e2ca35로)에 함께 빠졌다. `origin/develop-ai` 위에 스쿼시로 다시 올렸다. 주소 모듈(`app/address/*`, `integrations/address.py`, `scripts/evaluate_address.py`, `tests/test_address.py`)은 되돌림 뒤에도 브랜치 베이스와 같아 그대로 적용됐고, 충돌은 `policy/backend_rules.md`(develop-ai의 발송·받는 곳 방향 규칙은 유지, 분리·숫자 변환 블록만 교체)와 worklog뿐.
- 브랜치 그대로 가져오지 않은 두 가지(모두 `tools/record.py`):
  - 결정 2(같은 도로의 번호 정정 때 상세 유지) 폐기 — 같은 날 사용자 결정(de083008, 역시 되돌림에 빠짐)대로 기본주소가 바뀌었는데 상세를 같이 말하지 않으면 비우고 다시 묻는다(`was != value`, `_road_of` 삭제). 서버가 문장에서 뗀 상세가 같이 오면 지우지 않고 그 상세로 바꾼다.
  - 서버가 뗀 상세의 출처를 RESOLVER → CUSTOMER로. `assess.readback_facts`는 `_address_detail`을 CUSTOMER가 아니면 "저장된 상세"로 보고 되읽기에서 빼므로, 고객이 방금 말한 상세주소(건물 이름·동·호수·층)가 확인 문장에서 빠지는 버그였다. 이제 되읽기가 상세주소 값 전체를 읽는다.
- 최적화 시도(별도 커밋): `resolve_detail`이 같은 후보를 `correct`로 두 번 보지 않게(`resolve(first=)`), `AddressDB.is_dong`은 `areas.dong`에 색인이 없어 토큰마다 전체 탐색이던 것을 전국 동 이름 집합 1회 적재로. **같은 기기에서 A/B 측정 결과 차이 없음**(v3 warm p50 30.0 → 30.4ms, p95 313.6 → 359.8ms; v1 warm p50 15.1 → 14.2ms — 모두 잡음 범위). 지연의 실제 주범은 못 찾았을 때 되읽기(`readings` 8묶음, 1초 상한)로 가는 사례(warm max 1.3초)이며 이번 범위 밖.
- 측정(로컬 DB만, 이 기기): v3 기본주소 48/49(남은 1건은 말실수 holdout b17)·오답 0·상세 52/52·변환 17/17, v1 106/106, v2 48/55 — 브랜치 당시와 같다. 절대 지연은 브랜치 기록(v3 warm p50 14.6ms)보다 2배쯤 크지만 브랜치 원본 코드도 이 기기에서 같은 값이라 환경 차이. 결과 `evaluation/results/address_v3_detail_s3.json`(중간 산출물 JSON 5개는 가져오지 않음). 동시 52건 한꺼번에 돌리는 구간은 예산 2.5초를 넘겨 "시간 초과" 경고가 찍히며 이전 측정과 같다.
- 테스트: app·backend_client·monitor 511 passed. test_tools의 결정 2 테스트를 de083008 버전으로 교체하고 서버가 뗀 상세가 같이 오는 경우를 추가.
- 미확인·후속: 운영 Backend가 새 규칙대로 한글 그대로 넘기는지는 실통화 확인 필요(숫자로 넘겨도 서버는 받는다). Live가 위임 결과 전에 missing을 보고 상세를 먼저 묻는 타이밍은 별도 안건. 상세 실존 검증 없음. push·MR은 지시 때까지 보류.

## 2026-11-09 — Jira 178 물품 포장 정정 처리

- 운영 통화에서 물건 이름을 지원하지 않는 포장으로 분류한 뒤 포장 정정을 받아도 보류가 남아 다음 박스 후보가 저장되지 않는 흐름을 확인했다.
- 포장 제한은 고객이 말한 실제 포장 근거를 확인해 적용한다. 지원 박스로 정정하거나 기존 포장으로 보낼 물품을 명시적으로 제외하면 해당 택배의 포장 제한을 해제한다. 발화에 남은 다른 포장 제한과 금지 품목·치수·무게 검증은 계속 적용한다.
- 저장된 박스 후보만 상담에서 제안한다. 물품 이름의 포장 오분류, 포장 정정, 다른 제한 유지, 신발 후보 확인 후 가액 질문을 자동 테스트에서 재현했다. 최신 `develop-ai` 반영 후 전체 AI 테스트 722개 통과. 변경 후 실통화는 확인하지 않았다.

## 2026-11-10 — Jira 178 되읽기 중 접수 확인과 마무리 인사

- 11월 9일 운영 통화에서 명확한 접수 지시가 되읽기 완료 관문에 막혔고 정정 메시지가 통화 종료 안내와 저장 질문을 유발했다. 고객이 다시 동의한 뒤 해당 택배는 `READY`로 저장됐다. 마무리 요청 뒤에는 “네, 없습니다”만 말하고 종료됐다.
- 현재 택배의 되읽기가 시작된 뒤 명확한 접수 지시가 나오면 기존 확인 내용의 일치 여부와 새 발화·위임을 검증해 저장한다. 짧은 동의와 주문 변경은 기존 관문을 거친다. `READY`가 확인된 택배만 접수됐다고 안내하며 정정과 마무리에 통화 종료 후 처리 안내를 넣지 않는다.
- 마무리 요청 뒤 감사와 끝인사 전체가 전사됐는지 확인한다. 인사가 빠지면 한 번 다시 요청한다. 응답이 끝내 없을 때의 종료 상한을 유지한다. 전체 AI 테스트 722개 통과. 운영 실통화는 확인하지 않았다.

## 2026-11-10 — Jira 178 서류와 박스의 혼합 접수

- 운영 통화에서 서류 10개가 기록된 뒤 신발의 박스 후보가 무시되고, 이후 소형 박스 수량만 기록되면서 서류가 빠졌다.
- 물품 수량은 변경한 규격만 반영한다. 추가는 기존 수량에 합산하고, 제외는 해당 규격을 0으로 전달한다. 합산 결과에 서류 수량과 박스 합계 제한을 적용한다.
- 기존 물품이 있어도 추가 박스의 후보를 확인할 수 있다. 규격이 모호하면 기존 수량을 보존하고 추가 규격이 확인될 때까지 기존 되읽기와 최종 확인을 보류한다. 혼합 수량의 되읽기·`READY` 저장·같은 통화 조회를 포함한 전체 AI 테스트 724개 통과. 변경 후 운영 실통화는 확인하지 않았다.

## 2026-11-10 — Jira 176 서류 전용 접수와 대략적인 물품 가액

- 서류만 보내면 가액 질문과 되읽기를 생략하고 서버가 접수 값에 총 1원을 넣는다. 조회 안내에도 서류 전용 자동 1원은 포함하지 않는다.
- 혼합 접수는 서류와 배송비를 뺀 물품 합계만 받는다. 고객이 “10만 원 안 될 것 같아요”처럼 말하면 기준으로 말한 100000을 정수로 넘기도록 Live와 Backend 규칙을 맞췄다.
- 추가 박스 확인이 시작되면 이전 물품 합계를 새 구성에 적용하지 않는다. 박스를 확정하기 전에 새 합계를 들었으면 이어서 쓰고, 박스를 모두 빼면 서류 전용 1원을 다시 적용한다. 전체 AI 테스트 726개와 최종 프롬프트 관련 테스트 53개 통과. 변경 후 운영 실통화는 확인하지 않았다.

## 2026-11-10 — Jira 178 첫 인사의 접수·발송 주소 확인

- 운영 통화에서 첫 “네”의 Decision 응답이 1초 제한을 넘겨 적용되지 않았고, 상담원이 서버 확인 전에 보내는 분 성함을 다시 물었다.
- 첫 접수 질문의 명확한 동의는 서버에서 처리한다. 음성으로 읽은 주소가 등록 주소와 일치하면 기존 보내는 분 성함과 발송 주소를 채운다. 새 주소에서 보낸다는 뜻이 명확하면 성함을 사용하고 새 발송 주소만 받는다. 판단이 늦거나 불분명하면 미확인 용건을 한 번 확인한다.
- 운영 로그의 첫 인사에서 숫자를 읽은 길 번호도 등록 주소와 대조되는 것을 확인했다. 받는 곳 주소 조회와 최종 접수 동의를 포함한 전체 AI 테스트 731개 통과. 변경 후 운영 실통화는 확인하지 않았다.

## 2026-11-10 — Jira 178 확인 질문 뒤 명확한 접수 지시 처리

- 10시 46분 운영 통화에서 주소를 정정하고 “이대로 접수할까요?”까지 물었지만, 고객의 “접수해 주세요”가 proceed로 분류돼 첫 문장 검사에서 막혔다. 재질문 도중 짧은 동의도 보류돼 종료 결과가 `NO_ORDER`였다.
- 마지막 접수 확인 질문을 끝까지 한 뒤 명확한 접수 지시가 나오면 proceed도 동의로 처리한다. 되읽기 도중에는 실제로 전달된 현재 확인 내용의 ID를 AI 발화에 연결해 판단한다. 내용 변경, 취소 동의, 짧은 맞장구는 별도로 처리한다.
- 도구 되읽기와 서버 재질문에 같은 연결 규칙을 적용했다. 확인 ID는 내부에서만 사용한다. 최신 `develop-ai`를 반영한 전체 AI 테스트 734개 통과. 변경 후 운영 실통화는 확인하지 않았다.

## 2026-11-10 — Jira 178 명시적인 동의와 보류된 확인 질문 복구

- 12시 12분 46초 운영 통화에서 “네, 그렇게 접수해 주세요”가 yes로 분류됐다. 되읽기 도중의 짧은 동의 규칙에 막힌 뒤, 같은 발화의 위임이 문장만 만들고 끝나면서 재질문도 누락됐다.
- 현재 되읽기 ID가 일치하면 yes로 분류된 답도 발화에 명시적인 접수 요청이 있을 때 진행한다. 같은 발화의 위임에서 값이 바뀌거나 정정 오류가 나면 기존 확인으로 확정하지 않는다.
- 확정할 수 없는 동의는 같은 발화의 위임이 끝난 뒤 현재 확인이 여전히 필요할 때 한 번 묻는다. 새 확인 내용이나 재질문이 이미 전달되는 경로에서는 중복 안내하지 않는다. 전체 AI 테스트 735개 통과. 변경 후 운영 실통화는 확인하지 않았다.

## 2026-11-10 — 접수 순서 변경·동 이름 확인·되읽기 간소화 (S15P31D109-164 재적용)

- 받는 순서: 보내는 분 성함 → 받는 분 성함 → 연락처 → 발송 주소 → 상세 → 받는 곳 주소 → 상세 → 물품 → 가액. `workflow.toml` stage를 sender / receiver / address(신규)로 나눔. 보내는 분 연락처는 발신번호 유지.
- 두 주소가 갖춰지면 `record_fields` 결과 `facts.confirm_route = {from, to}`(동 이름, geo 없으면 건물번호를 뺀 주소)로 한 번 확인. 서버 관문·Decision 추가 없음(confirm_area와 같은 프롬프트 전용 방식).
- 되읽기 `readback_facts(snapshot)`는 성함·동 이름만. 문구는 반드시 질문으로 끝남("이대로 접수할까요?", G3 관문이 직전 발화의 질문 여부를 봄). 스냅샷·전송 값은 그대로.
- 대시보드 이탈 단계: address 단계는 빠진 첫 항목이 sender_면 SENDER_INFO, 아니면 RECIPIENT_INFO(계약 값 추가 없음).
- 최신 `develop-ai`(178 확인 흐름·181 자동 핀 확인 포함) 위에 다시 쌓음. 165(confirm_area)는 버림. 178의 `readback_id`와 명확한 접수 요청 처리는 유지.
- 미결정: 발송 주소가 고객 정보로, 받는 곳 주소가 핀으로 채워져 `record_fields`를 거치지 않으면 confirm_route가 나가지 않는다(되읽기에서는 동 이름이 나온다).
- 테스트: `uv run pytest -q` → 737 passed.

## 2026-11-10 — 주소록 후보를 고른 뒤 받는 곳이 비는 문제

- 운영 통화에서 받는 분 성함으로 핀 3건이 제시됐고 고객이 지역 이름으로 하나를 골랐다. Decision pick은 확률 0.56·confidence 0.45로 하한 0.6에 걸렸고, Live 모델이 같은 선택을 `find_destination(name, place)`로 넘겼지만 서버는 1건으로 좁혀진 후보를 다시 needs_choice로 제시만 했다. 모델은 서술형으로 "확인했습니다" 하고 넘어가 pick이 성립할 질문이 없었고, address 단계에서 받는 곳 주소를 다시 요구하다 고객이 끊었다(NO_ORDER).
- `find_destination`: 이미 제시한 destination 후보 집합 안에서 정확히 1건으로 좁혀지면 `apply_pick`으로 바로 기록하고 `ok`/`DEST_PICKED`로 돌려준다. 제시된 후보가 없을 때의 1건은 지금처럼 확인을 거친다.
- `offer_destination`: 후보 1건 결과에 "질문으로 확인한다" guidance를 붙인다(`record_fields` 경로의 guidance는 그대로).
- Decision pick 하한·비교값(confidence → p(choice))은 이 커밋에서 바꾸지 않는다. 11-08 이후 통화 69건의 pick 판단 83건 중 후보 선택 11건, 하한 미달 2건(p 0.56·0.65), 오적용 0건. 별도 작업(그림자 측정 2단계)에서 pick 전용 설정값으로 다룬다.
- 참고: `find_destination`의 ok 결과는 `record_fields`와 달리 즉시 intake 동기화를 하지 않는다(기존 `DEST_NEW_RECEIVER`와 같음). 다음 `record_fields`에서 동기화된다.

## 2026-11-10 — Live 지시문의 위임 정책을 페르소나 바로 뒤로

- 배경: 운영 통화에서 Live가 받는 분 성함 등 값을 받고도 위임하지 않아 서버에 기록이 남지 않는 일이 이어졌다. 위임은 Live 재량이라 API로 강제할 수 없고, 서버 안전망은 이중 위임 위험으로 채택하지 않았다(사용자 결정 2026-11-10).
- 변경: `render.render_delegation`으로 "백엔드에 맡기기"(Generate/Do not generate <|SpawnThinking|>, Backend tools, 대기 중 규칙)를 떼어 `render_live` 순서를 페르소나 → 위임 정책 → 업무 규칙 → 상담 절차 → 통화 정보로 바꿨다. 전에는 지시문 끝 쪽(상담 절차 안)이었다. 문구는 그대로이고 제목만 최상위(`#`)로 올렸다(옛 렌더 결과와 줄 단위 대조).
- 테스트: 블록 순서 단언 추가, 전체 AI 테스트 738 passed. 실통화 효과는 미측정.

## 2026-11-10 — 서버 질문에 답한 턴은 Backend 도구 호출이 Decision 반영을 기다린다

- 배경: 후보 선택 답에 Live가 위임하자 Backend가 Decision의 선택 반영(받는 분 4항목 기록)보다 먼저 시작해, 직전 도구 결과의 missing을 보고 이미 채워진 연락처를 다시 물었다. 위임은 OpenAI 쪽에서 Live가 시작해 서버가 시작 시점을 늦출 수 없다.
- 변경: 발화 끝에 서버 질문(후보·확인 대기·되읽기·출발지·박스 후보·콜백)이 열려 있으면 `Runtime.deciding` 이벤트를 두고, 그 턴의 모든 Backend 도구 호출이 Decision 반영까지 기다린다(상한 decision_budget_sec + 0.5초). 질문이 없는 턴은 기다리지 않는다.
- Backend 지시문: 서버 질문에 고객이 답한 턴은 기록할 값이 없어도 get_state를 먼저 불러 그 missing으로 다음 안내를 정한다.
- 테스트: Decision이 늦고 get_state가 먼저 와도 결과에 선택이 반영되는지(대기를 빼면 실패 확인). 전체 739 passed. 실통화 효과·추가 지연은 미측정(관제 구간 "도구→Decision 반영 대기").

## 2026-11-11 — 진행 중 주문 값을 고객이 물으면 서버 값으로 답하기

- 배경: Live가 받는 진행 중 택배 정보는 상태(`state_summary`)·후보 이름표뿐이라, 고객이 "받는 분 번호 뭐라고 했죠?"·핀 상세주소·연락처를 물으면 대화 기억으로 답하거나 답하지 못했다(핀 값은 서버가 모델에 주지 않음). 보정된 주소도 되읽기 전에는 Live가 모른다.
- 결정(사용자 2026-11-11): 발신번호 = 주소록 주인 전제로 핀 상세주소·연락처를 고객이 물으면 고르기 전 후보라도 알려 준다. 발신번호는 읽지 않는다. 스냅샷을 매번 append하는 방식은 쓰지 않는다(GPT-Live는 append한 맥락을 지우거나 바꿀 수 없고 append당 500토큰 — 공식 문서 확인).
- 변경: `get_state(include_values)` → `outcome.order_values`(현재 택배의 검증된 값과 출처, 제시 중인 받는 곳 후보 값). 기업 사원 배송지는 주소록 주인 전제 밖이라 연락처·상세주소를 넣지 않음. Live 위임 정책·Backend 규칙·업무 규칙에 "물으면 get_state 값으로, 기억으로 답하지 않음"을 넣음. 되읽기(`readback_facts`)·이름표는 그대로.
- 값 대조(측정만): AI 발화마다 말한 전화번호(10자리 이상)·호수를 서버 값과 대조해 없으면 통화 사건 "값 대조"와 경고 로그(번호는 가림, 호수는 개수만). 대화는 바꾸지 않음. 한계: 숫자 사이 조사("공일공에 …")는 놓치고, 기록 전 고객 값을 따라 말하면 불일치로 잡힌다.
- 미측정: Live가 실제로 위임하는 비율, 물을 때 추가 지연.

## 2026-11-11 — 첫 인사에서 보내는 분 정보 변경

- 기존 흐름은 인사에서 발송 주소를 말한 뒤에도 이름 변경에 대한 별도 처리 없이 기존 발송 주소를 다시 확인했다. 주소를 바꾸겠다는 답에는 받는 분 정보가 먼저 나올 수 있었고, 새 보내는 분 성함이 등록 이름과 다르면 자동 갱신 대상으로 잡혔다.
- 변경: 새 성함을 들었으면 다시 묻지 않는다. 주소 선택이 남았으면 이미 안내한 주소를 되풀이하지 않고 발송 주소도 바꿀지만 묻는다. 주소만 변경하면 새 발송 주소부터 받는다. 새 값이 첫 답에 함께 들어오면 서버의 변경 판단을 반영한 뒤 기록하고 도구 결과로 다음 질문을 안내한다.
- 등록 이름: 이번 택배에만 쓴다고 했으면 주문에만 기록한다. 범위를 밝히지 않았으면 등록 이름 변경 여부를 묻고, 동의한 경우에만 택배를 담을 때 기존 고객 정보 저장 경로로 갱신한다.
- 음성·Backend 프롬프트와 선택형 판단을 맞췄다. 가짜 통화 테스트에서 이름·주소의 재질문 방지, 기존 발송 주소 유지·변경, 등록 이름 저장 대상 여부를 검증했다. AI 전체 테스트 782개 통과. 실제 통화는 미검증이다.

## 2026-11-11 — 보내는 분 성함 변경 뒤 발송 주소 재질문 수정

- 사용자 실통화에서 이름만 바꾼 뒤 발송 주소 전체를 다시 물었다는 제보. 서버 코드에서 인사 주소 대조가 실패하거나, 고객이 인사에 먼저 동의한 뒤 다음 발화에서 이름 변경을 말하면 전용 분기를 놓치는 경로를 확인했다. 두 운영 통화의 로그는 확인하지 못했다.
- 인사에서 주소를 말했는지와 저장 주소 대조 성공 여부를 따로 기억한다. 받는 분 정보를 받기 전의 후속 이름 변경도 처리하고, 선택형 판단에서 변경을 놓쳐도 도구가 실제 새 이름을 기록할 때 전용 흐름을 적용한다.
- 주소 선택이 남았을 때는 서버가 “발송 주소도 바꾸시겠어요?” 한 문장만 내보내고 일반 누락 목록에서 발송 주소와 상세를 숨긴다. 그대로 쓴다고 하면 저장 주소를 사용한다. 바꾸겠다고 답하면 이전 주소와 상세를 비운 뒤 새 주소를 받는다.
- 음성·Backend 프롬프트가 서버 질문을 그대로 사용하도록 맞췄다. 주소 받아쓰기가 다른 경우, 인사 동의와 새 이름이 다른 발화에 들어오는 경우, 변경 판단을 놓쳐도 새 이름을 기록한 경우를 통화 재생 테스트에 포함했다. AI 전체 테스트 784개 통과.

## 2026-11-11 — 새 발송 주소 기록을 마친 뒤 받는 분 질문

- 운영 통화 `18ecdae3`와 `104381a9`에서 기존 발송 주소를 쓰지 않는다는 판단은 있었지만 주소 변경 질문이 다음 항목으로 지정되지 않았다. 음성 AI가 주소 기록 결과 전에 받는 분을 물었고, 뒤이어 기본주소를 기록한 경우에도 상세주소는 비어 있었다.
- 주소 선택이 남으면 최초 안내와 상태 조회가 같은 발송 주소 확인을 전달한다. 기존 주소를 쓰지 않는다고 판단하면 별도 변경 분류가 없어도 새 기본주소를 먼저 받는다. 변경이 끝날 때까지 질문 목록에는 필요한 발송 항목만 두고, 기본주소가 기록되면 상세주소가 있는지 확인한다.
- 음성 AI는 고객이 준 주소를 기록에 맡기고 결과를 기다린다. 상세주소를 함께 말하거나 없다고 답한 경우에는 그 답을 기록해 재질문을 줄인다. 먼저 들어온 받는 분 정보는 보존하고 자동 주소록 후보와 경로 확인은 발송 주소 기록 뒤에 처리한다.
- 통화 재생 및 도구 테스트에서 별도 변경 분류 없는 주소 변경, 주소 확인 실패, 기본주소와 상세주소의 개별·동시 입력, 상세주소 없음, 받는 분 정보 선제공과 주소록 후보 처리를 확인했다. AI 전체 테스트 788개 통과. 변경 후 실통화는 미검증이다.

## 2026-11-11 — 새 주소를 바로 답한 경우와 상세주소 첫 질문

- 운영 통화 `9f254f87`에서 고객이 변경 여부에 새 발송 주소로 답했다. 새 기본주소는 기록됐지만 별도 주소 변경 판단이 없어 서버는 등록 이름 확인으로 넘어갔다. 뒤이어 음성 AI는 받는 분 성함을 물으려 했다는 말을 하고, 상세주소 첫 질문에 건물 이름·동·호수 예시까지 붙였다.
- 기존 주소 확인에 주소 값으로 답하면 기록 도구가 같은 주소인지 새 주소인지 판단한다. 같은 주소는 기존 상세를 유지한다. 새 주소는 상세를 기록하거나 상세가 없다는 답을 받기 전까지 발송지 변경 흐름을 유지한다. 기본주소 검증에 실패해도 같은 발화에서 받은 새 상세는 보존한다.
- 일반 접수와 주소 변경 모두 서버에서 같은 첫 상세주소 질문을 준다. 예시는 고객이 되묻거나 답하기 어려워할 때만 사용한다. 음성·Backend 지시문은 다음 질문이 정해지면 이전에 하려던 질문이나 순서 변경 설명을 덧붙이지 않고 바로 묻도록 맞췄다.
- 기존 주소 유지, 상세를 함께 말한 새 주소, 기본주소 실패 뒤 재입력, 발송지와 받는 곳의 공통 상세 질문을 테스트했다. AI 전체 테스트 793개 통과. 변경 후 실통화는 미검증이다.

## 2026-11-11 — 보내는 분 이름 동의와 받는 곳 질문 순서 정리

- 미등록 고객의 최초 등록 조건과 저장 경로는 유지했다. 등록 고객의 보내는 분 성함은 접수 도중에 바뀌어도 등록 이름 변경에 동의해야 고객 정보 저장 대상이 된다. 이번 택배에만 쓰겠다는 말을 이름과 함께 하거나 먼저 한 경우도 처리한다. 동의 뒤 성함을 다시 고치면 새 성함에 대한 범위를 확인한다.
- 발송 정보 확인 중에 일반 기록이나 별도 주소록 검색에서 찾은 받는 곳 후보는 현재 택배에 보류한다. 발송 확인을 마치면 후보를 제시한다. 이전 택배나 이전 검색의 결과가 늦게 오면 폐기한다. 후보 이름표의 내용은 이번 범위에 포함하지 않았다.
- 새 받는 곳을 기록할 때 상세주소의 미입력과 명시적인 없음을 구분한다. 상세주소 숫자 정리는 기존 기록 도구와 같은 함수를 사용한다.
- 신규 등록 후 이름 정정, 기존 고객의 적용 범위 답변과 재정정, 발송 정보 입력 중 후보 보류와 늦은 검색 결과, 상세주소 미입력·없음·값 입력을 검증했다. AI 전체 테스트 804개 통과. 실제 전화 통화는 미검증이다.

## 2026-11-11 — 발송 주소 확인의 짧은 동의와 받는 분 이름 응답

- 운영 통화 `bc1a4f4e`에서 등록 주소를 읽은 첫 인사에 “아 네”라고 답했으나 짧은 동의 처리에서 빠졌다. 이어진 “네” 세 번은 각각 기존 주소 사용으로 분류됐지만 판단 점수 0.30으로 기준 0.60을 넘지 못했다. 받는 분 이름 응답은 기록 도구가 받는 분으로 처리했지만 선택형 판단에서 보내는 분 성함 변경으로 분류돼 기존 보내는 분 성함이 지워졌다.
- 주소가 일치한 첫 인사의 짧은 동의를 보강했다. 서버가 발송 주소 확인을 기다리고 실제 직전 질문이 그 주소에 대한 확인일 때 분명한 짧은 동의를 바로 반영한다. 뒤에 주소 변경 요청이나 다른 용건이 붙은 말은 선택형 판단으로 처리한다.
- 받는 분 이름 질문에 답할 때 보내는 분을 직접 언급하지 않으면 선택형 판단만으로 기존 이름을 비우거나 저장 범위를 바꾸지 않는다. 실제 보내는 분 변경 요청과 새 성함의 기록은 이어서 처리한다.
- 전체 AI 테스트 810개 통과. 최종 발화 변형을 포함한 집중 테스트 42개 통과. 변경 후 실통화는 미검증이다.

## 2026-11-11 — 일반 접수에서도 발송 주소를 받은 뒤 받는 곳 후보 안내

- 일반 접수와 발송 주소 변경에서 기본주소와 상세주소가 기록될 때까지 두 도구가 찾은 받는 곳 후보를 현재 택배에 보류한다. 상세주소가 없다는 답도 기록 완료로 처리한다. 보류 중에는 최신 서버 결과로 필요한 발송 주소를 묻고, 후보가 없을 때는 일반 수집 순서를 따른다.
- 발송 주소를 받는 중 시작한 검색에 일치하는 후보가 없으면 고객이 말한 받는 분 성함을 보존한다. 이후 이름을 정정하거나 다른 택배·업무로 넘어간 경우 늦은 검색 결과를 폐기한다.
- 음성·Backend 프롬프트와 도구 계약에서 후보를 안내하는 시점을 서버 동작에 맞췄다. 후보 이름표, 검색·선택 방식, 주문 조회·취소와 외부 API 계약은 유지했다.
- 두 도구의 후보 보류·재개, 검색 결과가 없을 때 이름 보존, 이름 정정·택배 전환·주문 조회 뒤 늦은 결과 차단을 검증했다. 전체 AI 테스트 816개 통과. 운영 실통화는 미검증이다.

## 2026-11-11 — 주소록 후보에서 받는 분과 주소를 따로 변경

- 개인 주소록·이전 도착지 후보에서 주소만 바꾸면 이름·연락처를 유지하고, 받는 분만 바꾸면 기본주소·상세주소와 주소 검증 정보를 유지한다. 주소 변경 시 이전 상세주소와 주소 검증 정보는 비운다.
- 유지할 항목이 모호하면 먼저 확인한다. 같은 발화에서 새 값도 들었으면 서버가 후보 선택을 반영한 뒤 기존 기록·검증 절차로 처리한다. 발송 주소 변경이나 다른 택배 수정으로 혼동하지 않도록 서버 처리와 프롬프트를 맞췄다.
- 부분 변경 중에는 받는 곳 후보 검색을 건너뛰고 새로 필요한 항목만 받는다. 일반 후보 선택, 기업 후보 정보 노출, 주문 조회·취소와 외부 API 계약은 유지했다.
- 두 변경 유형의 통화 재생, 모호한 답 확인, 같은 발화의 새 값 기록, 주소 검증 실패 후 재입력과 기존 조회 선택을 검증했다. 전체 AI 테스트 822개 통과. 운영 실통화는 미검증이다.

## 2026-11-11 — 받는 곳 부분 변경 재질문과 접수 조회 상세주소

- 운영 통화에서 “그분에게 그대로 보내지만 주소는 다르다”는 판단이 `new_address_1`로 나왔으나 점수 0.46이 공통 기준 0.60 미만이었다. 받는 분 전화번호가 채워지기 전에 새 주소가 기록되며 기존 후보가 사라졌다.
- 단일 주소록 후보를 실제로 확인하는 질문에 명확하게 답하면 서버가 부분 변경을 반영한다. 범위가 모호하면 한 번 확인하고, 먼저 말한 새 값은 현재 후보에 묶어 두었다가 답에 맞춰 검증한다. 일반 후보 선택과 공통 판단 기준은 유지한다.
- 기존 주문과 이번 통화에서 접수한 택배가 공통으로 사용하는 조회 변환에서 `detailAddress`를 발송 상세주소·받는 곳 상세주소로 전달한다. 선택된 택배의 주소를 요청한 경우에 안내한다. 후보 목록, 취소 안내, 배송 요청 사항과 전화번호 노출 규칙은 유지한다.
- 실제 상담 발화와 0.46 판단, 두 부분 변경 방향, 확인 전에 들은 값과 늦은 주소 검증, 기존 주문과 이번 통화 접수 조회를 테스트했다. 전체 AI 테스트 824개 통과. 운영 실통화는 미검증이다.

## 2026-11-11 — 받는 곳 변경 의사와 주소 값 구분

- 운영 통화에서 백엔드 모델이 “이번에는 다른 주소”를 주소로 넘겼다. 받는 분 확인 뒤 재처리한 주소 검증이 시간 초과되어 원문이 기본주소에 기록됐고, 상세주소 질문으로 넘어갔다.
- 받는 곳 후보 확인·주소 변경에서 주소 검색이 값을 확인하지 못하면 도로명·법정동과 번호가 있는 입력만 기존 원문 보존 경로로 보낸다. 변경 의사만 담긴 문구는 기본주소를 다시 받는다. 검색이 확인한 건물명과 수사로 말한 실제 주소는 기존 주소 검증을 사용한다.
- 같은 받는 분임을 나타내는 표현과 배송지 변경 표현을 함께 판단한다. 범위가 모호하면 후보 이름으로 확인하고, 서버가 보낸 그 질문에 대한 답을 반영한다. 일반 접수의 주소 검증, 발송 주소 변경, 주문 조회·취소는 기존 흐름을 사용한다.
- 운영 발화 재생, 주소 검증 시간 초과와 변경 의사 변형, 실제 수사 주소·건물명 입력, 이름을 넣은 확인 질문을 포함해 전체 AI 테스트 838개 통과. 운영 실통화는 미검증이다.

## 2026-11-11 — 같은 주소의 다른 받는 분을 후보에서 제외

- 새 받는 분을 기록한 뒤 `find_destination`에 주소만 전달하면 해당 주소의 다른 수신인을 후보로 제안하고, 반복 검색에서 기존 수신인의 이름·연락처를 넣는 것을 재현했다.
- 일반 기록과 별도 검색 모두 현재 받는 분 이름이 있으면 일치하는 개인 주소록·이전 도착지 후보만 검색한다. 이름을 먼저 받은 새 수신인은 일반 수집 흐름을 따르고, 주소를 먼저 받은 경우의 후보 확인은 유지한다. 검색 인자가 기록된 이름과 다르면 고객이 말한 정정 내용을 기록 도구로 받는다.
- 주소 보정, 기업·부서를 명시한 검색, 발송 주소 우선순위, 기존 후보 이름표와 선택 방식을 유지했다.
- 이름을 먼저 받은 뒤 기존 주소를 말하는 두 도구 경로, 반복 검색, 주소를 먼저 받은 흐름, 같은 이름의 후보 선택을 검증했다. 전체 AI 테스트 845개 통과. 운영 실통화는 미검증이다.

## 2026-11-11 — 접수 뒤 추가 요청 확인과 마무리 인사

- 운영 통화에서 접수 동의 발화에 붙은 `get_state`가 확정 전 상태를 반환해 접수 결과 미확인 안내가 먼저 나왔다. 저장 뒤 추가 질문 알림은 진행 중인 위임을 기다리다 늦어졌다. 별도 통화에서는 종료 알림의 `order.pending`을 상담원이 통화 후 처리 안내로 풀어 말했다.
- 순수 접수 동의는 서버 판단을 기다린다. 같은 발화의 불필요한 상태 조회는 대기 상태만 반환하고, 새 정보·정정이 있다면 기존 확인 관문이 기록과 확정을 대조한다.
- 확인한 택배 뒤에는 추가 택배와 다른 도움을 함께 묻고, 추가 택배·용건 확인·업무 전환·종료 답을 처리한다. 마무리 인사에는 주문 결과나 내부 처리 절차를 보내지 않는다. 백엔드 저장과 통화 종료 후 결과 처리 순서는 유지했다.
- 11월 12일 최신 develop-ai를 반영한 뒤 전체 AI 테스트 849개 통과. 실제 저장 실패 시 상담원 연결 제안을 유지했다. 운영 실통화는 미검증이다.

## 2026-11-11 — 주소 보정과 카카오 검색 동시 시작

- 운영 통화 기록 276건에서 주소 기록 123건 중 8건이 주소 처리 예산 2.5초를 넘겨 들은 원문(상호명 7건, 수사 지번 1건)이 접수용 정보 없이 기록됐다. 같은 컨테이너에서 단독 측정하면 상호명은 로컬 보정이 다시 보기 상한까지 써서 1.1~1.3초 뒤 못 찾고, 카카오 검색은 50~300ms였다. 통화 중에는 CPU 부하로 로컬 보정만으로 예산을 다 써 카카오가 호출되지 않았다.
- 키가 있으면 카카오 키워드·주소 검색을 로컬 보정과 동시에 시작한다. 결과는 기존과 같이 로컬이 못 찾았거나 약할 때만 주소DB로 검증해 쓰고, 상세주소를 뗀 경우에는 기존처럼 기본주소로 다시 검색한다. 로컬 확정이 강하면 결과를 버린다. 예산·타임아웃·세마포어·시간 초과 처리와 도구 결과 계약은 유지했다.
- 카카오 검색 호출이 주소 처리마다 2건으로 늘어난다(무료 일 100,000건).
- 로컬 0.3초 + 카카오 0.3초를 예산 0.5초 안에 끝내는 겹침 테스트(이전 코드에서 실패 확인), 강한 로컬 결과를 카카오가 덮지 않는지 검증했다. 전체 AI 테스트 839개 통과. 운영 실통화는 미검증이다.

## 2026-11-12 — 건물명·상호명으로 찾은 주소의 상세주소에 이름 붙이기

- 번호 없이 건물명·상호명으로 기본주소를 확정하면 기본주소에는 도로명주소를, 상세주소 앞에는 검색이 찾은 이름을 붙여 기록한다("국회의사당 3층", 상세주소가 없다고 하면 이름만). 보내는 곳·받는 곳 모두 적용한다.
- 이름은 고객 발음이 아니라 검색 결과(주소DB 건물명, 카카오 장소명)를 쓴다. 카카오 장소 검색은 (도로명주소, 장소명)을 돌려주고, 번호로 찾은 주소에는 같은 자리의 상호를 붙이지 않는다.
- 택배 초안에 역할별로 (찾은 기본주소, 이름)을 두고, 상세주소를 기록할 때 기본주소가 그대로일 때만 붙인다. 같은 호출에서 기본주소와 상세주소를 함께 받으면 주소 반영 뒤에 붙이고, 이미 이름으로 시작하는 상세주소에는 다시 붙이지 않는다. 받는 곳 검색의 새 받는 분 경로도 같다.
- 보내는 곳 상세주소는 고객 정보의 기본 상세주소로도 저장되므로 이름이 함께 저장된다. 도구 필드와 BE 계약은 유지했다.
- 주소DB 건물명·카카오 장소명 전달, 번호 주소·되묻기 제외, 따로·같이 받은 상세주소, 중복 방지, 상세 없음, 주소 변경 뒤 미적용을 검증했다. 전체 AI 테스트 848개 통과. 운영 실통화는 미검증이다.
## 2026-11-11 — 지시문의 내부 동작 용어 정리와 택배 한 건 접수 안내 오탐 수정

- 운영 통화에서 Live가 위임할 때마다 "맡겨볼게요"라고 말했다. 결과를 기다리는 동안 하는 말은 예시 없이 즉석으로 만들게 되어 있고, 지시문은 위임 동작을 '맡기다'로만 불렀다(26회). 그래서 내부 동작 용어가 고객 응대 표현으로 나왔다. 발화를 금지하지 않고 지시문 원본에서 '맡기다'를 지웠다. 위임 규칙은 `<|SpawnThinking|>` 생성으로, 업무 규칙과 결과 해석은 기록·검증·검색 요청으로, Decision은 "고른다"로 바꿨다(`render.py`, `business_rules.md`, `workflow.toml`). 규칙의 뜻은 유지했다.
- 같은 통화에서 AI가 draft_intake=ready에 맞춰 "택배 한 건 접수됐습니다"라고 말했다. 그런데 허용 문구 정규식이 "택배가 접수됐습니다"만 받아 확인되지 않은 결과 문구로 판정했다. 이어진 정정 지시 때문에 AI가 "주문 접수 완료가 아니라 택배 한 건 담아 둔 상태"라고 말을 번복했지만, 실제 접수 결과는 ACCEPTED였다. 정규식에 "택배 한 건(이)·택배 접수됐습니다"를 추가했다. 두 건 이상은 계속 잡는다.
- `parcel_added` 해석에서 draft_intake가 없을 때 "담아 두었다고 안내"를 "택배 정보를 확인했다고만 안내"로 바꿨다.
- 판정용 사본 `call_analysis/ai_rules.md`(b209e7cd 기준)와 설계 문서는 바꾸지 않았다. 관리자 페르소나(BE promptText)에 같은 용어가 있는지는 확인하지 않았다. 전체 AI 테스트 822개 통과. 변경 후 실통화는 미검증이다.

## 2026-11-12 — 접수 요청과 완료 사이의 중간 발화 제거

- 요구: 고객이 접수를 요청하면 접수 완료 뒤 "접수했습니다"만 말한다. 요청과 완료 사이에 "접수하겠습니다", "확인 중입니다", "아직 확인되지 않았어요" 같은 접수 여부 발화를 하지 않는다.
- 운영 통화 276건 중 문구 검사 N3 26회를 보니 '접수·결제' 판정은 대부분 오탐이었다. 504(표현이 패턴 밖), 7ce91f3e(허가 표시 시점 어긋남), 조회 결과의 "결제 완료" 읽기가 그 예다. '진행하겠' 정정은 그 자체가 "사실이 아니에요" 같은 중간 발화를 만들었고 다시 걸리기도 했다. 정규식 문구 검사(`READY_RECEIPT`·`unverified_claims`·`forbid.claims`·`claim_skip`), 발화별 허가 표시(`ready_notice`), N3 전달 경로와 `n3_max` 설정을 제거했다. 같은 날 앞 커밋에서 넓힌 정규식도 함께 없어졌다.
- 출력 발화를 Decision으로 분류하는 대안은 S0c 결정(출력 전사 감시 제거)과 충돌하고, 정정 발화를 남긴다는 점에서 요구와도 맞지 않아 쓰지 않았다.
- 담기 확정 뒤 BE 저장을 1.5초만 기다리던 것을 저장 완료까지(상한 `draft_receipt_wait_sec` 5초) 기다리게 바꿨다. 결과는 완료(ready → "접수했습니다. 더 보내실 택배가 있으세요?"), 실패 또는 시간 초과(failed → "접수 중 문제가 생겨 접수를 마치지 못했습니다." + 상담원 연결 제안), 정보 부족(not_ready) 중 하나로만 알린다. `draft_intake=pending` "확인 중" 안내 규칙은 없앴다.
- 지시문: Live 위임 규칙에 "되읽기 확인에 동의하거나 접수를 요청하면 '네.'만 받고 서버 결과를 기다린다"를, 금지 항목과 업무 규칙(접수 안내)에 "결과 전 접수 여부 발화 금지"를 넣었다. Backend 지시문에는 확인 턴에 "네."만 돌려주도록 했다. 주문 접수 완료(ACCEPTED)와 취소 완료에도 서버가 정한 문장을 두었다.
- 유지: 되읽기 질문이 끝나기 전의 "접수해 주세요"에 다시 확인하는 G3 동작, 번호·호수 값 대조(기록만). 설계 문서(overview·delegation·workflow-policy·call-lifecycle)에 제거 사실을 적었다.
- 전체 AI 테스트 845개 통과(develop-ai 최신 반영 후, 저장 실패 시 실패 안내 + 상담원 제안 테스트 추가). 지시문 효과(Live가 실제로 확인 턴에 말을 덧붙이지 않는지)는 실통화에서 확인해야 한다.

## 2026-11-12 — 서류 배송비를 10개 단위로 계산

- 택배마다 서류 1~10개에는 기존 단가를 한 번, 11~20개에는 두 번 부과한다. 초안 저장과 기존 결과 제출에 공통 계산을 적용한다. 접수 요청의 서류 실제 수량과 박스 개당 요금은 유지했다.
- 배송비 경계값, 혼합 규격, 초안 및 접수 요청 본문을 검증했다. 전체 AI 테스트 855개 통과. 운영 접수는 미검증이다.

## 2026-11-12 — 주소록 선택 직후 받는 분 안내

- 주소록 선택 후 받는 분을 보내는 주체처럼 말한 운영 통화를 확인했다. 선택 결과는 받는 분 이름과 지역을 별도 항목으로 전달한다. 지시문은 이름을 말할 때 받는 분으로 표현하고, 이미 확인한 내용은 생략할 수 있도록 했다.

## 2026-11-12 — 접수 질문 전달과 최근 택배 조회

- 접수 시작, 발송지 응답, 받는 곳 선택 후 서버의 다음 질문을 같은 경로로 전달한다. 같은 발화의 도구가 동일한 질문 단계와 항목을 이미 전달했다면 별도 안내를 생략한다. 기존 주소 확인과 되읽기 관문은 유지했다.
- 조회 범위를 이번 통화에서 확인한 택배, 같은 고객의 가장 최근 기존 접수, 이미 선택한 택배로 구분했다. 한 건이면 상세를 바로 제공하고, 여러 건이면 받는 분·접수 시각·지역으로 구분할 수 있게 한다. 다른 고객 범위와 취소 절차는 유지했다.
- 전체 AI 테스트 858개와 최종 집중 테스트 17개가 통과했다. 운영 실통화는 미검증이다.

## 2026-11-12 — S15P31D109-188 받는 분 연락처 보정

- 한글 숫자와 말끝을 보존해 서버에 전달한다. 서버는 끝 `이요`의 두 해석을 검사하고 번호를 하나로 고를 수 있을 때 그 숫자를 읽도록 전달한다. 같은 발화의 전사와 도구 입력이 말끝만 다르면 전사를 다시 검사한다. 끝 네 자리 정정은 서버에서 현재 택배 번호에 합친다.
- 정정이 모호하면 기존 번호를 보존하고 접수와 현재 번호 조회에서 보류한다. 배송 초안과 일반 접수 경로 모두 보류 상태를 반영한다. 모델이 자릿수를 보고 서버 검증을 생략하거나 앞자리까지 추측해서 합치던 규칙을 정리했다.
- 백엔드 모놀리식과 MSA의 배송 번호 검증식에 맞춰 받는 분의 지역번호·070을 초안 완료 조건에 반영했다. 백엔드에서 거절되는 대표번호는 수령인 입력에서 제외했다. 백엔드 API 경로와 요청 필드는 그대로 사용한다.
- 백엔드 번호 검증식과 각 7,000개 입력의 결과가 일치했다. 일반 번호의 서버 변환만 반복 측정한 결과 중앙값은 2.81µs에서 5.84µs, p95는 2.92µs에서 6.93µs였다. 운영 음성 인식 정확도와 응답 지연은 실통화에서 확인해야 한다.
- 최종 AI 테스트 878개 통과. 가짜 통화에서 끝자리 누락, 번호 읽기, 정정 보류를 확인했고 배송 초안에서 서울 유선번호 저장과 모호한 정정 뒤 편집 상태 전환을 검증했다.

## 2026-11-12 — 주소 처리 예산 3초
- 운영 통화에서 숫자를 한글로 말한 발송 주소의 로컬 보정이 2.5초 예산을 넘었다. 그래서 들은 값이 위치 정보 없이 기록됐다. 초안 저장 모드는 발송지 위치 정보가 있어야 신규 고객을 등록하므로 등록이 생략됐고, 결제 방식이 비어 접수가 미완료로 끝났다.
- 주소 처리 예산(`AddressService.budget_sec`)을 2.5초에서 3초로 늘렸다. `record_fields`를 감싸는 도구 예산(`ToolContext.tool_budget_sec`)도 3초에서 3.5초로 늘렸다. 주소 예산과 같으면 주소가 늦을 때 도구 전체가 `TOOL_TIMEOUT`이 되어 들은 값조차 기록하지 못하기 때문이다. 도구 예산을 쓰는 최근 택배 조회의 읽기 예산(×0.8)은 2.4초에서 2.8초가 됐고, 받는 곳 변경 재기록과 Decision 대기 상한도 0.5초 늘었다.
- BE API와 도구 필드는 바꾸지 않았다. 늘어난 예산 안에서 그 주소가 실제로 풀리는지는 운영 통화에서 확인해야 한다.

## 2026-11-12 — 음성 주문 취소 확인 흐름

- 방금 조회한 택배에 대한 취소 요청은 대상 확인으로 바로 이어진다. 새 취소 조회는 이번 통화와 직전 통화의 범위를 적용한다. 거절·실패·새 조회가 이전 선택을 다시 취소 대상으로 만들지 않게 한다.
- 택배 한 건, 기존 주문 전체, 현재 통화 초안을 구분한다. 서버가 대상과 범위가 담긴 취소 질문을 전달하고 고객 동의 후 기존 백엔드 취소 API를 호출한다. 같은 발화에서 시작된 조회와 확인 판단의 실행 순서를 맞췄다.
- 백엔드 API와 결제 상태·소유권 확인은 기존 계약을 따른다. 실제 전화의 모델 판단과 음성 응대는 별도 확인이 필요하다.
- 최종 AI 테스트 882개 통과. 가짜 통화에서 최초 취소 조회, 한 건·주문 전체 실행, 확인 전 응답과 다른 대상 질문 거절, 확인 답변과 겹친 조회를 검증했다.

## 2026-11-12 — 통화 중 등록 고객의 접수 안내 누락 수정, 백엔드 전송 = 접수 완료

- 원인: 미등록 고객이 통화 중 등록되면 BE 기본 주소가 `origin_place`로 들어오고 `origin_offered`가 켜진다. 담기 뒤 current가 비면 `origin_confirmation`이 다시 살아나 단계가 `address`가 되고, `notify`의 `stage != "more_parcels"` 조건에 걸려 접수 결과 N2가 버려졌다(운영 통화 2건, 고객이 "접수됐나요" 물을 때까지 침묵).
- `origin_confirmation`: 담은 택배가 있으면 발송 주소 확인을 묻지 않는다.
- 사용자 결정: 백엔드에 전송된 주문은 접수 완료로 안내한다. `ORDER_STATUS_TEXT`의 notPaid·PAID·SUBMITTING → "접수 완료". ready 안내 문구를 "접수했습니다. 더 보내실 택배가 있거나 다른 도움이 필요하신가요?"로.
- 테스트: 회귀 테스트 추가(수정 전 `address`로 실패 확인), 전체 575 passed.
- 추가(사용자 결정): 통화로 주문을 마쳐 BE에 전송된 주문은 결제 여부와 상관없이 접수로 본다. `ACCEPTED_STATUSES`(ACCEPTED·notPaid·PAID·SUBMITTING)를 `domain/state.py`에 두고 `result_accepted`(intake·results), 조회 상태 문구, 조회 상세 "접수된 택배", 정책 `order` 안내에 적용. 제출 실패 상태는 제외. 테스트 575 passed.

## 2026-11-12 — 등록 이름 변경 동의 즉시 고객 정보 갱신

- 요구: 등록 고객이 보내는 분 성함을 등록 이름에도 쓰는 데 동의하면 택배를 담을 때까지 기다리지 않고 바로 PATCH /api/customers/{id}로 고객 정보를 갱신한다. 담을 때와 같이 주소도 포함한다.
- 변경: `LiveFlow._maybe_save_name` — `save_sender_name`이 켜지고 기록된 성함이 등록 이름과 다르면 기존 `ResultService.save_addresses`를 백그라운드 실행한다. 발송 주소가 상세까지 확정됐고 기본 주소와 다르면(`save_offer`의 sender) 같은 PATCH에 주소도 싣는다. 상세가 아직이면 이름만 보내고 주소는 담을 때 저장한다. 호출 지점은 서버 질문(ask_name_save)에 대한 동의 처리, `record_fields` 결과 처리(이름과 함께 등록 변경을 말한 경우)다. 같은 (이름, 주소, 상세)는 한 번만 보낸다(`Runtime.name_saving`). 성공하면 통화 중 고객 이름·기본 주소도 바뀌어 담을 때 저장 대상에서 빠지고, 실패하면 담을 때 기존 경로가 다시 시도한다. 저장 중에 담으면 같은 값의 PATCH가 한 번 더 나갈 수 있다.
- 유지: BE 경로·메서드·본문·헤더(call_session_seq·AI_BUSINESS_TOKEN). 이름 동의가 없으면 기본 주소는 기존처럼 담을 때 저장, 받는 곳 PIN은 항상 담을 때 저장.
- 테스트: 질문 뒤 동의, 이름과 함께 등록 변경 요청, 확정 발송 주소가 있는 동의(PATCH 1회에 이름·주소) 세 경우에 담기 전 BE 고객 정보가 바뀌는지(수정 전 실패 확인). 전체 582 passed. 운영 실통화는 미검증.

## 2026-11-12 — 택배 접수 질문 순서 복원

- `7006af5c` 직전 순서에 맞춰 보내는 분 성함·발송 주소·상세주소를 먼저 받고, 받는 분 성함·연락처·주소·상세주소를 이어서 받는다. 발송 주소 확인·변경 중인 상태도 보내는 분 단계로 분류한다.
- 추가 택배는 직전 확인된 택배와 같은 발송 주소인지 먼저 묻는다. 동의하면 상세주소와 위치 정보까지 사용하고, 다른 주소라면 새 발송 주소를 받는다.
- 인사말 수정은 별도로 유지했다. 동 이름 확인, 최종 접수 확인, 백엔드 요청 형식은 기존과 같다.
- AI 전체 테스트 887개 통과. 실제 전화는 검증하지 않았다.

## 2026-11-12 — 백엔드 대기 멘트 제한

- `origin/develop-ai`의 `d546e567`에서 `fix/live-waiting-phrases`를 생성했다. Jira 번호는 사용자 확인에 따라 생략했다.
- Live 공통 프롬프트에서 백엔드 결과를 기다릴 때 안내가 필요하면 “네, 잠시만요.”, “확인해 보겠습니다.”, “잠시만 기다려 주세요.” 중 하나만 한 번 말하도록 했다. 대기 멘트에 고객 발화나 확인 질문을 덧붙이지 않도록 했다.
- 기본·운영 페르소나로 생성한 프롬프트에 같은 규칙이 들어가는지 기존 정책 테스트에서 검사한다. AI 전체 테스트 887개 통과. 실제 통화의 이상 음성 재현 여부는 검증하지 않았다.

## 2026-11-12 — '접수했습니다'는 BE가 READY로 저장했을 때만

- 운영 통화에서 BE가 초안 저장을 거절(403)해 `draft_intake=not_ready`였는데, 담기 알림에 항상 붙던 `followup_help=ask` 때문에 AI가 "접수했습니다"라고 안내했다.
- `followup_help=ask`는 `confirmed_status`가 `ready`(BE 응답 저장 결과 status=READY)일 때만 붙인다. 알림 직전 재확인에서 ready가 아니게 되면 뺀다. not_ready·failed 안내는 그대로.
- 테스트: not_ready 알림에 followup_help가 없음을 확인(수정 전 실패), 전체 583 passed.
- 추가(사용자 결정): BE가 저장을 거절하면(저장 결과 없음) 보낸 상태가 EDITING이어도 `confirmed_status`가 `pending`을 돌려 실패 안내 + 상담원 연결 제안으로 간다. 탈퇴 고객 403 사례가 "정보 부족"으로 안내되던 것을 막는다. BE가 EDITING으로 저장한 경우의 not_ready(정보 부족)는 그대로. 회귀 테스트 추가(수정 전 not_ready로 실패), 전체 584 passed.

## 2026-11-12 — 접수 동의의 직전 질문 검증

- `develop-ai`의 `4f769838`에서 `fix/parcel-confirmation-question`으로 작업했다. 접수 동의는 직전 AI 발화가 실제 접수 확인 질문이고 고객이 그 질문 끝에 답한 경우에 확정 관문을 통과한다.
- 되읽기 도중에는 해당 확인 건에 연결된 발화에서 고객이 실제로 명확한 접수 요청을 한 경우를 허용한다. `proceed` 판정만으로 짧은 맞장구나 정정이 섞인 요청을 확정하지 않는다.
- “맞으세요?” 같은 일반 확인 질문도 되읽기 발화의 연결 표시를 끝낼 수 있다. 이 질문에 대한 답은 접수 동의로 처리하지 않는다. 취소 확인 관문과 BE·PBX 계약은 유지했다.
- AI 전체 자동 테스트 888개 통과. 고객이 다른 질문에 답한 경우, 짧은 맞장구가 `proceed`로 분류된 경우, 명확한 접수 요청을 한 경우를 검증했다. 실제 전화는 검증하지 않았다.

## 2026-11-12 — 접수 확인 중 고객 끼어들기 우선

- Live 공통 지시에서 접수 확인 도중에도 고객이 말을 시작하면 문장 중간에서 멈추고, 고객의 정정이나 새 질문을 먼저 처리하도록 명시했다. 중단된 문장은 그대로 이어 읽지 않고 최신 서버 결과에서 필요한 내용만 안내한다.
- `workflow.toml`의 접수 질문 종료 조건은 고객이 끼어들지 않았을 때로 한정했다. 업무 규칙은 공통 끼어들기 규칙을 참조하고, 백엔드 지시도 고객의 최신 정정이나 질문을 우선한다.
- 접수 동의 확정 조건과 BE·PBX 계약은 유지했다. AI 전체 자동 테스트 889개 통과. 공통 제목을 명시한 뒤 정책·도메인 테스트 61개를 다시 확인했다. 실제 통화에서 발화가 멈추는 시점은 검증하지 않았다.

## 2026-11-12 — Decision 입력 맥락 보강

- 기준: 사용자 요청으로 develop-ai를 origin/develop-ai의 4f769838까지 fast-forward했다. 기존 worklog 변경은 별도 stash에 보존 후 충돌 없이 복원했다.
- 입력: 기존 질문·선지·모델·결과 적용 규칙은 유지한다. 질문 구성과 입력을 같은 잠금 안에서 생성하며, 서버 기록은 기존 업무와 질문에 필요한 이름·확인 종류·주소 후보 출처·후보 종류만 복사한다. 서버 기록에는 현재 발화가 이미 반영됐을 수 있고 고객이 질문을 들었거나 동의했다는 증거가 아님을 명시했다. 주소 후보가 없으면 출처를 추측하지 않는다. 상태 전체·고객 전화번호·주소·주문 상세를 직렬화하지 않는다.
- 대화: 현재 고객 발화 시작 전에 전사가 끝난 과거 발화만 화자와 시간 순서대로 추가한다. 직전 AI·현재 고객 발화는 중복하지 않고, 이후 발화·뒤늦게 완성된 과거 전사는 제외한다. 최근 최대 6개·본문 합계 3,000자이며 발화 중간을 자르지 않는다. 생략 여부와 직전 AI·고객 발화의 시간 겹침을 표시한다. 현재 답을 우선하며 과거 질문에 짧은 동의·거절을 임의 연결하지 않도록 했다.
- 검증: app/tests 기존 584개 및 신규 맥락 테스트 6개 통과(분할 실행). 신규 테스트는 상태 선별·개인정보 제외·원문 순서·시간 경계·입력 상한·없는 주소 후보·실제 judge 호출 입력과 기존 질문/모델 유지를 확인한다. 기존 langsmith asyncio.iscoroutinefunction deprecation 경고가 있다. BE/PBX 계약 변경 없음.
- 한계: 가짜 Decision 응답으로 흐름을 검증했다. 실제 API 분류 정확도·토큰 증가·1초 예산 내 지연은 미측정이며 실통화 전후 비교가 필요하다. 배포·원격 push는 하지 않았다.

## 2026-11-12 — 시계 분류 오탐 및 접수 확인 전 추가 질문

- 21:21:44 통화 588번(`291519f8`)에서 귀금속 여부에 대한 “아닙니다”가 금지품 규칙의 `condition_unmet`으로 들어와 `PROHIBITED_ITEM`이 됐다. 가액을 기록해도 `items`가 미완료여서 서버는 `readback`을 보내지 않았고, 백엔드가 접수 내용 확인 여부를 따로 물었다.
- 금지품 규칙에는 조건 충족·미충족 근거를 적용하지 않는다. 실제 제한 품목의 언급은 기존 보류·검증을 거친다. 도구 상태 요약에서 남은 물품 검증 사유를 유지하고, Live와 백엔드는 서버 `readback`이 있을 때 바로 접수 확인을 읽도록 했다.
- “시계 → 소형 박스 → 귀금속 아님 → 이십만 원” 순서와 실제 보석 시계가 계속 보류되는 경우를 자동 테스트에 넣었다. 전체 896개 통과. 마지막 문구·단언 변경 후 물품·정책 테스트 46개를 다시 확인했다. 운영 실통화는 검증하지 않았다.
- 후속 요청으로 마지막 필수값의 서버 결과에 `readback`이 있으면 같은 응답에서 보내는 분·발송 지역·받는 지역·받는 분을 요약하고 “이대로 접수할까요?”로 잇도록 했다. `workflow.toml`의 문구를 Live와 백엔드가 함께 사용한다. 정책·물품·접수 흐름 테스트 82개 통과.
- 특정 물품명 예외를 공통 판정 기준으로 바꿨다. 일반 물품명만으로 제한 대상인지 추가로 묻지 않으며, 명확한 부정만 있는 발화를 금지품 포함으로 분류해도 서버가 새 금지품을 기록하지 않는다. 실제 제한 품목 언급은 유지한다. 귀중품·위험물·냉동식품의 부정 및 실제 포함을 포함한 관련 테스트 85개 통과.


## 2026-11-12 — 조회 전환과 주문 후보 동시 선택 보존

- develop-ai를 origin/develop-ai 4fb99605로 fast-forward하고 fix/lookup-selection-on-mode-switch에서 수정했다. 기존 fix/decision-input-context의 미커밋 worklog 변경은 stash(preserve worklog before lookup selection fix)에 보존했다.
- 통화 #583: 접수 상태에서 후보를 고르는 발화가 조회 전환으로도 판정되면, 조회 선택을 해당 발화에 기록하면서 기존 업무 전환도 실행한다. 이미 조회 상태일 때만 중복 전환을 생략한다. 기존 scope=null → selected 보정과 새 검색의 선택 초기화 규칙은 유지했다.
- 회귀 테스트: 수정 전 접수→조회 경우에 lookup_selection 누락으로 실패, 수정 후 통과. 접수→조회·조회 중 선택(전환 있음/없음) 3가지에서 도구가 Decision보다 먼저 도착해도 선택한 주문 상세가 반환되고, 다음 발화의 다른 받는 분 검색은 새 주문을 찾는 것을 확인했다.
- 검증: ai/.venv/Scripts/python.exe -m pytest -q --tb=short 전체 902 passed, 14 warnings(기존 의존성 deprecation). BE/PBX 계약·프롬프트·조회 도구 변경 없음. 실제 모델·운영 통화 검증, 원격 push 및 배포는 하지 않았다.

## 2026-11-12 — 일반 수긍 뒤 Decision과 서버 안내 연결

- 기준: develop-ai를 원격 최신화하고 fix/decision-acknowledgement-flow에서 작업했다. 작업 중 다른 작업이 주 체크아웃을 전환해 별도 체크아웃 S15P31D109-ack-flow로 분리했으며, 새로 병합된 origin/develop-ai 7a08af55까지 fast-forward한 뒤 적용했다. 기존 주 체크아웃의 다른 작업과 .claude는 보존했다.
- 원인: 통화 #586의 조회 주소 안내 뒤 일반 수긍은 switch=none이 맞지만, 구체적인 확인·선택·전환 처리에 해당하지 않아 후속 안내가 없었다. 조회에 한정하지 않고 일반 수긍의 의미 판정은 Decision, 실제 진행·발화 여부는 서버가 담당하도록 정리했다.
- 변경: 기존 Decision 요청에 reply(acknowledge/confirmation/wait/help/other)를 추가한다. 수긍/help가 하한을 넘고 기존 후속 처리가 없을 때만 공통 N2로 안내한다. 접수 중에는 최신 summary의 다음 질문, 완료된 조회·문의·취소에는 추가 도움 질문, 대상이 없는 조회·미완료 취소는 현재 업무의 대상 질문, help에는 용건 질문을 전달한다. 조회·문의·취소·상담원 단계에서 추가 도움이 없다는 답은 switch=end로 기존 종료 경로를 따른다. Live는 일반 수긍만 듣고 독자적으로 다음 질문을 시작하지 않는다.
- 충돌 방지: 서버 업무 후속 처리·접수 저장·상담원 전환·대기 중 N2의 수명을 세고, 실제 송신 직전 확인 대기·최신 고객 발화·진행 중 위임·다른 업무/안내·이미 요청한 서버 발화·새 Live 발화를 다시 검사한다. 대기 상한을 넘어도 미완료 처리를 앞지르지 않고 수긍 안내를 폐기한다. 취소와 예외에서도 카운터를 해제한다. 기존 접수·취소·이름 저장 확인 관문, BE/PBX 계약, 모델·API 호출 횟수는 유지한다.
- 검증: 수정 전 일반 수긍의 다음 안내 누락을 확인했다. 전체 pytest 931 passed, 14 warnings(기존 의존성 deprecation). 별도 체크아웃에서 응답/맥락 테스트 35개 통과 및 검증한 소스와 동일성 확인. 신규 응답 테스트 29개는 여러 업무 단계, 확인/후보 대기, API 시간 초과/장애/낮은 점수, 새로운 고객 발화, 기존 Live/서버 발화, 미완료 위임, 서버 알림·업무 처리·상담원 전환 경합과 취소 시 정리를 검증한다.
- 한계: 가짜 Decision 응답으로 분기와 동시성을 검증했다. 실제 reply 분류 정확도·추가 토큰·지연 및 운영 음성 UX는 미측정이며 배포하지 않았다. API 실패·시간 초과·낮은 점수에는 일반 수긍으로 추정해 진행하지 않는다.

## 2026-11-12 — 발송 주소도 등록 주소 변경 동의를 받는다

- 사용자 결정: 보내는 분 성함과 발송 주소 모두 고객 정보를 바꾸기 전에 동의를 받는다. 동의하면 그 자리에서 PATCH /api/customers/{id}로 저장한다. 11-06 결정(발송 주소는 묻지 않고 담을 때 자동 저장) 중 발송 주소 부분을 대체한다. 받는 곳 주소록(PIN) 추가는 이번 범위가 아니어서 그대로 묻지 않고 담을 때 저장한다.
- 질문 시점: 등록 고객의 발송 기본주소와 상세주소가 기록됐고 등록 주소(기본주소·상세)와 다르면 `sender_change_next = ask_address_save`. 등록 주소가 없는 등록 고객도 묻는다. 문구는 "다음에도 이 주소에서 보내실 수 있게 등록 주소로 저장해 드릴까요?". 이름 질문(ask_name_save)이 남아 있으면 그 뒤에 묻는다. 답을 받을 때까지 받는 분 질문·받는 곳 후보·되읽기를 보류한다(기존 sender_change_next 규칙).
- 답 판단: Decision 질문 `sender_address_save`(yes/no/not_answer)를 서버가 ask_address_save를 기다릴 때만 넣는다. 동의·거절을 `ConversationState.sender_address_consent = (기본주소, 상세, 동의)`로 통화 단위로 기억한다. 같은 주소로는 다시 묻지 않고, 주소나 상세가 바뀌면 다시 묻는다.
- 저장: `LiveFlow._maybe_save_profile`(이전 `_maybe_save_name`)이 동의한 항목(이름·주소)만 한 PATCH에 싣는다. 이름 동의에 동의 안 받은 주소를 싣지 않는다. `save_offer`의 sender는 그 주소에 동의했을 때만이라 담을 때도 동의 없이 주소를 저장하지 않는다(담을 때 저장은 즉시 저장 실패 시 재시도).
- 정책 문구: 업무 규칙(묻지 않는 대상을 받는 곳으로 한정, 발송 주소 질문 추가), Backend 규칙(서버 질문 목록), workflow `sender_change_next` 해석.
- 테스트: 등록 주소가 같으면 묻지 않음, 상세만 다를 때 묻기·동의 뒤 상세 정정 시 재질문, 거절 시 담을 때도 저장 안 함, Live 흐름에서 이름 동의 PATCH 뒤 주소 질문·동의 시 주소만 PATCH·거절 시 PATCH 없음, Decision에 질문이 들어가는지. 기존 fixture의 등록 고객은 등록 주소에서 보내도록 맞췄고, 새 발송 주소를 받는 도구 테스트는 상세주소 뒤 등록 주소 답을 거친 뒤 받는 분 질문·후보를 확인한다. 새 기대값은 변경 전 코드에서 실패 확인. 최신 develop-ai(0d88fb26) 위 전체 628 passed. 운영 실통화는 미검증.


## 2026-11-12 — Decision timeout 1500ms

- 사용자 요청으로 develop-ai 최신 00c14fb4 기반 fix/decision-timeout-1500ms에서 기본 decision_budget_sec만 1.0초에서 1.5초로 늘렸다. timeout 이후 실패 처리·프롬프트·판정 기준·BE/PBX 계약은 유지한다. 연동된 도구 대기 상한은 기존 예산+0.5초 계산에 따라 기본 2.0초가 된다.
- 사용자 요청 순서대로 커밋·MR 생성 후 자동 테스트를 실행한다. 내부 대기 문제는 실제 통화 확인 후 별도로 진행한다. 기존 공유 작업 폴더 변경은 건드리지 않았다.
- MR !649 생성 후 검증: 전체 pytest 932 passed, 14 warnings(기존 의존성 deprecation). 기존 가짜 세션으로 1168ms 응답이 정상 적용되고(실측 약 1170ms), 1650ms 응답은 약 1509ms에 timeout 처리돼 나중에도 적용되지 않음을 확인했다. 각 경우 Decision 호출은 1회였다. 실제 OpenAI/PBX 호출 없이 검사했으며, 실통화 확인과 내부 대기 수정은 보류한다.

## 2026-11-13 — 접수 확인 중 정정의 기존 택배 전환 방지

- 통화 #594의 confirm=change와 switch=edit_parcel이 함께 온 경우를 회귀 테스트로 재현했다. Decision이 판단한 현재 택배와 적용 시점의 현재 택배가 같으면 현재 접수 정정을 우선하고 기존 택배 수정 전환을 생략한다. 같은 발화의 도구가 먼저 정정을 기록해 확인 대기가 풀린 경우도 현재 택배를 보존한다.
- 일반 기존 택배 수정 요청은 담은 택배가 한 건이어도 대상 선택을 거친다. 선택 답변에 edit_parcel이 중복 판정돼도 다시 선택 질문을 열지 않는다. 조회로 선택한 초안 수정과 내부 물품 검증 경로는 유지했다.
- 기존 Decision 선지로 현재 정정은 switch=none 및 confirm=change, 다른 기존 택배 수정은 switch=edit_parcel 및 confirm=not_answer로 구분하도록 지시문을 보강했다. 새 선지·의존성·BE/PBX 계약 변경 없음.
- 수정 전 회귀 테스트 4건 실패 확인. 수정 후 정정 처리 순서 2가지, 작성 중 택배 유무 2가지, 정정 후 두 번째 택배 확정 및 이전 택배 선택 시 새 초안 보존을 확인했다. 전체 AI 테스트 906 passed, 14 warnings(기존 의존성 deprecation).
- 실제 모델 판단·운영 음성 통화는 미검증이다. 운영 주문 데이터·원본 Claude transcript 변경, 원격 push와 배포는 하지 않았다.

- MR !656 충돌 해결: 최신 origin/develop-ai 2d8ed6e1을 병합하고 양쪽 worklog 추가 기록을 모두 보존했다. 병합 후 전체 AI 테스트 936 passed, 14 warnings(기존 의존성 deprecation). 기존 미커밋 #593 조사 기록은 MR에 포함하지 않고 별도 보존했다.
