# Live-1 · Decision · Delegation 설계 (v3.1 — Live 자율 진행, 서버 호출 Decision)

상태: 설계안 · 근거 표기는 `overview.md` §0 (F*, D*) · 정책 구조는 `workflow-policy.md`

> **2026-11-12 변경**: §6.2-5 결과 문구 검사와 N3 정정을 없앴다. 2026-11-12 제거: 정규식 결과 문구 검사와 N3 정정은 오탐이 맞는 안내를 번복시키고 정정 자체가 '아직 확인되지 않았어요' 같은 중간 발화를 만들어 없앴다. 대신 접수 요청 뒤 BE 저장 결과가 나올 때까지 알림을 보류하고(완료 → '접수했습니다', 실패 → 실패 안내 + 상담원 연결 제안), 그 사이 접수 여부에 관한 발화는 Live·Backend 지시문으로 막는다(worklog 2026-11-12).
>
> **v3.1 변경(2026-11-03, `decisions.md` S0c)**: Live Decision 트리거 2개를 쓰지 않는다. 서버가 **고객 발화 끝에 독립 Decision API(`POST /v1/decisions`, D9)를 1번** 부른다. 출력 전사 감시(Live 발화 감시)는 없앤다. 근거: S0(트리거가 전사 delta마다 발동, 출력 감시 실패), S0b(출력 감시 문구 변경 후에도 평범한 질문에 0.85), S0c(로그 재생: 토큰 1/27, 확인 답 오판정 4건 → 0, 웜 지연 p50 251·p95 284ms).

> 구현(S5, 2026-11-03): `app/calls/live.py` LiveFlow — 발화 끝(§3.1) → `decision_questions`(§3.2) → `POST /v1/decisions`(예산 1.0초) → 적용(`DECISION_STALE`·임계값 0.6) · 함수 호출 라우터(`run_tool`, 결과 뒤 `response.create`, completed 미수신 3초 대비) · G6(같은 발화 위임 완료까지 보류) · 확정 지연(새 입력이면 취소) · 취소 확인(`issue_cancel_confirmation`) · N1'/N2/N3(N2는 발화 정지·위임 완료 뒤, 같은 내용 1회, N3 3회 후 이관 제안 사실) · 결과 문구 검사. 첫 업무 의도(Decision task 또는 첫 위임 도구)에 2단계 고객 확인. 한계: 조회·취소 단계에서 접수로 돌아가는 전환 질문 없음, 결제 방식은 확인 단계 없이 기록, 상담원은 미설정(P11) 사실만.

## 1. 역할 분담

| 주체 | 하는 일 | 하지 않는 일 |
|---|---|---|
| **GPT-Live-1** | Workflow Policy에 따라 상담 진행(질문 순서·표현·재질문), 일반 대화, 끼어들기·정정 응대, **값 발화 시 위임**, 서버가 준 사실 안내 | 업무 사실 확정, gate 단계 자율 진입, 결과 추측 |
| **Decision (서버가 호출)** | **선택형 판단만**: 고객 발화 끝에 현재 단계의 질문 세트로 1회 — 확인 예/아니요, 후보 선택, 업무 종류·전환, 결제 방식 | 자유형 값 추출(D1), Live 발화 감시, 실행 |
| **Responses Backend LLM** | **자유형 값 추출**(성함·번호·주소·날짜·시간·물품·요청사항·조회 성함·문의 질의)을 strict 도구 인자로 구성 → 필요한 도구만 호출 | 선택형 판단(예/아니요·선택·분류), 절차 결정 |
| **FastAPI 서버** | Business State, 검증, 단계 판정, 확정 관문, **발화 끝 감지와 Decision 호출**, 외부 Tool 실행, 멱등성, Live에 사실 전달, 통화 종료 | 매 턴 발화 지시·승인 |

## 2. 판단 유형별 단일 소유자 (중복 판단 금지)

**Decision은 선택형 판단에만, Backend LLM은 자유형 값 추출에만 쓴다.** 같은 판단을 두 주체가 하지 않도록 판단 유형마다 소유자를 하나로 고정하고, 소유자가 아닌 쪽에는 그 판단의 수단(질문·도구)을 주지 않는다.

