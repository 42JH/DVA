# UNQ-01 AI 미답변 질문 수집

| 항목 | 계약 |
| --- | --- |
| API | POST /api/ai/unanswered-questions |
| 방향 | AI 서버 → 백엔드 |
| 인증 | Authorization: Bearer <AI_INSIGHTS_TOKEN>. 관리자 쿠키로 대체 불가 |
| 선행 | 기존 통화 생성, migration 049까지 적용 |
| 최초 / 동일 발생 재전송 | 201 / 200. 같은 unansweredQuestionSeq 반환 |
| 수집 단위 | 요청당 질문 1개. 통화당 50개 누적 제한 없음 |

AI가 답변하지 못했다고 판단한 질문을 보낸다. 백엔드에서 미답변 여부를 다시 분석하지 않는다.
백엔드는 통화 중·종료 후 모두 수신할 수 있으며, AI는 통화 종료 후 기존 통화 기록 전송 작업에서 질문별로 호출한다. 분석·주문·고객 정보 수신을 기다리지 않지만 통화 자체는 존재해야 한다.
AI는 관리자 쿠키·Origin·call_session_seq 헤더 없이 서비스 토큰과 본문을 전송한다. 별도 Idempotency-Key는 요구하지 않는다.

## Request

```json
{
  "eventId": "8d4e5cb5-d474-4e8a-904a-868304187e03",
  "callSessionSeq": 120,
  "providerCallId": "rtc_example_120",
  "questionText": "주말에도 수거하나요?",
  "reason": "KB_NO_ANSWER",
  "occurredAt": "2026-10-31T10:01:20+09:00",
  "offsetSeconds": 80
}
```

기존 여섯 필드는 모두 필수이고 reason만 선택이다. 숫자 문자열을 숫자로 변환하지 않고 정의하지 않은 추가 필드는 거절한다.

| 필드 | 규칙 |
| --- | --- |
| eventId | UUID. 발생 시 한 번 생성하고 응답 유실·타임아웃 재전송에도 유지 |
| callSessionSeq | 기존 통화의 양의 int32 번호 |
| providerCallId | 해당 통화에 저장된 AI 세션 ID. 최대 200자, 공백·NUL 금지 |
| questionText | 최대 1,000자, 공백 아닌 원문, NUL 금지. 원래 공백·줄바꿈 보존 |
| reason | 선택. KB_NO_ANSWER / KB_UNAVAILABLE / null. 생략/null은 미분류 |
| occurredAt | 시간대 포함 ISO 8601 실제 발생 시각. UTC로 정규화하며 재전송 시 변경하지 않음 |
| offsetSeconds | 0~9007199254740991의 정수 또는 null. 소수 초는 AI가 버림해 전송 |

offsetSeconds=80은 01:20, 0은 실제 시작 위치다. 모르면 null이며 필드를 생략하지 않는다.
status·offsetMs·레이턴시·고객 이름·전화번호·페르소나 번호·eventOrder·질문 배열을 본문으로 받지 않는다.
AI 동작의 status와 미답변의 관리자 업무 상태는 별개다. 최초 업무 상태 OPEN은 서버가 설정한다.

reason은 AI가 RAG 검색 결과와 Live의 실제 답변을 대조해 확정한다. KB_NO_ANSWER는 검색 성공 후 답할 근거 부족, KB_UNAVAILABLE은 검색 미연결·장애다. 백엔드는 사유를 추정하지 않는다. 관리자 업무 status와 독립적이며 FAQ 전환·삭제 뒤에도 원래 사유를 보존한다. 과거 데이터는 null이다. UNCLASSIFIED는 조회 전용 값이므로 수집 본문에 보내지 않는다.

## Response

새 발생은 HTTP 201, 동일 발생 재전송은 HTTP 200이다. 응답 형태는 동일하다.

```json
{
  "data": { "unansweredQuestionSeq": 51 },
  "meta": { "requestId": "76dc202f-6900-41b6-93c2-ae04ef7b2199" }
}
```

data는 질문 번호만 반환한다. 요청 본문·해시·현재 업무 상태는 반환하지 않는다.
X-Request-Id와 Cache-Control: no-store를 제공하며 오류도 기존 error/meta 계약을 따른다.

## 중복·업무 상태·트랜잭션

