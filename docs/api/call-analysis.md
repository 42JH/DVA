# ANL-01 통화 종료 분석 결과 저장

`POST /api/ai/calls/{id}/analysis`는 AI 서버가 기존 통화의 최종 분석을 저장하는 API다.
이 문서는 ANL-01 계약이다. 이벤트 수집은 [EVT-01](call-events.md), 후속 이벤트 조회는 [EVT-02 상세 초안](call-events-read-spec.md)을 따른다.

## 인증과 통화 연결

- `Authorization: Bearer <AI_INSIGHTS_TOKEN>`, `Content-Type: application/json`.
- 백엔드의 `AI_INSIGHTS_TOKEN`에 32자 이상 공백 없는 ASCII 비밀값을 설정하고 AI 서버가 같은 값을 요청 헤더에 사용한다. 프론트에는 전달하지 않는다. 페르소나·FAQ 토큰과 용도가 다르다.
- 미설정이면 해당 API만 503이다. 잘못된 형식의 환경값은 변수 이름만 표시하고 시작을 중단한다.
- 관리자 세션만으로 수집할 수 없다. AI는 관리자 쿠키·브라우저 Origin 없이 호출한다.
- `{id}`는 양의 int32 `callSessionSeq`이며 `providerCallId`와 일치해야 한다.
- 기존 `POST /api/customers/context`에 call을 전달해 받은 번호를 사용한다. 이 API가 통화를 만들지 않는다.

## Request

모든 필드는 필수다. 아래에서 허용하는 미확인 값은 생략 대신 null로 보낸다.

```json
{
  "providerCallId": "rtc_example_120",
  "startedAt": "2026-10-30T10:00:00+09:00",
  "endedAt": "2026-10-30T10:03:40+09:00",
  "aiPersonaVersionSeq": 7,
  "result": "REGISTERED",
  "repeatQuestionCount": 2,
  "hasComplaint": true,
  "complaints": [
    {
      "type": "REPEATED_QUESTION",
      "evidenceText": "전화번호를 반복 질문하자 고객이 불편함을 표현함",
      "offsetSeconds": 31,
      "utteranceOrders": [3, 4, 5, 6]
    }
  ]
}
```

| 필드 | 타입·검증 | 용도 |
| --- | --- | --- |
| providerCallId | 공백·NUL 없는 문자열, 최대 200자 | 기존 통화 ID 검증 |
| startedAt / endedAt | 시간대 포함 ISO 8601, 종료 >= 시작 | AI 측정 통화 시간. PBX 원본은 보존 |
| aiPersonaVersionSeq | 양의 int32 또는 null | 실제 사용한 버전. 현재 ACTIVE로 대신 채우지 않음 |
| result | 아래 5개 코드 | 통화 종료 결과. 현재 주문 상태에서 재계산하지 않음 |
| repeatQuestionCount | 0 이상 int32 또는 null | 되묻기 횟수. 미측정과 0을 구분 |
| hasComplaint | boolean 또는 null | 미판정 null과 확인된 불만 없음 false를 구분 |
| complaints | 배열, 최대 20개 | true이면 1개 이상. false/null이면 빈 배열 |

통화 결과 코드는 REGISTERED(접수 성공), REGISTRATION_FAILED(접수 실패), HANDOFF(상담원 이관),
CANCELLED(주문 취소), INQUIRY(문의)다. 현재 합의 초안의 REGISTERED는 접수에 필요한 정보를 모아
기존 주문 API가 저장을 확인한 통화로, 결제 대기도 포함한다. 결제·디버 최종 접수 성공과는 별개다.
생산자인 AI가 확정한 결과를 보내며 백엔드는 주문 상태나 문장으로 결과를 추정하지 않는다.

Complaint 항목의 모든 필드도 필수다.