| 판단 유형 | 소유자 | 수단 | 다른 쪽에 없는 것 |
|---|---|---|---|
| 일반 대화 응답 | Live | 정책 지시 | — |
| 예/아니요(확인·동의) | Decision | `choice` yes·no·change·not_answer | Backend에 confirm 도구 없음 |
| 선택지 중 하나(후보 번호) | Decision | `choice` 후보 이름표·none·not_answer | Backend에 choose 도구 없음 |
| 업무 종류 분류 | Decision | `choice` order·lookup·cancel·inquiry·agent·end | Backend에 set_intent 도구 없음 |
| 결제 방식 분류 | Decision | `choice` credit·groupBilling·not_answer | — |
| 점수 판단·답변 거부 | Decision | `score` / `refusal`은 무시 처리 | — |
| **자유형 값**: 성함·전화번호·주소·날짜·시간·물품 설명·요청사항·조회 성함·문의 질의 | **Backend LLM** | strict 함수 도구 인자(§2.1) | Decision 질문에 값 추출 없음(D1) |
| 값의 유효성·단계 완료·확정 | 서버 | `assess`·검증·확정 관문 | 모델에 없음 |
| 외부 업무 실행 | 서버 | Tool Executor | 모델에 실행 도구 없음 |

### 2.1 Backend의 구조화 추출 방식
- 위임 설정 `delegation.responses.text`에는 `verbosity`만 있고 `format`(json_schema)이 없다 [SDK `responses_delegation_config_param.py`]. 따라서 Responses 위임에서의 Structured Outputs는 **`strict: true` 함수 도구의 인자 스키마**로 구현한다 [SDK `function_tool_param.py`: "Whether the delegated Responses model must follow the function’s parameter schema exactly"].
- 기존 도구 인수 모델(`tools/base.py` `Args`: `extra="forbid"`, `strict=True`, `openai.pydantic_function_tool`)이 이미 strict 스키마를 만든다 → 재사용.
- 서버는 strict 스키마를 믿지 않고 다시 검증한다(모델 출력은 미신뢰 입력, `tools/runner.py` 원칙 유지).
- Client Delegation으로 전환하는 경우에만 서버가 Responses API를 직접 호출하며, 그때는 `text.format` json_schema Structured Outputs를 쓴다(이 설계의 기본 경로 아님).

## 3. Decision 호출 (서버 → `POST /v1/decisions`)

### 3.1 언제 부르나 — 고객 발화 끝, 선택형 판단이 있는 단계에서만
- **발화 끝**: 마지막 입력 전사 delta 수신 뒤 `utterance_gap_ms`(기본 800) 동안 새 delta가 없으면 그 발화가 끝났다고 본다. 전사에는 완료 이벤트가 없다(F13). S0c 실측: delta 간격은 발화 안 ≤0.7초(208/259), 발화 사이 >0.8초(51/259), 0.7~0.8초 0개.
- 발화마다 서버가 `utterance_id`(통화 안 일련번호)와 구간(`start_ms`, `end_ms`)을 매긴다. 0.8초 넘는 쉼으로 한 발화가 둘로 나뉘면 각각 판정한다(앞 조각은 대개 `not_answer`라 확인 답에 해가 없다).
- **현재 단계에 선택형 판단이 없으면 부르지 않는다**(값 수집 중 `collect` 세트도 S2에서 필요성을 다시 본다 — 업무 전환 감지가 필요한 단계만).
- 호출은 비차단이다. Live·Backend는 결과를 기다리지 않는다(Live는 이미 답하고 있다).

### 3.2 입력과 질문 세트
- 입력은 텍스트 하나: `직전 AI 발화: {…}\n고객 발화: {…}`. **직전 AI 발화** = 고객 발화 시작 전에 끝난 마지막 출력 전사 묶음(같은 0.8초 규칙). 통화 전체를 넣지 않는다 → 판정 1건 토큰이 통화 길이와 무관(S0c 평균 370), 확인 질문이 아닐 때의 yes 오판정이 사라진다(S0c).
- 질문 세트는 정책 단계(`workflow-policy.md` `decision = …`)로 서버가 고른다. 세트를 Live 세션에 등록·교체하지 않는다(`session.update` 불필요).

