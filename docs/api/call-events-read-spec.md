# 통화 발화·처리 결과·AI 동작 분리 조회

기준은 디자인/목업 06 통화 상세와 사용자 확정 사항이다. 통합 GET /api/calls/{id}/events 초안은 아래 용도별 조회로 대체한다.
AI 서버의 수집은 기존 [EVT-01](call-events.md) POST /api/ai/calls/{id}/events 한 개를 유지한다.

## API와 인증

| 용도 | 프론트 → 백엔드 API | 내용 |
| --- | --- | --- |
| 대화 내용 | GET /api/calls/{id}/transcript | 기존 API 보완. 고객·AI 발화와 통화 내 초 위치 |
| 처리 내용·FAQ 처리 | GET /api/calls/{id}/processing-results | 주문 처리, FAQ 답변·미답변, 상담원 연결 요청 등 업무 결과 |
| AI 동작 | GET /api/calls/{id}/actions | PIN·이전 주문·FAQ 검색, 고객 조회, 정보 저장 등의 동작 |
| 동작 전체 건수 | GET /api/calls/{id} | 기존 통화 상세 data.aiActionCount |

모든 조회는 활성 OPERATOR·SUPERVISOR·SYSTEM_ADMIN의 dva_session 쿠키가 필요하다.
AI_INSIGHTS_TOKEN이나 call_session_seq 헤더만으로는 조회할 수 없다. 프론트에 AI 토큰을 제공하지 않는다.
로그인·권한 확인을 통화 존재 확인보다 먼저 수행한다. 비활성 계정은 기존 인증 정책대로 401이다.

## 공통 Path·Query·응답

id는 기존 양의 int32 callSessionSeq다. 요청 본문은 없다.
목록 세 API는 limit 기본 20·범위 1~100, offset 기본 0·범위 0~9007199254740991을 사용한다.
kind·action 필터는 받지 않는다. 빈 값·소수·잘못된 숫자·중복 query·추가 필드는 400이다.

목록 성공은 HTTP 200과 {data:[],hasNext:boolean,total_count:number}다. total_count는 같은 통화·종류 조건의 전체 건수이며 limit·offset은 제외한다.
단건 통화 상세는 기존 {data,meta:{requestId}} 형식을 유지한다.
모든 응답은 Cache-Control: no-store, X-Request-Id를 제공한다.
통화가 없으면 404, 기존 통화에 수집 기록이 없거나 마지막 페이지 이후면 빈 목록과 hasNext=false다.
빈 기록을 무음 통화·AI 동작 없음·수집 완료로 단정하지 않는다.

## 1. GET /api/calls/{id}/transcript

기존 응답의 callUtteranceSeq·utteranceOrder·speaker·utteranceText·lastSentenceSeq·receivedAt을 유지하고 offsetSeconds를 추가한다.
speaker는 CUSTOMER/AI이며 고객·AI 발화를 같은 목록에서 반환한다.
utteranceOrder ASC, callUtteranceSeq ASC로 정렬하며 원문의 공백·줄바꿈을 보존한다.

offsetSeconds는 해당 발화 이벤트의 정수 초 또는 null이다. 이벤트가 없는 기존 발화도 LEFT JOIN으로 유지한다.
receivedAt은 DB 최초 수신 시각이며 통화 내 재생 위치로 환산하지 않는다.
ANL-01 complaints[].utteranceOrders는 이 utteranceOrder와 연결해 불만 발화를 강조한다.

## 2. GET /api/calls/{id}/actions

```http
GET /api/calls/120/actions?limit=20&offset=0
Cookie: dva_session=<관리자 세션>
```

```json
{
  "data": [
    {
      "eventId": "a148d5b1-7b06-4eb7-aef8-ef9d736fc6af",
      "eventOrder": 3,
      "occurredAt": "2026-10-31T01:00:31.000Z",
      "offsetSeconds": 31,
      "action": "PIN_SEARCH",
      "summaryText": "PIN 별칭 '본사' 검색 결과 1건",
      "orderSeq": null
    },
    {
      "eventId": "b148d5b1-7b06-4eb7-aef8-ef9d736fc6af",
      "eventOrder": 8,
      "occurredAt": "2026-10-31T01:00:48.000Z",
      "offsetSeconds": 48,
      "action": "PREVIOUS_ORDER_SEARCH",
      "summaryText": "지난주 김담당 주문 검색 결과 2건",
      "orderSeq": null
    }
  ],
  "hasNext": false,
  "total_count": 2
}
```

