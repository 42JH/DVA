# 새 아키텍처 개요 (v3 — Live-1 자율 진행 + 서버 선택 개입)

작성일: 2026-11-03 · 상태: **설계안(사용자 승인 전 구현 금지)** · v2(Decision 우선 경로, 서버가 `next` 결정)를 대체
관련 문서: `workflow-policy.md`(정책·상태·자율 경계), `delegation.md`(Decision·위임·충돌 방지), `conversation-state.md`(Business State·확인), `concurrency.md`(CallSession·동시성), `call-lifecycle.md`, `error-recovery.md`, `latency-strategy.md`, `../testing/test-strategy.md`

## 0. 근거 등급과 확인된 OpenAI 사실

| 표기 | 출처 |
|---|---|
| **[SDK]** | 설치된 `openai==3.35.1` (`types/live/*`, `types/decision*.py`, `resources/live/*`, `resources/decisions.py`) |
| **[DOC]** | 공식 가이드(2026-11-03 조회): `live-delegation`, `live-prompting`, `voice-server-controls?api=live`, `decisions-voice`, `decisions` |
| **[미확인]** | 두 출처에 없음 → 설계가 의존하지 않거나 S0 스파이크로 확인 |

| # | 사실 | 출처 |
|---|---|---|
| F1 | SIP accept `session={type:"live", model:"gpt-live-1", instructions, audio.output.voice, delegation, input, triggers}`. instructions(≤16,384 토큰)·voice·model 시작 후 불변. v3.1은 `triggers`를 보내지 않는다 | [SDK] |
| F2 | `delegation` 타입(`responses`/`client`/`decisions`)은 세션 동안 고정 | [SDK], [DOC] |
| F3 | 위임 시점은 Live 프롬프트(`Generate <\|SpawnThinking\|>`)로 안내 | [DOC] live-prompting |
| F4 | `session.delegation.created`는 메타데이터만, 과제 본문 없음 | [SDK] |
| F5/F6 | Responses 위임의 함수 호출: `response.event` > `response.output_item.done`. 결과: `response.item.create(function_call_output)` 후 `response.create` | [SDK], [DOC] |
| F7 | 도구 결과 대기 타임아웃 명시 없음 | [DOC] |
| F8 | `session.thinking.append`(무음)·`commentary.append`(말할 정보)·`instructions.append`: 각 500토큰, Responses 위임에서는 `delegation_id:null` | [SDK], [DOC] |
| F9 | 끼어들기로 발화가 멈춰도 백엔드 작업은 계속, 위임 취소 이벤트 없음. "An appended instruction can interrupt the model's current speech or behavior." | [DOC] voice-server-controls |
| F11 | `session.close` → `session.closed{reason}` | [SDK] |
| F13 | 입력·출력 전사 delta(`start_ms`,`end_ms`), 완료 이벤트 없음 | [SDK] |
| F14 | sideband 연결 재시도 내장 | [SDK] |
| F15 | 위임 설정 `delegation.responses.text`는 `verbosity`만 지원(`format` 없음). 함수 도구는 `strict` 지원("must follow the function’s parameter schema exactly") → 위임 경로의 Structured Outputs = strict 함수 도구 인자 | [SDK] `responses_delegation_config_param.py`, `function_tool_param.py` |
| D1 | Decision 답: predicate·choice(2~255)·score·refusal. **자유 텍스트 추출 불가**("Use Structured Outputs with the Responses API ... extracted fields") | [SDK] `types/decision.py`, [DOC] decisions |
| D2 | 답에 질문 `name`이 실려 옴 | [SDK] |
| D3 | `triggers`: **전사 이벤트 타입당 1개**(입력·출력 → 최대 2), "Triggers run independently of delegation", `session.update`로 교체. S0 실측: delta마다 발동(빈도 조절 옵션 없음) → **v3.1에서 사용 안 함** | [SDK], [DOC] decisions-voice, S0 |
| D4 | `decision.event{trigger_id, source_event_id, event.decision.answers}`, 평가 텍스트 미포함 | [SDK] |
| D5 | "Live can combine pending deltas, and results can arrive out of order." 발동 시점 명시 없음 | [DOC] |
| D6 | Live가 Decision 결과를 자동 반영한다는 서술 없음 — 앱이 처리 후 `commentary.append` | [DOC] |
| D7 | `decision.item.create`: Decision용 맥락 추가, Live 음성 맥락 불변 | [SDK] |
| D9 | 독립 `POST /v1/decisions`(`gpt-6-luna`만, 질문 1~200개, 입력 = 텍스트 또는 user 메시지), "about 10x faster than the Responses API". S0c 웜 p50 251·p95 284ms, 입력 $0.10/1M·출력 무료(사용자 제공) → **v3.1의 Decision 경로** | [SDK], [DOC], S0c |
| D10 | 앱이 Live 위임 없이 Responses 백엔드 작업을 시작하는 방법은 문서 없음 | [DOC] |
| D11 | `instructions.append` 내용은 대화 이력에 남고 이후 백엔드 위임에도 포함 | [SDK] docstring |
| D12 | sideband 이벤트 필터 없음, 유니온에 오디오 반사(`session.input_audio.append`)·`output_audio.delta` 포함 | [SDK] |