| 단계(정책) | 질문 세트 | 질문 |
|---|---|---|
| `intent`(용건 파악) | `intent` | `task` choice: order·lookup·cancel·inquiry·agent·end·chit_chat·unclear |
| 값 수집(`sender`·`receiver`·`item`·`pickup`)·택배 담은 뒤 | `collect` (최소) | `switch` choice: none·edit_parcel(담은 택배 수정, P5)·lookup·cancel·inquiry·agent·end — 업무 전환·종료 감지만. 값·정정은 묻지 않음(Backend 소유) |
| 확인 대기(`readback`·전화번호 되읽기·취소·상담원) — **`pending_confirmation`이 있을 때만** | `confirm` | `confirm` choice: yes·no·change·not_answer |
| 후보 선택 대기(받는 곳 핀·조회 주문·자동 확정 주소의 대안·**수정할 담은 택배**) | `pick` | `pick` choice: 후보 이름표…·none·not_answer |
| 결제 방식 질문 | `pay` | `pay` choice: credit·groupBilling·not_answer |
| 문의 응답 중 | `collect`와 같음 | — |

- 한 호출에 여러 세트의 질문을 함께 넣을 수 있다(예: 확인 대기 중 `confirm` + `switch`). 질문 1~200개(D9).
- `refusal` 답과 임계값 미만 답은 "판단 없음"으로 취급한다(Live 대화가 계속 진행).

### 3.3 결과 처리·예산·준비
- 결과는 그 호출의 `utterance_id`·질문 세트·`pending_confirmation.id`에 묶인다. **더 최신 발화의 결과를 이미 적용했으면 폐기**(`DECISION_STALE`). 트리거 시절의 세트 ID·순서 역전 문제는 서버가 호출을 소유하므로 이것 하나로 줄어든다.
- 예산 1.0초(S0c 웜 최대 321ms). 초과·오류 → "판단 없음"(`DECISION_TIMEOUT`/`DECISION_UNAVAILABLE`, 고객 대응 없음, Live가 대화로 다시 확인) + 지표.
- 웜업: 서버 시작 시 1회 호출(S0c 콜드 첫 호출 1.7~2.3초). 유휴가 길 때의 재콜드는 [미확인] → 지표 보고 주기 호출 여부 결정.
- 클라이언트: 공유 `AsyncOpenAI` 1개, 동시 호출 세마포어(`concurrency.md` §6).

### 3.4 Live 발화 감시는 두지 않는다
- 출력 전사 Decision(조기 되읽기·미검증 확정 감지)은 S0·S0b 두 번 모두 안전장치로 쓸 수 없었다(서버 기록 없는 "주소도 받아뒀어요" 0.02~0.65, 평범한 질문 0.54~0.85). 비용은 트리거 전체의 3/4.
- 대신: **하드 gate**(Live가 먼저 되읽거나 확정처럼 말해도 업무 결과는 서버 확인 없이 확정되지 않는다, §6.2) + **서버 결정적 문구 검사**(고위험 업무 결과 문구만, §6.2-5).

## 4. 실행 경로 선택 (단계 × 데이터 유형)

경로는 **현재 Workflow 단계와 발화가 담은 데이터 유형**으로 정해진다. Live는 정책상 자유형 값을 들으면 위임하고(경로 3), 선택형 판단 단계에서는 위임하지 않으며(경로 2는 서버가 발화 끝에 Decision을 불러 처리), 서버는 도착한 결과만 처리한다.

| # | 경로 | 조건(단계·데이터) | 처리 | Decision | Backend | 외부 I/O |
|---|---|---|---|---|---|---|
| 1 | 일반 대화 | 인사·맞장구·대기·정책 범위 질문, 업무 상태 변경 없음 | Live 단독 | (선택형 단계면 호출되나 결과가 not_answer·chit_chat → 무시) | ✘ | ✘ |
| 2 | 선택형 판단 | 확인 대기·후보 대기·결제 질문·용건 파악·업무 전환 | 발화 끝 Decision 결과 → 서버 상태 변경(담기·선택·전환) → 필요 시 N2 | ✔ | ✘ | ✘ (C3 실행 시만) |
| 3 | 자유형 값 추출 | 성함·번호·주소·날짜·시간·물품·요청사항·조회 성함·문의 질의 | Live 위임 → Backend strict 도구 인자 → 서버 검증 | ✘ | ✔ | 주소 보정·카카오·기업 검색·BE 조회·RAG |
| 4 | 외부 업무 실행 | 확정 관문 통과 후 취소·상담원 전환·통화 결과 전송·고객 등록·PIN | 서버가 **검증된 상태 값**으로 Tool 실행 | (확인은 경로 2) | ✘ | BE·OpenAI refer |
| 5 | 복합 발화 | 한 발화에 선택형 + 자유형("네, 근데 받는 분 이름이 박민수예요", "두 번째 말고 강남에 있는 곳") | 경로 2와 3이 **병렬**로 진행 → 서버 통합(§4.1) | ✔ | ✔ | 3과 같음 |