| 필드 | 의미 |
| --- | --- |
| eventId | 수집 시 보존한 UUID |
| eventOrder | 통화 전체 순번. 동작만 조회해도 1부터 다시 매기지 않음 |
| occurredAt | AI가 보고한 발생 시각. UTC ISO 8601 |
| offsetSeconds | AI 통화 시작부터 정수 초 또는 null |
| action | 아래 동작 코드 |
| summaryText | AI가 보고한 동작 설명. 평문 표시 |
| orderSeq | 관련 주문 상세 연결 번호 또는 null |

| 신규 전송 action | 의미 |
| --- | --- |
| PIN_SEARCH | 저장된 개인·기업 PIN 검색. 별칭·이름 등도 포함 |
| PREVIOUS_ORDER_SEARCH | 이전 주문 검색. 기간·이름·주문 내역 등도 포함 |
| CUSTOMER_LOOKUP | 고객 조회 |
| FAQ_SEARCH | FAQ 검색 동작 |
| FIELD_SAVED | 수집 정보 저장 |
| ORDER_SUBMITTED | 주문 제출 동작 기록 |
| ORDER_CANCELLED | 주문 취소 동작 기록 |

PIN·이전 주문 검색을 주소 검색으로 제한하지 않는다. 검색어·검색 대상 주소 필드는 필수로 요구하지 않는다.
기존 ADDRESS_SEARCH·ORDER_LOOKUP은 수집·재전송 호환을 위해 허용하며 조회에서도 원래 코드로 보존한다. 자동 치환하지 않는다.
status·offsetMs·레이턴시는 반환하지 않는다. 프론트는 summaryText로 성공·실패를 추론하지 않는다.
이 API는 저장된 동작 기록을 읽으며 PIN·주문 검색 명령을 새로 실행하지 않는다.

## 3. GET /api/calls/{id}/processing-results

```json
{
  "data": [
    {
      "eventId": "c148d5b1-7b06-4eb7-aef8-ef9d736fc6af",
      "eventOrder": 12,
      "occurredAt": "2026-10-31T01:01:20.000Z",
      "offsetSeconds": 80,
      "action": "FAQ_ANSWERED",
      "summaryText": "FAQ로 요금 문의 안내 완료",
      "orderSeq": null,
      "unansweredQuestionSeq": null,
      "unansweredReason": null,
      "faqEntrySeq": 12,
      "questionUtteranceOrder": 5,
      "answerUtteranceOrder": 6,
      "questionText": "착불 요금은 어떻게 되나요?",
      "answerText": "상담 당시 실제로 안내한 답변입니다."
    }
  ],
  "hasNext": false,
  "total_count": 1
}
```

eventId·eventOrder·occurredAt·offsetSeconds·summaryText·orderSeq는 동작 응답과 같은 의미다.
action은 ORDER_CREATED / ORDER_CANCELLED / QUESTION_UNANSWERED / HANDOFF_REQUESTED / INQUIRY / FAQ_ANSWERED다.

| 추가 응답 필드 | 규칙 |
| --- | --- |
| unansweredQuestionSeq | 연결 미답변 번호 또는 null. 삭제 후에도 역사적 번호 보존 |
| unansweredReason | 연결 미답변의 KB_NO_ANSWER / KB_UNAVAILABLE. 과거·미분류·삭제한 질문·다른 처리 결과는 null. 업무 status와 독립적 |
| faqEntrySeq | FAQ_ANSWERED에 사용한 FAQ 번호. 나머지는 null |
| questionUtteranceOrder | FAQ_ANSWERED의 같은 통화 고객 질문 순번. 나머지는 null |
| answerUtteranceOrder | FAQ_ANSWERED의 같은 통화 AI 답변 순번. 나머지는 null |
| questionText | FAQ_ANSWERED는 연결 고객 발화 원문. 연결 미답변은 OPEN/REGISTERED일 때 현재 원문, DELETED·연결 없음은 null |
| answerText | FAQ_ANSWERED의 실제 AI 답변 발화 원문. 나머지는 null |

