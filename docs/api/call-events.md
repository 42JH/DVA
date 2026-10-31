# EVT-01 발화·AI 동작·처리 이벤트 저장

| 항목 | 내용 |
| --- | --- |
| API | POST /api/ai/calls/{id}/events |
| 방향 | AI 서버 → 백엔드 |
| 인증 | Authorization: Bearer <AI_INSIGHTS_TOKEN> |
| 관련 화면 | 디자인/목업 06 통화 상세의 스크립트·AI 동작·처리 내용 |
| 선행 | 025·026 마이그레이션 적용, 기존 통화 생성 |

## Request

id는 기존 양의 int32 callSessionSeq다. providerCallId와 같은 통화여야 한다.
관리자 쿠키만으로 수집할 수 없으며 AI는 쿠키·Origin 없이 전송한다. 토큰은 ANL-01과 공유하고 프론트에 노출하지 않는다.

```json
{
  "providerCallId": "rtc_example_120",
  "events": [
    {
      "eventId": "ea692c7e-4852-4b48-8e44-b3d6b63e9256",
      "eventOrder": 1,
      "kind": "UTTERANCE",
      "occurredAt": "2026-10-31T10:00:31+09:00",
      "offsetSeconds": 31,
      "payload": {
        "utteranceOrder": 1,
        "speaker": "CUSTOMER",
        "utteranceText": "택배를 접수하고 싶어요.",
        "lastSentenceSeq": 1
      }
    },
    {
      "eventId": "a148d5b1-7b06-4eb7-aef8-ef9d736fc6af",
      "eventOrder": 2,
      "kind": "AI_ACTION",
      "occurredAt": "2026-10-31T10:00:32+09:00",
      "offsetSeconds": 32,
      "payload": {
        "action": "ADDRESS_SEARCH",
        "summaryText": "주소 검색 결과 1건",
        "orderSeq": null
      }
    }
  ]
}
```

| 필드 | 검증·의미 |
| --- | --- |
| providerCallId | 필수 문자열, 공백·NUL 금지, 최대 200자 |
| events | 요청당 1~50개. 전체 JSON 최대 100KiB. 통화 누적 건수 제한과 별개 |
| eventId | 필수 UUID. 발생 시 생성하고 재전송에도 유지. 대소문자는 동일 UUID로 처리 |
| eventOrder | 필수 양의 int32. 요청마다 초기화하지 않는 통화 전체 순번 |
| kind | UTTERANCE / AI_ACTION / BUSINESS_RESULT |
| occurredAt | 시간대 포함 ISO 8601 발생 시각. UTC 밀리초 표기로 정규화하며 수신 시각과 구분 |
| offsetSeconds | 필수, 0 이상 안전한 정수 초 또는 null. 소수 초는 AI가 버림한 뒤 전송 |
| payload | 아래 종류별 허용 필드만 전송. 모든 필드 필수이며 허용한 값만 null 사용 |

한 통화의 120개 이벤트는 50·50·20개로 나누어 보낼 수 있다. 본문 크기 제한도 함께 만족해야 한다.
같은 초에 여러 기록이 있어도 eventOrder로 순서를 구분한다. 위치를 알 수 없으면 0 대신 null을 보낸다.
offsetMs, 응답 레이턴시, AI 동작 status, 원문 tool 인자·임의 추가 필드는 거절한다.

## 종류별 payload

| kind | 필드 | 검증 |
| --- | --- | --- |
| UTTERANCE | utteranceOrder | 양의 int32, 발화끼리 매기는 통화 내 순번 |
| UTTERANCE | speaker | CUSTOMER / AI |
| UTTERANCE | utteranceText | 공백 아닌 문자열, NUL 금지, 최대 20,000자. 원문 공백·줄바꿈 보존 |
| UTTERANCE | lastSentenceSeq | 양의 int32. 기존 발화 구간에 마지막으로 반영된 문장 순번 |
| AI_ACTION | action | ADDRESS_SEARCH / CUSTOMER_LOOKUP / ORDER_LOOKUP / FAQ_SEARCH / FIELD_SAVED / ORDER_SUBMITTED / ORDER_CANCELLED |
| AI_ACTION | summaryText | 동작 결과 설명. 공백 아닌 문자열, NUL 금지, 최대 1,000자 |
| AI_ACTION | orderSeq | 양의 int32 또는 null |
| BUSINESS_RESULT | action | ORDER_CREATED / ORDER_CANCELLED / QUESTION_UNANSWERED / HANDOFF_REQUESTED / INQUIRY |
| BUSINESS_RESULT | orderSeq | 양의 int32 또는 null |
| BUSINESS_RESULT | unansweredQuestionSeq | 양의 int32 또는 null. 같은 통화의 기존 미답변 번호 |
| BUSINESS_RESULT | summaryText | 처리 내용. 공백 아닌 문자열, NUL 금지, 최대 1,000자 |