Backend 도구(경로 3 전용, 모두 strict): `record_fields`, `find_destination`, `lookup_orders`, `search_manual`, `get_state`(맥락 복구·고객이 물은 진행 중 택배 값과 후보 값 조회, 판단 없음). 경로 4의 실행 도구는 서버 전용이며 모델에 노출하지 않는다.

**Decision이 행동과 인자를 이미 정했다면 Backend가 필요한가?** 경로 2·4는 인자가 선택지 안에 있어 필요 없다. 경로 3은 Decision이 자유형 값을 만들지 않으므로 Backend가 필요하다. 서버가 Backend를 따로 부르는 방법은 문서화되지 않았으므로(D10) 경로 3은 Live 위임으로만 시작된다.

### 4.1 복합 발화 통합 규칙

같은 고객 발화에서 Decision 결과와 Backend 함수 호출이 각각 도착할 수 있고, 순서는 정해져 있지 않다. 위임은 대개 발화 끝 판정(0.8초)보다 먼저 시작된다(S0b: 고객 말 끝 → 위임 0.1~1.5초).

| 규칙 | 내용 |
|---|---|
| R1 발화 연결 | Decision 결과는 서버가 매긴 `utterance_id`로, 위임은 `session.delegation.created.offset_ms`가 그 발화 구간(`start_ms` ~ `end_ms` + `utterance_gap_ms`)에 들면 같은 발화로 묶는다 |
| R2 확정 보류 | 확인 `yes`가 와도 **같은 발화에 위임이 생겼으면**, 그 위임의 `response.completed`(또는 도구 예산 만료)까지 확정을 보류한 뒤 관문(G2 스냅샷)을 다시 검사한다. 위임이 확인 대상 필드를 바꿨으면 확정 안 함 |
| R3 부정·변경 우선 | `confirm ∈ {no, change}`는 즉시 확인 대기를 해제(위임 결과를 기다리지 않음) |
| R4 선택 + 자유형 | `pick=none` + 위임 `find_destination` → 후보 해제 후 새 검색 결과 사용. `pick=후보` + 같은 발화 위임 → 위임 결과가 같은 후보를 가리키면 그대로, 다르면 위임(구체적 값)을 우선하고 다시 확인 |
| R5 업무 전환 + 값 | `switch=cancel` 등 + 위임 값 → 값은 기록하고(현재 택배), 전환은 진행 중 택배를 보존한 채 의도만 바꿈 |
| R6 순서 무관성 | 모든 반영은 필드 버전·확인 대기 상태로 판단하므로, 도착 순서가 바뀌어도 결과 상태가 같다(테스트 항목) |

### 4.2 Live 발화와의 병렬
- Live는 위임과 동시에 짧은 중립 응답("네, 확인할게요")이나 같은 단계의 다음 질문을 자유롭게 한다(S0·S0b: 위임 4~7회 모두 0.1~1.5초 안에 대기 멘트).
- 업무 사실(확정된 주소·접수·조회·취소 결과)은 서버 결과(N1/N2)가 온 뒤에만 말한다(정책 금지). Live가 어겨도 업무 결과는 하드 gate로 보호된다(S0b: Live가 도구 결과 0.5초 전에 "성함 확인했습니다" — 대화상 문제이지 업무 상태 문제는 아님).

## 5. Responses Delegation vs Client Delegation