---

## 1. 핵심 질문에 대한 답

### Q1. Live-1이 서버 승인 없이 자율로 진행할 수 있는 범위는?
**발화와 절차 진행은 전부, 업무 사실의 확정과 gate 단계 진입은 제외.**
- 자율: 인사·맞장구·대기, 정책 범위의 일반 질문 응답, 현재 단계 질문의 표현과 순서 내 진행, 재질문·표현 변경, 끼어들기 응대, 받은 사실 설명. 값 입력을 위임한 뒤 결과를 기다리지 않고 **같은 단계의 다음 항목을 물어도 된다**.
- 서버 결과 필요: 주소·번호·시각의 유효성, 단계 완료, 되읽기(readback)·결제 확정·마무리 같은 gate 단계 진입, 주문 확인, 조회 결과, 취소·전환·접수 결과(`workflow-policy.md` §4).

### Q2. 필수 업무 절차 누락을 어떻게 막는가?
"모델이 지키게 한다"가 아니라 **"모델이 건너뛰어도 업무 결과가 누락된 채 확정되지 않게 한다"**(`workflow-policy.md` §5).
1. 같은 정책 파일에서 Live 지시문과 서버 판정 규칙을 생성(어긋남 방지).
2. 값 기록 결과마다 `missing`·`stage_complete`를 돌려줘 Live가 빠진 것을 안다.
3. **하드 gate**: 되읽기는 서버가 `missing=[]`일 때 준 확인 내용(스냅샷)으로만 가능, 확정은 스냅샷·필드 버전 재검사, 최종 COMPLETE는 필수값 완비 시에만(BE도 422 검증).
4. **결과 문구 검사**: 서버가 Live 발화의 고위험 업무 결과 문구(접수·취소·결제 완료)를 서버 상태와 대조해 다음 턴 정정(N3). 조기 되읽기는 감지하지 않고 3의 gate로 막는다(출력 전사 Decision 감시는 S0·S0b에서 실패, v3.1에서 제거).

### Q3. Live 발화와 서버 상태 갱신의 충돌을 어떻게 막는가?
**전달 등급을 나눠, 대부분은 발화를 건드리지 않는다**(`delegation.md` §6).
- N1 값 기록 결과는 위임 결과로 자연스럽게, N1' 서버발 일반 갱신은 `thinking.append`(무음), N2 꼭 말해야 할 결과는 **Live 발화가 끝난 뒤** `commentary.append`, N3 오안내 정정만 `instructions.append`(중단 가능, 통화당 상한).
- 서버는 문장을 지시하지 않고 사실(`facts`, `fields`, `missing`, `can_proceed`)만 준다 → 표현 충돌이 생기지 않는다.
- 늦은 Decision·Tool 결과는 발화 ID·pending ID·필드 버전으로 폐기하고, 정정 시 확인 대기를 즉시 초기화한다.