AI 동작은 결과 기록 한 건씩 저장한다. 요청/성공 단계로 같은 동작을 두 번 보내지 않는다.
실패·미확인 결과도 사실대로 summaryText에 기록할 수 있으며 UI가 문장을 파싱해 상태를 판정하지 않는다.
HANDOFF_REQUESTED는 연결 완료를, ORDER_CREATED는 결제·디버 최종 접수 성공을 보장하지 않는다.
이 API는 주문 접수·취소·상담원 연결 명령을 실행하지 않는다.

## 저장·중복·참조 규칙

1. 서비스 자격, 통화 존재와 providerCallId 결속을 검사한다. 종료 후 지연 도착과 분석 수신 전·후 모두 허용한다.
2. 묶음 안에서 eventId·eventOrder가 중복되면 400이다. 묶음 배열 순서는 저장 순서를 결정하지 않는다.
3. eventId UNIQUE, (call_session_seq,event_order) UNIQUE로 중복·충돌을 제어한다.
4. 이벤트별 고정 키 순서·시각·UUID를 정규화해 본문 해시를 계산한다. 같은 식별자·통화·순번·내용은 204, 다른 내용은 409다.
5. 새로운 UUID로 기존 순번을 재사용하거나 같은 발화를 다른 이벤트로 다시 등록하면 409다.
6. UTTERANCE 원문은 기존 call_utterances에 저장한다. 이벤트는 발화 FK를 참조하며 원문을 JSONB에 중복 저장하지 않는다.
7. 기존 발화가 있으면 화자·원문·lastSentenceSeq가 일치해야 한다. 덮어쓰지 않는다. 미완성 STT 조각은 받지 않는다.
8. 주문은 통화의 연결 주문 고객을 우선으로, 연결 주문이 없으면 발신번호 고객으로 범위를 확인한다. 다른 고객 주문은 403이다. 고객 상태가 이후 변경돼도 과거 통화 기록 수집은 가능하다.
9. 미답변 번호는 실제 존재와 같은 통화인지 검사한다. 삭제 상태의 참조도 원문 복구 없이 역사 기록으로 보존한다.
10. 이벤트·신규 발화·성공 감사는 요청당 하나의 트랜잭션이다. 한 항목 충돌·저장 실패 시 이번 묶음의 새 기록 전체를 롤백한다. 이전 요청의 커밋은 보존한다.
11. 같은 통화 수집은 DB 트랜잭션 잠금으로 직렬화하며, 서로 다른 통화의 UUID 충돌도 고유 제약으로 검사한다.
12. 신규 이벤트가 있는 묶음에만 AI 주체의 CALL_EVENTS_RECORDED 성공 감사를 남긴다. 전체 재전송은 성공 감사를 늘리지 않는다.

PBX 통화 시각·종료 사유, 주문 상태, 페르소나 상태는 변경하지 않는다.
이벤트 원문·요약·토큰을 HTTP 로그나 감사 metadata에 복사하지 않는다.

## DB·기존 API 연결

- 025는 ANL-01의 기존 complaints.offsetMs를 1000으로 나눠 버림하고 offsetSeconds로 전환한다. 정규화 해시도 갱신하며 analysed_at은 보존한다. 기존 024는 변경하지 않는다.
- 026은 call_insight_events와 미답변 참조용 unanswered_questions를 추가한다. 미답변 수집·관리 API는 아직 제공하지 않는다.
- call_insight_events의 위치는 bigint offset_seconds이며 안전한 정수 범위로 제한한다. AI 동작 status 컬럼·payload 필드는 없다.
- 같은 발화의 이벤트는 한 건이다. call_utterances·unanswered_questions 참조는 물리 삭제를 연쇄 실행하지 않는다.
- FAQ 번호는 미래 전환 이력을 위한 논리 참조여서 기존 FAQ 삭제를 막지 않는다.
- 기존 GET /api/calls/{id}/transcript에서 수집된 완결 발화를 조회한다.
- [후속 EVT-02](call-events-read-spec.md)가 AI 동작·처리 내용·초 위치를 프론트에 반환한다. 해당 GET은 이번 구현에 포함하지 않는다.

## Response·오류

성공은 204, 본문 없음. X-Request-Id와 Cache-Control: no-store 및 기존 오류 envelope를 사용한다.

| HTTP | code | 상황 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 필수값·타입·종류별 payload·요청 내 중복·금지 필드 |
| 401 | UNAUTHORIZED | 토큰 누락·오류·중복 Authorization |
| 403 | FORBIDDEN | 통화 ID 불일치, 다른 고객 주문·다른 통화 질문 |
| 404 | NOT_FOUND | 통화·참조 주문·질문 없음 |
| 409 | EVENT_PAYLOAD_CONFLICT | 이벤트·순번·완결 발화 충돌 |
| 413 | PAYLOAD_TOO_LARGE | 본문 100KiB 초과 |
| 422 | VALIDATION_FAILED | 저장할 수 없는 발생 시각 |
| 500 | INTERNAL_ERROR | 저장·감사 실패. 묶음 롤백 |
| 503 | DEPENDENCY_UNAVAILABLE | 수집 토큰 미설정 |

실제 AI 전송·운영 migration 적용·정밀 녹취 위치 매핑은 별도 확인 대상이다.