| 기준 | Responses Delegation | Client Delegation |
|---|---|---|
| 위임 시 서버가 받는 것 | `response.event`로 Backend 함수 호출(인자 완성됨) | `session.delegation.created`(**과제 본문 없음**, F4) |
| 값 추출 | OpenAI 호스팅 Backend가 수행 | 서버가 전사로 발화를 재구성하고 **직접 LLM 호출**(Responses Structured Outputs)하거나 결정적 파서로 추출 — 전사에 턴 완료 이벤트가 없음(F13) |
| Decision 중심 제어 | 서버가 발화 끝에 Decision을 불러 B·C3 직접 실행(위임과 독립) | 위임마다 서버가 Decision·실행을 직접 오케스트레이션 → 제어력 최대 |
| 불필요 LLM 회피 | Live가 위임하면 Backend가 반드시 돈다(취소 불가, F9) | 서버가 위임을 받고 Decision만으로 끝낼 수 있음(LLM 0회) |
| 결과 전달 | 위임 결과가 Live로 돌아감(호스팅) + 필요 시 append. **도구 결과 뒤 `response.create` 필수**(S0b: 생략하면 Live 27초 정지) | `session.commentary.append(delegation_id=…)`로 서버가 직접([DOC]) |
| 늦은 작업 무효화 | 함수 결과로 `superseded` 반환(작업 자체는 계속) | 서버가 자기 LLM 호출을 취소 가능 |
| 구현 복잡도 | 낮음 | 높음(전사 재구성, 자체 LLM 루프, 프롬프트·컨텍스트 관리) |
| 지연(실측) | `service_tier=priority`: 위임→함수 호출 0.6~0.7초, 최종 문장 0.5~0.9초, 고객 말 끝 → 결과 발화 3.1~5.7초(S0b·17:22 통화). 기본 tier는 ~9초 | Decision만: 매우 짧음 / 추출 필요: 전사 확정 대기 + 서버 LLM 1회 |

**결정: Responses Delegation(`service_tier=priority`) + 서버 호출 독립 Decision**(`decisions.md` S0b·S0c).
- v3 구조에서 Live는 값 발화에만 위임하도록 정책화되어 있어, "위임했는데 LLM이 필요 없는" 경우가 적다(S0 U7: 성함·전화번호에만 위임, "네"·"여보세요"에는 안 함).
- 값 추출이 필요한 경우 두 방식 모두 LLM 1회가 들지만, Client 방식은 전사 재구성(턴 경계 없음)이 추가 위험이다.
- 재평가 조건: priority tier 강등이 잦아 위임 지연 P95가 목표를 넘거나, 불필요 위임률이 높을 때. 도구 실행기·Business State·정책은 두 방식이 그대로 공유한다.

## 6. 상태 전달과 발화 충돌 방지

### 6.1 전달 채널과 등급

| 등급 | 언제 | 채널 | 발화 영향 |
|---|---|---|---|
| **N0 없음** | Decision이 일반 대화, 검증 결과가 Live가 이미 아는 것과 같음 | — | 없음 |
| **N1 일반 갱신** | 값 기록 결과(위임 경로) | 위임 결과 자체(`function_call_output` → `response.create` → Backend → Live) | 자연스러운 다음 턴 |
| **N1' 일반 갱신(서버발)** | B 경로 결과, 비동기 검증 완료(주소 보정·2단계 등록) | `session.thinking.append`(무음, 500토큰, `delegation_id:null`, F8). S0: 말하지 않음 확인 | 말을 요청하지 않음. 다음 발화에 반영 |
| **N2 다음 턴에 말할 것** | 확인 결과(담기 완료·취소 결과), 검증 실패로 재질문이 필요 | `session.commentary.append`(말할 정보) — **Live 발화가 끝난 뒤**(출력 전사 정지 `quiet_ms`) 송신. S0: ack ~600ms, 위임 대기 중에도 곧바로 말함 | 다음 발화 |
| **N3 정정** | 서버가 **결정적으로** 아는 오안내(§6.2-5 문구 검사) | `session.instructions.append`("방금 말한 X는 아직 확인 전 — 정정"). S0·S0b: 진행 중 발화를 끊는 효과는 미확정(4번 중 2번 끊김, 정정 문장은 다음 턴) → **다음 턴 정정**으로 설계 | 다음 턴(끊길 수 있음) |

- N3은 대화 이력에 남고 이후 Backend 위임에도 포함되므로(D11) **통화당 3회**로 제한한다. 3회를 쓴 뒤에도 정정이 필요한 상황이면 정정 대신 상담원 이관 제안 사실을 N2로 전달한다(P4, `decisions.md`). 상담원 설정이 없으면(P11) "담당자가 확인 후 연락" 안내.
- 모든 전달 내용은 같은 형식: `{facts, fields:{name: status}, stage:{id, complete}, missing, can_proceed, needs:[{field, reason}]}`. 문장 지시는 넣지 않는다.

### 6.2 상황별 처리

