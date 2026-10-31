# UNQ-02 미답변 목록·검색 조회

| 항목 | 계약 |
| --- | --- |
| API | GET /api/unanswered-questions |
| 방향 | 프론트 → 백엔드 |
| 인증 | 기존 dva_session 관리자 쿠키. 프론트는 credentials: include |
| 권한 | ACTIVE OPERATOR / SUPERVISOR / SYSTEM_ADMIN |
| 사용처 | 홈 미리보기, AI 미답변 관리 목록, 통화 상세에서 선택한 질문 조회 |
| 선행 | migration 026까지 적용, [UNQ-01](unanswered-questions.md) 질문 수집 |
| 응답 | HTTP 200, 기존 목록 형식 { data, hasNext } |

DB에 수집된 질문을 조회한다. AI 호출·추가 토큰 설정은 없으며 AI_INSIGHTS_TOKEN 미설정도 관리자 조회를 막지 않는다.
AI 토큰만으로 조회할 수 없다. 조회는 질문·통화·분석·고객·FAQ·감사 기록을 변경하지 않는다.

## Request

본문 없음. 다음 query만 허용하며 반복 query·추가 필드·형식 오류는 400이다.

| Query | 타입 / 기본값 | 의미 |
| --- | --- | --- |
| unansweredQuestionSeq | 양의 int32 / 생략 | 통화 상세에서 선택한 질문 한 건으로 좁힘 |
| callSessionSeq | 양의 int32 / 생략 | 한 통화에서 발생한 질문만 조회 |
| aiPersonaVersionSeq | 양의 int32 / 생략 | 통화 분석에 기록된 실제 사용 버전. 분석 미수신은 제외 |
| status | OPEN / REGISTERED, 기본 OPEN | 현재 업무 처리 상태. DELETED·ALL은 허용하지 않음 |
| q | 최대 200자 / 생략 | 질문 원문·현재 연결 고객 이름·통화 발신번호 중 하나의 부분 일치 |
| from / to | 시간대 포함 ISO 8601 / 생략 | 둘 다 지정하거나 둘 다 생략. 통화 시작 시각 from 포함·to 미포함 |
| limit | 정수 1~100 / 20 | 반환할 최대 질문 개수 |
| offset | 정수 0~9007199254740991 / 0 | 같은 검색 결과에서 건너뛸 개수 |

숫자 query는 정수 표기의 문자열을 숫자로 변환한다. 소수·지수 표기는 거절한다.
q는 NFC 정규화·앞뒤 공백 제거 후 비어 있으면 조건을 적용하지 않는다. NUL은 거절한다.
영문 대소문자를 구분하지 않으며 한글 정규화를 맞춰 검색한다. %·_·SQL처럼 보이는 문자열도 일반 문자다.
전화번호는 통화에 저장한 문자열을 검색하며 하이픈 등을 임의 제거하지 않는다.
q 안의 세 대상은 OR, 서로 다른 query 조건은 AND다. ID 필터의 대상이 없어도 404 대신 빈 목록이다.

```http
GET /api/unanswered-questions?limit=20&offset=0
GET /api/unanswered-questions?limit=6&offset=0
GET /api/unanswered-questions?callSessionSeq=120
GET /api/unanswered-questions?unansweredQuestionSeq=51
GET /api/unanswered-questions?q=주말&status=OPEN&limit=20&offset=0
GET /api/unanswered-questions?from=2026-10-30T15:00:00Z&to=2026-10-31T15:00:00Z
```

마지막 예시는 한국 시간 2026-10-31 하루다. from < to이며 실제 변환 가능한 서기 1년 이후 시각이어야 한다.
시각 형식·기간 한쪽 누락·역전·같은 경계·변환 불가능한 시각은 모두 400이다.

## Response

```json
{
  "data": [
    {
      "unansweredQuestionSeq": 51,
      "callSessionSeq": 120,
      "callStartedAt": "2026-10-31T01:00:00.000Z",
      "occurredAt": "2026-10-31T01:01:20.000Z",
      "offsetSeconds": 80,
      "customerSeq": 31,
      "customerName": "김철수",
      "callerPhoneNumber": "01012345678",
      "questionText": "주말에도 수거하나요?",
      "status": "OPEN",
      "aiPersonaVersionSeq": 7,
      "faqEntrySeq": null
    }
  ],
  "hasNext": false
}
```

| 필드 | 타입 | 의미 |
| --- | --- | --- |
| unansweredQuestionSeq | integer | 질문 한 번 발생의 번호. FAQ 전환·삭제 대상 |
| callSessionSeq | integer | 통화 상세로 이동할 번호 |
| callStartedAt | datetime / null | PBX 시작 시각 우선, 없으면 AI 분석 시작 시각. 모두 없으면 null |
| occurredAt | datetime | 질문 발생 시각. UTC ISO 8601 |
| offsetSeconds | integer / null | AI 통화 시작부터 정수 초. 80은 01:20, 0은 실제 시작, null은 위치 미확인 |
| customerSeq / customerName | integer / string / null | 연결 고객 번호·현재 이름. 과거 이름 스냅샷이 아님 |
| callerPhoneNumber | string / null | 통화에 저장된 발신번호. 선행 0 보존 |
| questionText | string | 수집한 원문. 공백·줄바꿈 보존. HTML로 해석하지 않는 평문 |
| status | OPEN / REGISTERED | 미처리 / FAQ 전환 상태. AI 동작 status와 별개 |
| aiPersonaVersionSeq | integer / null | 실제 사용했다고 ANL-01에 보고한 버전 |
| faqEntrySeq | integer / null | 전환한 FAQ가 현재 존재하면 번호, 미전환·FAQ 삭제 후 null |
| hasNext | boolean | 같은 검색 조건에 다음 질문이 존재하는지 여부 |