### Q4. Decision API가 업무 행동을 정한 경우 Backend LLM이 필요한가?
**판단 유형마다 소유자가 하나다**(`delegation.md` §2).
- 선택형(예/아니요·후보 번호·업무 종류·결제 방식·점수·거부 처리) → **Decision**, 서버가 직접 처리(Backend 0회).
- 자유형(성함·전화번호·주소·날짜·시간·물품·요청사항·조회 성함·문의 질의) → **Backend LLM**의 strict 함수 도구 인자(F15). Decision으로 추출하지 않는다(D1).
- 외부 업무 실행 → 서버가 검증된 상태 값으로.
- 복합 발화("네, 근데 이름이 박민수예요")는 두 경로가 병렬로 진행되고 서버가 통합한다(같은 발화 구간에 위임이 있으면 확정 보류 후 재검사, `delegation.md` §4.1).
- Decision은 모든 발화의 선행 단계가 아니다: 서버가 고객 발화 끝(0.8초 무 delta)에 선택형 판단이 있는 단계에서만 1번 부르고(`POST /v1/decisions`, 입력 = 직전 AI 발화 + 고객 발화), 결과를 Live는 기다리지 않는다.
- 서버가 Backend를 직접 시작하는 방법은 없으므로(D10) 자유형 경로는 Live 위임으로만 시작된다.

### Q5. Responses Delegation과 Client Delegation 중 어느 쪽이 적합한가?
**Responses Delegation(`service_tier=priority`) + 서버 호출 독립 Decision**으로 결정했다(`delegation.md` §5, `decisions.md` S0b·S0c).
- Live는 정책상 값 발화에만 위임하므로, 위임이 생기면 거의 항상 값 추출 LLM이 필요하다 → 호스팅 Backend가 가장 짧은 경로.
- Client 방식은 위임에 과제 본문이 없어(F4) 서버가 턴 경계 없는 전사(F13)로 발화를 재구성하고 LLM을 직접 불러야 한다 → 복잡도·오류 위험이 크고 값 추출 턴의 지연 이점이 없다.
- 재평가 조건: priority 강등이 잦아 위임 지연 P95가 목표를 넘거나, 불필요 위임률이 높을 때. 도구 실행기·상태·정책은 공유되도록 경계를 둔다.

### Q6. 하나의 FastAPI 서버에서 다수 통화를 효율적으로 처리하려면?
- 단일 이벤트 루프, 통화당 상태 객체 + sideband 수신 태스크 1개(프로세스·스레드 생성 없음).
- 통화별 `asyncio.Lock`(짧은 동기 구간만), 외부 I/O는 잠금 밖 + 필드 버전 검증.
- 공유 HTTP 클라이언트(BE·카카오), 자원별 세마포어(BE·카카오·리랭커·임베딩), 통화당 동시 작업 상한, 모든 호출 타임아웃.
- CPU 작업(주소 보정·RAG 토큰화) 전용 실행기 — GIL 때문에 필요 시 프로세스 풀(측정 후).
- sideband 오디오 반사 이벤트는 파싱하지 않음(D12).
- 단일 워커가 기본. 다중 워커·인스턴스는 통화 소유권 라우팅이 필요(`concurrency.md` §7).
- 처리량은 단정하지 않고 가짜 sideband 서버로 1→100 통화 부하 테스트(`latency-strategy.md` §6).

---

## 2. 전체 시스템 아키텍처