| # | 상황 | 처리 |
|---|---|---|
| 1 | Live 발화 중 서버 상태 갱신 | N1'(thinking)로 무음 전달 — 발화를 끊지 않음. 말해야 하는 결과면 N2로 **발화 종료 후** 전달 |
| 2 | 서버 검증 전에 Live가 다음 단계로 진행 | 같은 단계 안 진행(다음 항목 질문)은 허용 — 검증 실패가 나오면 N2로 해당 항목 재질문. **gate 단계(readback·payment·closing)** 조기 진입은 감지하지 않고 막는다: `pending_confirmation`이 없으면 `confirm` 질문을 넣지 않으므로 고객의 "네"는 확정으로 이어지지 않는다. 서버가 `missing`을 다음 결과(N1)나 N2로 다시 알린다 |
| 3 | 고객이 이전 정보 정정 | 값 정정은 자유형 → Live 위임 → Backend `record_fields` → 필드 버전 증가 → 이전 스냅샷·작업 결과 자동 무효(`concurrency.md` §3). 확인 대기 중이면 Decision `confirm=change/no`가 대기를 즉시 해제(§4.1 R3). 정정 "감지"를 위한 별도 Decision 질문은 두지 않는다(값 변경 자체가 신호) |
| 4 | 늦은 Decision 결과가 현재 상태와 충돌 | 더 최신 발화 결과를 이미 적용했거나 `pending_confirmation.id`가 바뀌었으면 폐기(`concurrency.md` §3.3) |
| 5 | Tool 결과 전에 Live가 미검증 정보 안내 | 1차: 정책 금지 + "Do not guess the result while waiting"([DOC]). 2차: **서버 결정적 문구 검사** — 출력 전사 발화 끝에 정책 `[forbid].claims`의 고위험 업무 결과 문구(접수 완료·취소 완료·결제 완료 등)가 있고 서버 상태에 그 결과가 없으면 N3. LLM 호출 없음. "확인했습니다"처럼 정상 안내에도 쓰는 말은 검사하지 않는다(오탐). 결과가 오면 N2로 정확한 사실. 정확도 [미확인] → S5에서 대본으로 문구 목록 조정 |
| 6 | 서버 최신 상태와 Live 인지 상태가 다름 | 값 기록·조회 결과에 항상 `fields`·`missing` 요약 포함. Backend는 필요 시 `get_state`. 서버는 Live가 마지막으로 받은 `state_version`을 기록해 차이가 큰 상태(예: 정정 반영 후 미전달)면 N1' 1회 |

### 6.3 발화 중단 최소화 규칙
- N3은 "업무 결과 오안내"에만. 표현·순서 차이는 고치지 않는다.
- 같은 내용의 N1'/N2는 중복 송신하지 않는다(내용 해시).
- 진행 중인 위임이 있으면 N2는 그 위임 결과가 전달된 뒤 보낸다(겹침 방지).

## 7. 시퀀스

### 7.1 일반 대화
```
고객 "잠시만요" → Live "네, 천천히 말씀하세요" (즉시)
                 (선택형 단계면 0.8초 뒤 Decision → chit_chat/not_answer → 서버 처리 없음 / 값 수집 단계에서 collect를 끄면 호출 없음)
```

### 7.2 값 입력 — Live가 다음 질문으로 진행하며 검증은 비동기
```
고객 "부산 해운대구 센텀로 10이요"
Live: <|SpawnThinking|>, "네" ─────────────▶ Backend record_fields(receiver_address)
 (Decision 관여 없음: 자유형 값)               서버: 잠금(예약) → Address Resolver(잠금 밖) → 잠금(버전 검사·반영)
                                              ◀ output {fields:{receiver_address: valid}, facts:{readback_value:"부산 해운대구 센텀로 10"}, missing:[receiver_address_detail]}
                                              서버 → response.create
Live: "부산 해운대구 센텀로 10번지요. 상세 주소도 알려 주세요."
(주소 못 찾음이면 output {fields:{receiver_address: invalid, reason: ADDRESS_NOT_FOUND}} → Live가 정책의 재질문 규칙대로)
```

