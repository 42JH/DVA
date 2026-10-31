# EVT-02 시간순 통화 이벤트 조회 — 다음 작업 상세 명세서

작성일: 2026-10-31 · 상태: 구현 전 검토용 상세 계약.
EVT-01에서 저장한 통화 이벤트를 프론트가 읽는 API다. 이번 EVT-01 커밋은 이 GET을 구현하지 않는다.
기준: [노션 담당 1 명세](https://app.notion.com/p/e7f88d0e227b82349af30127eb29c3d3), [디자인/목업 06 통화 상세](https://www.figma.com/design/KF2OWGsro61o3hYGPZQyp9?node-id=984-1971), 현재 [EVT-01](call-events.md).

## API 명세표

| 항목 | 내용 |
| --- | --- |
| API 번호 | EVT-02 |
| Method | GET |
| Path | /api/calls/{id}/events |
| 역할 | 저장된 발화·AI 동작·처리 결과를 통화 전체 순서로 조회 |
| 방향 | 프론트 → 백엔드 |
| 인증 | 기존 dva_session 관리자 세션 쿠키 |
| 권한 | ACTIVE OPERATOR / SUPERVISOR / SYSTEM_ADMIN |
| 관련 화면 | 06 통화 상세의 AI 동작·처리 내용·시간 위치 |
| 성공 | 200, 공통 목록 {data,hasNext} |
| 선행 | EVT-01 및 025·026 마이그레이션 |

## Request

```http
GET /api/calls/120/events?kind=AI_ACTION&limit=20&offset=0
Accept: application/json
Cookie: dva_session=<로그인 세션>
```

프론트는 기존 로그인 세션을 credentials: include로 전달한다.
AI_INSIGHTS_TOKEN은 프론트에 주지 않으며 Bearer 토큰만으로 이 GET을 호출할 수 없다.
관리자 GET에 변경용 Origin 필수 조건을 추가하지 않는다. 브라우저 CORS는 기존 설정을 따른다.
요청 본문은 없다.

| 위치 | 필드 | 타입 | 필수·기본값 | 설명 |
| --- | --- | --- | --- | --- |
| Path | id | integer | 필수 | 기존 callSessionSeq, 1~2147483647 |
| Query | kind | string | 선택 | UTTERANCE / AI_ACTION / BUSINESS_RESULT. 생략하면 전체 |
| Query | limit | integer | 기본 20 | 한 페이지의 개수. 1~100 |
| Query | offset | integer | 기본 0 | 건너뛸 개수. 0~Number.MAX_SAFE_INTEGER |

kind=, 알 수 없는 kind, 문자열·소수·범위 밖 숫자, 반복 query, 알 수 없는 query는 400이다.
기존 PaginationQueryDto·CallIdParamsDto와 목록 응답 클래스를 재사용한다.
EVT-01의 요청당 50개 제한은 이 GET의 페이지 크기와 별개다.

## Response — HTTP 200

```json
{
  "data": [
    {
      "eventId": "ea692c7e-4852-4b48-8e44-b3d6b63e9256",
      "eventOrder": 1,
      "kind": "UTTERANCE",
      "occurredAt": "2026-10-31T01:00:31.000Z",
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
      "occurredAt": "2026-10-31T01:00:32.000Z",
      "offsetSeconds": 32,
      "payload": {
        "action": "ADDRESS_SEARCH",
        "summaryText": "주소 검색 결과 1건",
        "orderSeq": null
      }
    },
    {
      "eventId": "b8e86a1b-05d4-47c2-a1a1-13a0885c9e93",
      "eventOrder": 3,
      "kind": "BUSINESS_RESULT",
      "occurredAt": "2026-10-31T01:01:20.000Z",
      "offsetSeconds": 80,
      "payload": {
        "action": "QUESTION_UNANSWERED",
        "orderSeq": null,
        "unansweredQuestionSeq": 51,
        "summaryText": "AI가 답변하지 못한 질문이 있습니다.",
        "questionText": "착불로 보내면 받는 사람이 얼마 내요?"
      }
    }
  ],
  "hasNext": false
}
```

공통 목록 계약대로 data·hasNext만 사용한다. meta·totalCount·totalPages를 목록 envelope에 추가하지 않는다.
X-Request-Id는 응답 헤더에 제공하며 모든 응답은 Cache-Control: no-store다.

| 필드 | 타입 | 의미 |
| --- | --- | --- |
| data | CallEvent[] | 필터·페이지에 해당하는 기록 |
| hasNext | boolean | 동일 필터에 다음 페이지가 있는지 |
| eventId | UUID string | EVT-01이 보존한 이벤트 식별자 |
| eventOrder | integer | 통화 전체 순번. 필터 후 1부터 다시 매기지 않음 |
| kind | enum | UTTERANCE / AI_ACTION / BUSINESS_RESULT |
| occurredAt | datetime | AI가 보고한 발생 시각. UTC ISO 8601로 반환 |
| offsetSeconds | integer / null | AI 통화 시작부터의 위치. 확인 불가면 null |
| payload | 종류별 객체 | 아래 응답 필드 |

### UTTERANCE payload

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| utteranceOrder | integer | 발화끼리 매긴 통화 내 순번 |
| speaker | CUSTOMER / AI | 발화자 |
| utteranceText | string | call_utterances에서 읽는 원문. 공백·줄바꿈 보존 |
| lastSentenceSeq | integer | 완결 구간에 마지막으로 반영된 문장 순번 |

이벤트의 call_utterance_seq와 같은 통화의 발화를 JOIN한다. 원문을 새로 만들거나 수정하지 않는다.
기존 GET /api/calls/{id}/transcript는 유지한다. 화면의 스크립트는 해당 API를 계속 사용할 수 있다.
ANL-01의 complaints[].utteranceOrders와 이 순번을 맞춰 불만 발화를 강조한다.

### AI_ACTION payload

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| action | EVT-01의 AI 동작 코드 | 동작 종류 |
| summaryText | string | 기록된 동작 결과. 평문으로 표시 |
| orderSeq | integer / null | 주문 상세 연결 번호 |

status·offsetMs·레이턴시를 반환하지 않는다. 프론트가 summaryText를 파싱해서 성공·실패를 추정하지 않는다.
FIELD_SAVED는 저장, ADDRESS_SEARCH·CUSTOMER_LOOKUP·ORDER_LOOKUP·FAQ_SEARCH는 해당 조회/검색 문구로 표시할 수 있다.
성공·실패 필터는 이 계약에 없다.

### BUSINESS_RESULT payload

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| action | EVT-01의 업무 결과 코드 | ORDER_CREATED / ORDER_CANCELLED / QUESTION_UNANSWERED / HANDOFF_REQUESTED / INQUIRY |
| orderSeq | integer / null | 주문 보기 연결 번호 |
| unansweredQuestionSeq | integer / null | AI 미답변 보기 연결 번호 |
| summaryText | string | 처리 설명 |
| questionText | string / null | 조회 전용 제안 필드. 연결 질문이 OPEN/REGISTERED이면 현재 원문, 연결 없음·DELETED이면 null |

questionText는 목업의 처리 내용 아래 질문 원문을 표시하기 위한 응답 보완안이다.
EVT-01 입력에 추가하지 않으며 unanswered_questions에서 JOIN해서 읽는다. 삭제된 질문 원문을 이벤트에 복사하거나 복구하지 않는다.
이 추가 필드는 기존 노션 EVT-02의 payload 설명보다 구체화한 안이므로 다음 구현 검토 때 함께 확인한다.
HANDOFF_REQUESTED는 실제 연결 완료로, ORDER_CREATED는 결제·디버 최종 접수 성공으로 표시하지 않는다.

## 조회·정렬·페이지 처리

1. 관리자 인증·권한을 먼저 확인한다. 인증되지 않은 요청에 통화 존재 여부를 노출하지 않는다.
2. 통화가 없으면 404다. 통화는 있으나 수집 기록이 없거나 필터 결과가 없으면 {data:[],hasNext:false}다.
3. kind 필터를 먼저 적용하고 eventOrder ASC, eventId ASC로 정렬한다. 저장 PK·수신 시각·offsetSeconds로 순서를 대체하지 않는다.
4. 같은 초의 이벤트, 위치 null, 순번 누락도 보존한다. 51번 다음 53번이어도 빈 52번을 만들지 않는다.
5. limit+1개를 조회해 hasNext를 계산한다. DB 오류를 빈 목록 성공으로 바꾸지 않는다.
6. 한 번의 이벤트 조회 SQL에서 원문·질문 JOIN을 처리해 건별 추가 쿼리를 만들지 않는다. 통화 범위를 모든 JOIN에 적용한다.
7. 늦게 도착한 이벤트로 다음 페이지의 위치가 바뀔 수 있다. 서로 다른 HTTP 요청 사이의 고정 스냅샷은 제공하지 않으며 화면 갱신 시 처음부터 다시 읽을 수 있다.
8. GET은 이벤트·발화·질문·주문 상태를 변경하지 않는다. 조회마다 업무 성공 감사를 생성하지 않는다.

AI 동작 전체 건수는 이 페이지의 data.length와 다르다. 목업의 전체 건수는 기존 통화 상세의 aiActionCount 보완 등 별도 합의로 제공해야 한다.
현재 hasNext로 전체 건수·마지막 페이지 번호를 추정하지 않는다.

## 프론트 사용 예

| 화면 영역 | 요청·표시 |
| --- | --- |
| AI 동작 | ?kind=AI_ACTION. offsetSeconds·action·summaryText 표시 |
| 처리 내용 | ?kind=BUSINESS_RESULT. 주문·질문 번호로 연결 |
| 스크립트 | 기존 /transcript 또는 이 GET의 ?kind=UTTERANCE |
| 통합 타임라인 | kind 생략. eventOrder로 표시 |

offsetSeconds=31은 00:31, 80은 01:20으로 표시한다. null이면 위치 미확인으로 표시하며 00:00을 만들지 않는다.
이 위치는 AI 통화 기준이다. PBX 녹취 시작점과 매핑이 확인되기 전에는 정확한 오디오 점프 위치를 보장하지 않는다.
원문·요약은 HTML로 해석하지 않고 평문으로 렌더링한다.

## 오류

기존 오류 envelope {error:{code,message,details},meta:{requestId}}를 사용한다.

| HTTP | code | 상황 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 잘못된 통화 번호·kind·limit·offset·반복/추가 query |
| 401 | UNAUTHORIZED | 로그인 세션 없음·만료·위조 |
| 403 | FORBIDDEN | 현재 계정의 권한·상태로 접근 불가 또는 허용되지 않은 Origin |
| 404 | NOT_FOUND | 통화 없음 |
| 500 | INTERNAL_ERROR | 분류되지 않은 조회 오류. 원문·SQL·토큰 미노출 |

DB 연결 장애는 실제 기존 예외 분류를 따르며 성공 빈 목록으로 숨기지 않는다.

## 구현 범위·검증 기준

- call-insights에 이벤트 Query DTO·응답 DTO·조회 Repository/Service/Controller를 추가한다. 기존 세션 인증·페이지 규약을 재사용한다.
- 현재 026의 통화별 순번 UNIQUE 인덱스를 우선 사용한다. 새 DB 테이블·뷰·수집 API·AI 동작 status는 추가하지 않는다.
- 검증: 관리자 3개 역할, AI 토큰만 있는 호출, 만료 세션, 다른 통화 혼입 차단, 세 kind 필터, 120개 이상의 페이지 경계, 같은 초·null·역순 도착, 미수집/미존재 구분.
- 검증: 원문 보존, 질문 삭제 후 null, 주문·미답변 링크, 조회 실패 시 오류, HTTP 로그의 원문·토큰 미노출, GET 전후 DB 값 동일.
- 기존 /transcript·통화 상세·EVT-01 재전송·ANL-01 초 단위 계약을 회귀 검증한다.
- 아직 구현·검증·운영 배포된 API가 아니다. 실제 AI 생산 규칙·녹취 위치 매핑은 별도 확인 대상이다.