빈 결과는 아래와 같다. 질문 삭제·고객 미연결·분석 미수신을 서버 오류와 혼동하지 않는다.

```json
{ "data": [], "hasNext": false }
```

목록에는 meta·totalCount·totalPages를 추가하지 않는다. 응답 헤더 X-Request-Id·Cache-Control: no-store는 제공한다.
eventId·providerCallId·본문 해시·전환 해시·관리자 내부 정보는 반환하지 않는다.

## 연결·정렬·기간 규칙

1. unanswered_questions가 기준이며 status와 모든 조건을 적용한 뒤 페이지를 나눈다. 같은 통화의 여러 질문을 합치지 않는다.
2. 고객은 연결 주문의 customer_seq 우선, 연결 주문이 없으면 발신번호와 고객 전화번호의 정확한 일치로 연결한다.
   고객이 없으면 번호·이름은 null이다. WITHDRAWN 고객의 과거 질문도 제외하지 않으며 연결한 현재 고객 정보를 반환한다.
   이름 변경은 다음 조회·검색에 반영된다. 연결 주문 고객이 있으면 다른 발신번호 고객 이름을 검색 대상으로 사용하지 않는다.
3. PBX call_sessions.started_at이 있으면 우선 사용하고 없으면 call_analyses.ai_started_at을 사용한다.
   질문 발생·수집 시각과 incoming_at을 실제 시작 시각으로 대체하지 않는다.
4. callStartedAt ASC NULLS LAST, unansweredQuestionSeq ASC로 고정 정렬한다.
   시작 시각 미확인은 기간 없는 목록에는 남고 기간 검색에서는 제외된다.
   occurredAt은 기간·정렬 기준이 아니다. 분석·PBX 매칭 지연으로 다음 조회의 기간 소속·정렬 위치가 바뀔 수 있다.
5. 페르소나는 분석의 ai_persona_version_seq만 사용한다. 현재 ACTIVE 버전으로 소급하지 않는다.
6. FAQ가 삭제되면 응답의 faqEntrySeq만 null이며 REGISTERED 상태·원문·DB의 전환 대상 이력은 유지한다.
7. DELETED 질문은 ID로 선택해도 반환하지 않는다. OPEN으로 복원하거나 원문을 반환하지 않는다.
8. limit보다 한 건 더 읽어 hasNext를 계산한다. limit는 페이지 크기이며 저장 누적 제한이 아니다.
   offset 페이지는 조회 시점 기준이며 여러 페이지가 하나의 고정 스냅샷인 것은 아니다.

09 목업의 검색 결과 총건수·숫자 페이지에는 같은 검색 조건의 별도 총건수 계약이 필요하다.
이 API의 hasNext나 담당 2 대시보드 전체 미처리 건수만으로 마지막 페이지를 계산할 수 없다.
해당 경로·담당은 별도 확정 대상이며 목록에 총건수 필드를 임의 추가하지 않는다.

## DB·오류·검증

기존 unanswered_questions·call_sessions·call_analyses·orders·customers·faq_entries를 조회한다.
새 테이블·컬럼·뷰·migration·환경변수·의존성은 없다. 기존 migration은 변경하지 않는다.
담당 2의 통계용 뷰는 이 목록 API와 별도의 남은 작업이다.
FAQ 전환·질문 삭제 HTTP API는 아직 후속 작업이며 조회 테스트의 REGISTERED·DELETED는 DB fixture로 구성한다.

| HTTP | code | 조건 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 식별자·상태·검색어·기간·페이지 또는 추가·반복 query 오류 |
| 401 | UNAUTHORIZED | 활성 관리자 세션 없음·오류·만료. AI 토큰만 보내도 거절 |
| 403 | FORBIDDEN | 관리자 역할 권한 없음 |
| 500 | INTERNAL_ERROR | 분류되지 않은 DB 조회 등 서버 오류. 빈 목록으로 대체하지 않음 |

오류는 기존 error/meta 형식이며 검색어·질문 원문·토큰·SQL을 응답·일반 HTTP 로그에 복사하지 않는다.
검증 대상은 관리자 인증, AI 인증 미설정 시 관리자 조회, 엄격한 query·기간 검증, 원문·초 단위 위치,
상태·삭제 비노출, 주문 고객 우선·발신번호 대조·이름 변경, 부분 검색·문자 그대로의 검색,
PBX/AI 시각 우선순위·기간 경계·정렬, 실제 페르소나·늦은 분석, 페이지, 조회의 무변경성과 실패 비노출,
OpenAPI 및 기존 수집·통화 조회 회귀다. 실제 AI 전송·운영 DB·배포 확인은 별도다.