### 7.3 확인 → 담기 (서버 내부 처리, Backend 0회)
```
서버: assess() → 필수 완료 → readback_ready + 스냅샷 → pending_confirmation(issued_at) → 확인 내용 전달(N1 또는 N1')
Live(정책): 확인 내용을 읽고 "맞으세요?"         (서버: 출력 전사를 발화로 묶어 둠)
고객 "네"  → Live "네, 확인할게요"
서버(0.8초 무 delta): Decision(직전 AI 발화="…맞으세요?", 고객 발화="네", 질문 confirm+switch) → confirm=yes
서버: 확정 관문(G1~G6; G3 = 직전 AI 발화가 pending 발급 뒤 시작, 고객 발화는 그 발화 끝 뒤 시작)
      → commit_delay → 재검사 → ParcelStore에 보관 → N2(commentary: 담기 완료, missing 없음)
Live: "담아 두었어요. 더 보내실 택배 있으세요?"
```

### 7.4 조기 되읽기 (감지하지 않고 막는다)
```
Live가 수거 일시를 묻지 않고 "그럼 주문 내용 확인해 드릴게요… 맞으세요?" 시작
서버: pending_confirmation 없음(readback_ready=false, missing=[pickup_at]) → Decision에 confirm 질문을 넣지 않음
고객 "네" → 확정 없음. 서버는 다음 결과·N2에 missing=[pickup_at]
Live: "수거 희망 날짜와 시간을 알려 주세요."
```

### 7.5 취소 (서버 전용 실행)
```
고객 "보낸 거 취소할래요" → (발화 끝) Decision task=cancel(용건 단계) 또는 switch=cancel(수집 단계) → 서버: intent=cancel, 2단계 고객 확인(1회)
Live(정책): 받는 분 성함 질문 → 고객 성함 → Live 위임 → Backend lookup_orders → 서버 조회
서버: 후보 → 다음 발화 끝 Decision에 pick / 1건이면 스냅샷 → N1'(확인 내용) + pending_confirmation
고객 "네" → (발화 끝) confirm=yes → 관문·commit_delay → ops["cancel:o:p"] → BE 취소 → N2(결과: done/locked/already/unknown)
```

## 8. accept 시 세션 설정
```python
session = {
  "type": "live", "model": "gpt-live-1",
  "audio": {"output": {"voice": persona.voice_id}},
  # P2: 페르소나 promptText 우선 + 정책 렌더링(절차·필수·금지). 충돌 시 promptText 우선을 명시. ≤16,384 토큰, 불변
  # promptText를 불러오지 못하면(조회 실패·타임아웃·404·빈 값) 서버 기본 프롬프트로 대체
  "instructions": render_live(persona.prompt_text or DEFAULT_PROMPT, policy, caller_ctx),
  "delegation": {"type": "responses", "responses": {
      "model": cfg.backend_model, "instructions": render_backend(policy),
      "tools": [t.function_spec() for t in MODEL_TOOLS],
      "tool_choice": "auto", "parallel_tool_calls": False,
      "reasoning": {"effort": cfg.backend_effort}, "text": {"verbosity": "low"},
      "service_tier": "priority"}},          # decisions.md S0b
  # triggers 없음 — Decision은 서버가 발화 끝에 POST /v1/decisions로(§3, decisions.md S0c)
}
```

## 9. S0~S0c로 확인한 사항

| # | 확인 | 결과 | 설계 반영 |
|---|---|---|---|
| U1 | 트리거 발동 시점·빈도·지연(D5) | delta마다 발동(발화당 4~11건), p50 ~150ms, 순서 역전 있음 | 트리거 미사용(§3) |
| U2 | Responses 위임 + 트리거 공존 | 동작함 | 쓰지 않음(비용·정확도) |
| U3 | 트리거가 AI 직전 질문을 맥락으로 보는가 | 불충분(확인 질문 없이 yes) | 서버가 직전 AI 발화만 넣음 — S0c에서 해소 |
| U4 | commentary/thinking.append 발화 영향 | commentary 즉시 말함, thinking 무음 | N1'·N2 유지 |
| U5 | instructions.append 중단 효과 | 미확정(끊김 2/4, 정정은 다음 턴) | N3 = 다음 턴 정정 |
| U6 | sideband 오디오 반사 | 입출력 ~120KB/s | 경량 분기(파싱 안 함) |
| U7 | 값 발화에만 위임하는가 | 성함·전화번호에만, 위임 규칙 없는 값(주소)은 Live가 "받았다"고 말함 | 자유형 필드는 전부 위임 규칙에 |
| — | 위임 지연 | 기본 tier ~9초 → priority ~1초 | `service_tier=priority` |
| — | 발화 끝 감지 | delta 간격 ≤0.7초 / >0.8초로 갈림 | `utterance_gap_ms=800` |