```
 ┌──────────────────────────────────── OpenAI Live session ────────────────────────────────────┐
 │  GPT-Live-1  ◀── instructions = Workflow Policy(렌더링, 시작 시 1회)                            │
 │     │  자율 대화 ── 값 발화 시 <|SpawnThinking|> ──▶ Responses Backend ── function_call ───┐      │
 │     │                                                                                   │      │
 │  input/output_transcript.delta ─────────────────────────────────────────────┐          │      │
 └──────▲──────────────────────────────────────────────────────────────────────────┼──────────┼──────┘
        │ thinking/commentary/instructions.append                                  │          │ response.event
        │ response.item.create + response.create                                   │          │
 ┌──────┴──────────────── sideband WS (통화당 1개 · 수신 태스크 1개) ────────────────┴──────────┴──────┐
 │ AI Server (FastAPI, 단일 이벤트 루프)                                                                │
 │  ingress/   OpenAI 수신 웹훅 · PBX 종료 웹훅 · FAQ 알림 · 페르소나   (외부 계약 그대로)                │
 │  calls/     CallRegistry · CallSession{state, version, lock, pending_confirmation, ops, closed}      │
 │             발화 끝 감지(0.8s) → Decision 호출 ─────────▶ POST /v1/decisions (gpt-6-luna)            │
 │             handlers: decision(B 경로 실행 · 감시) · delegation(도구 라우터) · transcript · lifecycle   │
 │             notifier: N1'/N2/N3 전달 등급·시점 제어                                                  │
 │  policy/    Workflow Policy 로더 → Live/Backend 지시문 렌더러 + 서버 판정 규칙                         │
 │  domain/    Business State · assess() · 확정 관문 · 결과 outcome 정책 (순수)                          │
 │  tools/     Tool Executor: 값 기록 · 받는 곳 · 조회 · 검색 · (서버 전용) 취소 · 결과 전송 · refer       │
 │  integrations/ BackendGateway · AddressService · KnowledgeBase (공유 클라이언트 · 세마포어)            │
 │  persistence/  Outbox(SQLite): 통화 결과 · 인사이트                                                  │
 │  observability/ trace · 구간 지표(P50/P95 · 동시 통화 수 라벨)                                        │
 └───────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                 ▼ BE API (be-api.md 계약 그대로)
```

### 2.1 모듈 책임과 의존성

| 모듈 | 책임 | 의존 | 기존 코드 |
|---|---|---|---|
| `app/main.py` | 조립, 공유 클라이언트·세마포어, lifespan 정리 | 전부 | 신규 |
| `app/ingress/` | 웹훅 수신(계약 유지) | calls | `pbx_webhook/`, `app/webhooks/faqs.py`(원본 RAG, 수정 금지) |
| `app/policy/` | 정책 파일 로드·검증, Live/Backend 지시문·Decision 질문 렌더링, 서버 판정 규칙 제공 | 없음 | 신규(`docs/call-flow/voice.md`·`flow.toml` 내용 이관) |
| `app/calls/` | `CallRegistry`, `CallSession`, 수신 태스크, 핸들러, notifier | domain, tools, policy | 신규 |
| `app/domain/` | Business State, `assess`, 확정 관문, outcome 정책 | policy(데이터만) | `backend_client/order.py` 모델·매칭 이동 |
| `app/tools/` | 레지스트리·검증·실행·출력 정규화·멱등 | domain, integrations | `tools/` 리팩터 |
| `app/integrations/` | BE·주소·RAG 어댑터(계약 불변) | 기존 모듈 | `backend_client/api.py`, `address_resolver/`, `app/rag/`(원본 RAG, 수정 금지 — 어댑터는 호출만) |
| `app/persistence/` | 결과·인사이트 아웃박스 | sqlite3 | 신규 |
| `app/observability/` | 트레이스·지표 | 없음 | 신규 |

의존 방향: `ingress → calls → (tools → integrations) → domain ← policy`. `domain`·`policy`는 SDK·HTTP를 import하지 않는다.

---

## 3. v2 대비 변경 사항

