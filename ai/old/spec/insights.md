# 통화 기록·분석 전송 (`app/insights.py`)

통화가 끝나면 받아쓰기·도구 실행·처리 결과와 통화 결과 분석을 백엔드로 보낸다. 관리자 통화 상세(스크립트·AI 동작·처리 내용·분석)에 쓰인다.
백엔드 계약 원문은 백엔드 저장소 `docs/api/call-events.md`(EVT-01), `docs/api/call-analysis.md`(ANL-01)(`origin/develop-backend`). 여기에는 AI가 그 계약을 어떻게 쓰는지만 적는다.

## 언제·어떻게

- 통화가 끝나고 결과(`POST /api/orders`, `Call.finish`)를 보낸 뒤 `sideband.run_call`이 한 번 부른다. 끝난 뒤라 받아쓰기는 모두 완결된 말이다(미완성 STT 조각을 보내지 않는다).
- `POST /api/ai/calls/{callSessionSeq}/events`(요청당 50개·본문 90KiB 이하로 나눔) → `POST /api/ai/calls/{callSessionSeq}/analysis`. 둘 다 204가 성공.
- 인증 `Authorization: Bearer <AI_INSIGHTS_TOKEN>`(페르소나·FAQ 토큰과 별개). 토큰이 없거나 통화 번호(`callSessionSeq`, 고객 확인에서 받음)를 모르면 보내지 않는다.
- 연결 실패·5xx는 같은 본문으로 3번까지 다시(`retry_interval_sec` 간격). 400·403·404·409 등은 다시 보내지 않고 로그·관제 오류로 남긴다. 통화에는 영향 없음.
- `eventId`는 `uuid5(고정 namespace, 통화 ID:순번)`이라 다시 만들어도 같다. 같은 내용 재전송은 백엔드가 204로 받는다.

## 이벤트(EVT-01)

시각 순으로 정렬하고 `eventOrder`를 1부터 매긴다. `occurredAt`은 UTC 밀리초, `offsetSeconds`는 통화 시작(`Call.started_at`, 수신 처리 시각)부터 버림한 초.

| kind | 만드는 것 |
|---|---|
| UTTERANCE | 관제 받아쓰기 말풍선 하나 = 발화 하나(빈 말 제외). 고객 CUSTOMER, 상담원 AI. `lastSentenceSeq`는 1(말풍선 하나를 한 문장 구간으로 본다) |
| AI_ACTION | 고객 확인 CUSTOMER_LOOKUP(등록·미등록·탈퇴), 도구 결과(`match_pins` PIN_SEARCH, `lookup_orders` PREVIOUS_ORDER_SEARCH, `search_manual` FAQ_SEARCH, `record_order` FIELD_SAVED, `cancel_order` ORDER_CANCELLED), 통화 결과 전송 ORDER_SUBMITTED. `get_state`·판별기·보류한 `modify_order`는 보내지 않는다 |
| BUSINESS_RESULT | 분석 결과가 접수면 ORDER_CREATED(주문 번호), 상담원 전환 HANDOFF_REQUESTED, 문의 INQUIRY, 취소한 택배마다 ORDER_CANCELLED |

- `summaryText`는 결과 한 줄(예: "기록: 받는 분, 도착지", "택배 2건 찾음", "실패: 처리 시간 초과"). 도구 인수 원문·이름·번호·주소는 넣지 않는다.
- 아직 보내지 않는 것: FAQ_ANSWERED(사용 FAQ 번호와 질문·답변 발화 연결이 필요), QUESTION_UNANSWERED(미답변 수집 UNQ-01 연동이 먼저).

## 분석(ANL-01)

- `startedAt`·`endedAt`: `Call.started_at`·`ended_at`. `aiPersonaVersionSeq`: 통화 시작에 고정한 `Call.persona_version`(`spec/persona.md`).
- `result`(위에서부터 먼저 맞는 것):
  1. 상담원 전환 요청 → HANDOFF
  2. COMPLETE로 결과를 보냄 → 백엔드가 주문을 저장(ACCEPTED·notPaid·PAID·SUBMITTING·SUBMISSION_FAILED)했으면 REGISTERED, 아니면 REGISTRATION_FAILED
  3. 취소한 택배가 있음 → CANCELLED
  4. 접수를 받다가 끝남(담은 택배·받는 중인 값 있음) → REGISTRATION_FAILED
  5. 그 밖 → INQUIRY
- `repeatQuestionCount`·`hasComplaint`는 아직 판정하지 않아 null, `complaints`는 빈 배열.

## 테스트

`tests/test_insights.py`(가짜 백엔드): 접수 통화의 이벤트 종류·순번·발화·분석, 재전송 동일, 결과 코드, 50개·크기 나누기, 토큰·통화 번호 없으면 안 보냄, 토큰 헤더·5xx 재시도·409 실패, 전송 실패는 통화 오류로만.