1. AI 토큰을 검증한 뒤 통화 존재와 providerCallId 일치를 확인한다. 다른 통화의 식별자로 기존 질문을 조회·재전송하지 못한다.
2. UUID 소문자·UTC 시각·고정 키 순서로 정규화한 SHA-256을 계산한다. reason 생략/null은 해시에서 제외해 과거 여섯 필드의 재전송을 유지하고, 명시한 사유는 포함한다. 질문 원문은 변경하지 않는다.
3. event_id UNIQUE와 INSERT ON CONFLICT로 발생 ID를 원자적으로 점유한다. 여러 앱 인스턴스의 동시 재전송도 질문 한 건만 만든다.
4. 최초 질문·UNANSWERED_QUESTION_RECORDED 성공 감사는 같은 트랜잭션이다. 감사 주체 AI, 대상 UNANSWERED_QUESTION과 새 질문 번호다. 실패하면 질문도 롤백한다.
5. 같은 eventId·통화·정규화 본문이면 기존 번호와 200을 반환한다. created_at·payload_hash·상태·성공 감사는 변경하지 않는다.
6. 같은 eventId의 질문·통화·시각·위치·사유 등이 다르면 409다. 명시한 사유의 재전송에서 사유를 생략해도 충돌한다. 과거 미분류를 같은 eventId로 사후 분류하지 않는다. 같은 문장도 새 eventId이면 별도 발생이다.
7. REGISTERED·DELETED의 재전송에도 기존 번호를 반환하며 OPEN으로 되돌리거나 삭제한 원문을 복원하지 않는다. 삭제 후 원문 비교는 보존한 payload_hash로 처리한다.
8. HTTP 로그·감사 metadata에 질문 원문·AI 세션 식별자·토큰을 복사하지 않는다.

상태는 OPEN 수집됨, REGISTERED FAQ 전환됨, DELETED 업무 삭제됨이다. [UNQ-03·UNQ-04](unanswered-questions-management.md)로 전환·삭제하며 질문 원문은 수집 재전송으로 복구하지 않는다.
삭제는 발생 식별자·본문 해시를 보존하는 업무 삭제를 전제로 한다. DB 직접 물리 삭제는 중복 방지 이력까지 제거한다.

## 통화 처리 결과 연결

UNQ-01은 미답변 업무 원본만 저장하고 [EVT-01](call-events.md) 이벤트를 자동 생성하지 않는다.
AI는 응답 번호를 다음 요청의 unansweredQuestionSeq로 전달한다. eventOrder는 기존 통화 전체 순번을 사용한다.

```json
{
  "providerCallId": "rtc_example_120",
  "events": [
    {
      "eventId": "e9c8aa6b-c4b4-4b1c-8bf4-d4492042d9ea",
      "eventOrder": 15,
      "kind": "BUSINESS_RESULT",
      "occurredAt": "2026-10-31T10:01:20+09:00",
      "offsetSeconds": 80,
      "payload": {
        "action": "QUESTION_UNANSWERED",
        "orderSeq": null,
        "unansweredQuestionSeq": 51,
        "summaryText": "미답변 질문 수집"
      }
    }
  ]
}
```

위 본문은 POST /api/ai/calls/120/events로 보낸다. 두 HTTP 요청은 하나의 DB 트랜잭션이 아니다.
질문 저장 후 이벤트 저장이 실패해도 질문은 유지된다. 이벤트는 같은 eventId·eventOrder·본문으로 재전송한다.
질문 원문을 summaryText에 복사하지 않는다. [GET /api/calls/{id}/processing-results](call-events-read-spec.md)가 같은 통화의 질문을 JOIN하며 DELETED이면 questionText를 null로 반환한다.

## DB·오류·검증

기존 unanswered_questions의 event_id·call_session_seq·question_text·occurred_at·offset_seconds·reason·payload_hash에 저장한다.
status=OPEN과 created_at은 DB 기본값을 사용하고 FAQ 전환·삭제 필드는 null이다.
새 migration 049는 nullable reason과 두 코드의 CHECK만 추가한다. 과거 행·해시·시각·상태는 변경하지 않는다. 추가 테이블·뷰·토큰 설정·라이브러리와 과거 migration 변경은 없다. DB 백업·049 적용 → 새 BE 배포 → AI reason 전송 순서다. [최신 사유 계약](unanswered-question-reasons.md)
PBX 시각·주문·분석·페르소나·기존 발화는 변경하지 않는다.

| HTTP | code | 조건 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 필수·타입·UUID·질문·시각·위치·추가 필드 오류 |
| 401 | UNAUTHORIZED | 토큰 누락·오류·중복 Authorization |
| 403 | FORBIDDEN | 통화와 AI 세션 불일치 |
| 404 | NOT_FOUND | 통화 없음 |
| 409 | EVENT_PAYLOAD_CONFLICT | 같은 발생 ID의 내용·통화 충돌 |
| 413 | PAYLOAD_TOO_LARGE | 공통 100KiB 본문 제한 초과 |
| 422 | VALIDATION_FAILED | 저장할 수 없는 발생 시각 |
| 500 | INTERNAL_ERROR | 분류되지 않은 저장·감사 실패 |
| 503 | DEPENDENCY_UNAVAILABLE | AI_INSIGHTS_TOKEN 미설정 |

검증 범위는 실제 Nest/DB의 201·200·인증·동시 재전송·상태 보존·충돌·원문 보존·51건 누적 수집,
감사 실패 롤백, EVT-01 실패 후 재전송과 처리 결과 조회, 삭제 원문 비노출, OpenAPI·기존 기능 회귀다.
수집 테스트의 REGISTERED·DELETED fixture 외에 관리 API의 실제 전환·삭제·재전송도 별도 통합 검증한다.
실제 AI 전송부·운영 DB 적용·배포는 별도 확인 대상이다.