| 항목 | v2 | v3 | 이유 |
|---|---|---|---|
| 대화 주도 | 서버 `next_step`이 다음 질문 결정, 결과에 `next` | **Live가 Workflow Policy로 자율 진행**, 서버는 `assess()`로 완료·누락만 판정 | 기획 변경 |
| 서버→Live 전달 | 매 결과에 `next`·`say` | 필요할 때만 사실·상태(`facts/fields/missing/can_proceed`), 등급 N0~N3 | 불필요 지시 주입 최소화 |
| 정책 | 지시문·`flow.toml`·서버 코드에 흩어짐 | 정책 파일 1개 → Live 지시문·서버 판정 동시 생성 | 누락·불일치 방지 |
| Decision | 입력 전사 트리거 1개 | **v3.1: 트리거 없음.** 서버가 발화 끝에 독립 API 1회(직전 AI 발화 + 고객 발화). 출력 감시 없음 | S0·S0b·S0c: 트리거는 delta마다 발동, 출력 감시 실패, 독립 호출은 토큰 1/27·오판정 감소 |
| 되읽기 | 서버가 `next=readback` 지시 | Live가 정책상 진입, 단 서버가 준 확인 내용이 있어야 함(gate) | 자율 + 하드 gate |
| 유지 | CallSession·Lock·필드 버전, Responses 위임, B 경로 서버 직접 처리, 확정 관문, 아웃박스, BE 오류 구조화, 2단계 고객 확인 | 동일 | — |

## 4. 구조적 위험과 대응

| # | 위험 | 대응 |
|---|---|---|
| X1 | Live가 정책을 어기고 단계를 건너뜀(S0b 실측: 결과 전 "확인했습니다", 연락처 전 되읽기) | 하드 gate(pending 없으면 confirm 판정 안 함) + 결과 문구 검사 N3. 업무 결과는 누락 상태로 확정되지 않음. 대화상 어긋남은 남는다 |
| X2 | 발화 끝 0.8초 규칙의 오분할·부하 시 delta 간격 증가 | 쉼으로 나뉘면 각각 판정(해 없음), S7에서 부하 중 간격 재측정 |
| X3 | N3 남용으로 대화 부자연·이력 누적(D11) | 업무 사실 오안내에만, 통화당 상한 |
| X4 | Live가 서버 결과 전에 다음 항목을 물어 검증 실패 재질문이 뒤늦게 옴 | 정상 흐름으로 수용: N2로 "앞의 주소를 다시" — 재질문 문장은 Live가 자연스럽게 |
| X5 | priority tier 강등·Decision API 콜드 지연 | 응답 `service_tier` 지표, 서버 시작 시 Decision 웜업, Decision 예산 1.0초 초과 시 판단 없음 |
| X6 | 불필요 위임(확인 답에 위임) | Backend에 확인 도구 없음 → 상태 불변, 위임률 지표 |
| X7 | 단일 인스턴스 | 아웃박스로 결과 보존, 확장 시 소유권 라우팅 |
| X8 | CPU 작업(GIL)·오디오 이벤트 파싱 | 실행기 분리, 경량 분기, 부하 테스트 |

## 5. 구현 우선순위와 완료 기준

| 단계 | 범위 | 완료 기준 |
|---|---|---|
| S0 스파이크 | 실 세션: 트리거 2개 + Responses 위임 공존, 발동 시점·지연, append 3종의 발화 영향, N3 중단 효과, 오디오 반사 | **완료**(S0·S0b·S0c, `delegation.md` §9) — U1~U7(`delegation.md` §9) 보고서, 설계 확정 또는 대안 전환 |
| S1 기반·계약 | 조립·설정·트레이스, `BackendGateway` 오류 구조화, BE 계약 테스트, 공유 클라이언트·세마포어 | 기존 364 + 계약 테스트 통과 |
| S2 정책·도메인 | 정책 파일·로더·렌더러, Business State, `assess`, 확정 관문, outcome | 정책 → 지시문/판정 일관성 테스트, 도메인 단위 테스트 |
| S3 도구·연동 | Tool Executor, ambiguous 주소 1순위 자동 확정(P6) + 후보 보관, 주소 실행기 분리, `ParcelStore`(P5) | 도구·실패 주입·중복 실행 테스트 |
| S4 세션·생명주기 | Registry·CallSession·수신 태스크·2단계 확인·PBX 매칭·정리 | 전이 표, 종료 시 자원 0 |
| S5 Decision·위임·notifier | 발화 끝 감지, Decision 호출·질문 세트, B 경로, 결과 문구 검사, N0~N3, 함수 라우터 | 이벤트 재생: 충돌 6상황(`delegation.md` §6.2) 전부 |
| S6 마무리 | 결과 아웃박스·hangup·인사이트 | 재시작 복구, 성공 안내는 `ACCEPTED`만 |
| S7 부하·지연 | 1→100 통화 | 구간 4종 P50/P95·동시 통화 곡선·병목 보고 |
| S8 스테이징 | 실 SIP | `test-strategy.md` §8 |