| 필드 | 검증 |
| --- | --- |
| type | REPEATED_QUESTION, SPEAKING_TOO_FAST, RECOGNITION_FAILURE, SLOW_RESPONSE, AI_REFUSAL |
| evidenceText | 공백 아닌 문자열, 최대 1,000자, NUL 금지. 공백·줄바꿈 등 원문 보존 |
| offsetSeconds | 0 이상 안전한 정수 또는 null. 통화 시작부터 불만 구간까지의 정수 초 위치이며 레이턴시가 아님 |
| utteranceOrders | 중복 없는 양의 int32 배열. 발화 연결 미확인은 빈 배열 |

AI_REFUSAL은 고객이 AI 상담을 거부했다는 뜻이다. SLOW_RESPONSE는 고객이 느리다고 표현한 불만이며
시간 임계값으로 자동 판정하지 않는다. 응답 지연 합계·측정 횟수는 받거나 저장하지 않는다.

발화 수집이 먼저 끝났다고 가정하지 않는다. 발화 순번은 해당 통화 안의 연결 정보로 저장하며
아직 수집되지 않은 발화를 생성하거나 다른 통화와 연결하지 않는다. 관리자 통화 상세·목록의 analysis가 불만 근거와 발화 순번을 제공한다. 프론트는 같은 통화의 transcript에서 실제 수신된 발화만 강조한다. [조회 계약](calls.md)을 따른다.

## 저장·재전송

- `024-call-analyses.sql`로 기존 DB에 call_analyses 한 테이블만 추가한다. 기존 001~023은 변경하지 않는다.
- 통화 PK가 곧 분석 PK다. 통화·실제 사용 버전 FK와 시각·횟수·불만 배열 제약을 둔다.
- 통화당 한 행만 INSERT하며, 동시 요청도 UNIQUE/PK가 중복 저장을 막는다.
- 시각은 UTC 밀리초로 정규화하고 발화 순번 배열은 정렬한다. JSON 키 순서·동일 시각의 표기 차이는 재전송으로 인정한다.
- 불만 배열 순서와 근거 원문은 보존한다. 내용이나 불만 배열 순서가 달라지면 다른 요청으로 간주한다.
- 정규화 본문의 SHA-256을 저장한다. 동일 요청은 204, 이미 저장한 통화에 다른 요청이면 409다.
- 분석과 AI 주체의 성공 감사는 같은 트랜잭션이다. 재전송은 성공 감사도 중복 생성하지 않는다.
- 기존 call_sessions의 PBX 시각·종료 사유, orders, 페르소나 적용 상태는 변경하지 않는다.
- API·일반 HTTP 로그·감사 metadata에 요청 원문·불만 원문·토큰을 복사하지 않는다.

## Response

성공은 `204 No Content`, 응답 본문 없음이다. 기존 X-Request-Id·Cache-Control: no-store와 오류 envelope를 사용한다.

| HTTP | code | 상황 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 필수값·타입·알 수 없는 필드·enum·불만 조합 오류 |
| 401 | UNAUTHORIZED | 서비스 토큰 누락·오류·중복 Authorization |
| 403 | FORBIDDEN | 통화와 providerCallId 불일치 |
| 404 | NOT_FOUND | 통화 또는 지정한 버전 없음 |
| 409 | EVENT_PAYLOAD_CONFLICT | 같은 통화에 다른 최종 분석 |
| 422 | VALIDATION_FAILED | 종료가 시작보다 빠르거나 저장할 수 없는 시각 |
| 503 | DEPENDENCY_UNAVAILABLE | AI 수집 토큰 미설정 |

ANL-01 초 단위 계약은 새 앱 실행 전에 025까지 적용한다. 현재 앱은 FAQ 분류를 포함해 027까지 팀 migration runner로 적용한다. 이번 통화 조회 보완의 추가 migration은 없다. 운영 DB 적용·실제 AI 전송·프론트 화면 연결은 별도다.

025부터 불만 위치는 offsetSeconds(정수 초)다. offsetMs는 거절한다. AI에서 소수 초를 버린 뒤 전송한다. 기존 데이터는 025가 밀리초를 1000으로 나눠 버림하고 해시도 새 계약으로 갱신한다. 분석 저장 시각은 보존하며 기존 024 파일은 변경하지 않는다.