FAQ_SEARCH는 검색 동작이고 FAQ_ANSWERED는 답변 처리 결과다. 검색만으로 답변 완료 결과를 만들지 않는다.
질문·답변은 같은 통화의 발화에서 읽으며 FAQ의 현재 질문·답변으로 대신하지 않는다. FAQ 수정·삭제 후에도 상담 원문은 유지된다.
FAQ를 삭제했으면 FAQ 번호의 연결 화면은 404일 수 있다. 통화 당시 원문과 역사적 번호는 보존한다.
미답변 원문을 이벤트 JSON에 복사하거나 삭제 후 복원하지 않는다. 미답변의 FAQ 전환은 기존 상담의 미답변 사실을 바꾸지 않는다.
사유도 이벤트 입력에 중복 저장하지 않고 기존 unansweredQuestionSeq로 연결한 질문에서 조회한다. 새 앱 전에 migration 049를 적용하며 [사유·필터 계약](../../backend/docs/unanswered-question-reasons.md)을 따른다.
HANDOFF_REQUESTED는 연결 완료가 아니며 ORDER_CREATED는 결제·디버 접수 성공을 뜻하지 않는다.

## 조회·화면 규칙

1. 동작은 AI_ACTION, 처리 결과는 BUSINESS_RESULT로 먼저 범위를 제한한 후 eventOrder ASC, eventId ASC로 정렬한다.
2. 같은 초·위치 null·순번 누락을 그대로 보존한다. 3번 다음 8번이어도 빈 순번을 만들지 않는다.
3. limit+1개로 hasNext를 계산한다. 50개는 AI 수집 요청당 한도이며 조회·통화 누적 한도가 아니다.
4. 모든 JOIN을 선택 통화로 제한하고 결과 조회 한 번에서 질문·답변을 가져온다. 건별 추가 조회를 만들지 않는다.
5. GET은 업무 기록·상태를 변경하거나 업무 성공 감사를 추가하지 않는다. DB 실패를 빈 성공 응답으로 숨기지 않는다.
6. 늦은 이벤트는 중간에 들어올 수 있어 offset 페이지가 바뀔 수 있다. 여러 HTTP 페이지의 고정 스냅샷은 보장하지 않는다.
7. 통화 상세 data.aiActionCount는 현재 수집된 AI 동작 전체 건수다. 목록 data.length와 다르며 통화 전체 활동 완료를 뜻하지 않는다.
8. offsetSeconds=31은 00:31, 80은 01:20이다. null은 위치 미확인으로 표시한다. 원문·요약을 HTML로 해석하지 않는다.

## 오류·DB·검증 범위

기존 {error:{code,message,details},meta:{requestId}} 오류 계약을 사용한다.
400 INVALID_REQUEST 입력 오류, 401 UNAUTHORIZED 세션 없음·만료·비활성, 403 FORBIDDEN 권한 오류,
404 NOT_FOUND 통화 없음, 500 INTERNAL_ERROR 분류되지 않은 조회 오류다. 연결 장애 분류는 공통 예외 정책을 따른다.

049까지 적용한 기존 call_insight_events·call_utterances·unanswered_questions를 사용한다. 새 사유 컬럼만 JOIN하며 추가 테이블·뷰·이벤트 입력 변경은 없다.
신규 FAQ 답변 참조 세 개는 기존 이벤트 JSONB에 저장한다. [EVT-01의 참조·재전송 규칙](call-events.md)을 따른다.

검증 대상은 실제 관리자 인증, 두 검색 코드, 종류별 조회 분리·페이지 경계, 정수 초·null·과거 발화 보존,
FAQ 참조 검증·동시 재전송·전체 롤백, FAQ 수정·삭제 후 상담 원문 보존, 미답변 삭제 후 원문 숨김,
조회 실패 오류·로그 비노출 및 기존 통화·발화·분석 경로 회귀다.
실제 AI 전송·운영 배포와 AI/PBX 음성 시작점의 정밀 매핑은 별도 확인 대상이다.


모든 목록 응답의 최상위 total_count는 필수인 0 이상 정수이며 같은 검색·필터·권한 범위의 전체 결과 수다. limit·offset 적용 전 COUNT(*)를 목록 데이터와 같은 SQL 스냅샷에서 계산한다. 검색 결과 없음은 0이며 offset이 전체 건수를 넘어 data가 비어도 total_count는 유지한다. 기존 hasNext는 유지한다.