## 6. 결정 사항

사용자 결정(2026-11-03)은 `decisions.md`가 기준이다. 요약:

| # | 결정 |
|---|---|
| P1 | 수거 시각 = 고객 희망 시각, 현재 + 1시간 이후만 |
| P2 | BE 페르소나 `promptText` 우선, 불러오지 못하면 서버 기본 프롬프트(정책 렌더링은 보조, 서버 gate는 그대로) |
| P3 | 단일 워커 |
| P4 | 긴급 정정 3회 이후 상담원 이관 제안 |
| P5 | 접수 전까지 담은 택배를 통화 안에서 수정 가능(`ParcelStore`). 재확인 전 종료 시 마지막 확인 스냅샷으로 전송(B안) |
| P6 | 애매한 주소는 1순위 자동 확정, 이후 변경 가능 |
| P7 | 신규 고객 자동 등록 = 성함·전화번호·주소 모두 있을 때 |
| P8 | 전할 사실·금지 표현만 준수(추후 스크립트 발화 가능) |
| P9·P10 | 지연 목표 기본안, 조회 최근 5건 수용 |
| P11 | 상담원 대상·운영 시간 미정 → 설정값 |

P1 관련: 저장소의 BE 원문(결제 시각 + 1시간)은 구식이며 P1이 기준이다.

S0b: 위임 Backend `service_tier="priority"` 고정, 도구 결과 뒤 항상 `response.create`(`decisions.md` S0b).
S0c: Decision 트리거 미사용 → 서버가 고객 발화 끝(0.8초)에 `POST /v1/decisions` 1회, 출력 감시 제거(`decisions.md` S0c).

남은 결정: 측정으로 정할 값(Backend 모델·reasoning, Decision 임계값, `utterance_gap_ms`, `commit_delay_ms`, 통화 상한).

## 7. BE 계약 변동 대응

BE 설계가 끝나지 않아 요청·응답 필드가 바뀔 수 있다(`decisions.md` BE). AI는 계약을 임의로 바꾸지 않되, 바뀐 계약을 빨리 반영할 수 있게 구조를 잡는다.

| 장치 | 내용 |
|---|---|
| 계약 격리 | BE 경로·헤더·본문 매핑·응답 파싱은 `app/integrations/backend/` 한 곳에만. 도메인·도구는 BE 필드 이름을 모른다 |
| 매핑 단일화 | 요청 본문은 매핑 함수 1개(기존 `result_body`·`parcel_body`·`_address`)에서만 생성 |
| 관대한 응답 읽기 | 사용하는 필드만 검증하고 모르는 필드는 무시. 사용하는 필드가 없거나 형식이 다르면 `BE_CONTRACT_VIOLATION` 경보 |
| 계약 테스트 버전 | `docs/be-contract/backend/` 원문 기준 픽스처를 문서 커밋·날짜별로 보관. BE 문서가 바뀌면 픽스처를 갱신하고 실패하는 테스트로 영향 범위를 확인 |
| MockBackend 동기화 | 가짜 BE도 같은 계약 테스트를 통과해야 함 |
| 반영 절차 | BE 변경 수신 → `docs/be-contract/` 갱신 → `docs/contracts/be-api.md` 차이 기록 → 픽스처·매핑 수정 → 계약 테스트 통과 → worklog 기록 |
