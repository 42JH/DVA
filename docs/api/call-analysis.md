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

아래 핵심 분석 필드는 모두 필수다. 041의 신규 요약 6개 필드는 생략·null을 허용하며 둘 다 미수집으로 저장한다. 변경된 AI는 최종값을 모두 명시한다. 숫자·boolean 문자열은 변환하지 않는다. 042부터 대표 분류 `result`는 받지 않으며, 기존 코드값을 보내면 `400 INVALID_REQUEST`다.

```json
{
  "providerCallId": "rtc_example_120",
  "startedAt": "2026-10-30T10:00:00+09:00",
  "endedAt": "2026-10-30T10:03:40+09:00",
  "aiPersonaVersionSeq": 7,
  "isNewCustomer": false,
  "registeredParcelCount": 3,
  "faqAnswerCount": 2,
  "orderLookupCount": 1,
  "cancelledParcelCount": 1,
  "hasHandoffRequest": true,
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
| isNewCustomer | 선택 boolean 또는 null | 신규 true / 기존 false. AI 판정값 |
| registeredParcelCount | 선택 0 이상 int32 또는 null | 접수 확정 배송 상세 수. 주문 헤더 수가 아니며 결제 대기 포함 |
| faqAnswerCount | 선택 0 이상 int32 또는 null | FAQ를 사용해 답변한 건수 |
| orderLookupCount | 선택 0 이상 int32 또는 null | 접수 내역을 조회해 안내한 건수 |
| cancelledParcelCount | 선택 0 이상 int32 또는 null | 취소 완료 배송 상세 수 |
| hasHandoffRequest | 선택 boolean 또는 null | 상담원 연결 요구 여부. 연결 성공과 별개 |
| repeatQuestionCount | 0 이상 int32 또는 null | 되묻기 횟수. 미측정과 0을 구분 |
| hasComplaint | boolean 또는 null | 미판정 null과 확인된 불만 없음 false를 구분 |
| complaints | 배열, 최대 20개 | true이면 1개 이상. false/null이면 빈 배열 |

한 통화의 접수·취소·FAQ·접수 조회·상담원 연결 요구는 각각의 요약 값으로 함께 기록한다. 대표 분류로 합치거나 현재 주문 상태에서 추정하지 않는다.

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

- 새 앱 실행 전 041·042를 순서대로 적용한다. 041은 기존 `call_analyses`에 nullable 컬럼 6개를 추가하며 기본값·기존 행 보완은 없다. 042는 대표 분류 `result`와 해당 CHECK를 삭제하고, 기존 분석의 해시를 `result` 없는 계약으로 갱신한다. 다른 분석 값·저장 시각·성공 감사·FK는 보존한다. 실제 서버 적용은 별도다.
- 7개 값은 AI가 확정해 보낸다. 백엔드는 고객 상태·주문 상태·이벤트·현재 ACTIVE로 판정하거나 집계하지 않는다. `isNewCustomer`의 판정 시점과 반복 조회·답변의 집계 규칙도 AI 생산자가 정한다.
- `aiPersonaVersionSeq`는 백엔드 설정 API에서 받은 값 중 해당 통화가 실제 사용한 버전이다. AI가 통화 시작 때 고정해 종료 분석까지 유지하며, 백엔드는 존재 여부와 FK만 검증한다.
- 접수·취소는 `order_parcels` 기준이다. 접수 정보가 확정된 결제 대기 상세도 접수 건수에 포함한다. 미완료 수집 상세를 접수 건수로 세지 않는다. 취소는 이전 통화의 접수 건도 포함할 수 있어 두 건수를 상쇄하거나 비교하지 않는다.
- FAQ 답변·접수 조회는 AI의 집계값을 그대로 보존한다. 검색·조회 API 호출 횟수나 응답 배열 길이로 백엔드가 재계산하지 않는다. `shipmentLookupCount`와 `customerType`은 받지 않는다.
- 새 요약의 생략·null은 미수집, 숫자 0·boolean false는 확인한 없음이다. 요약 값들은 함께 존재할 수 있으며 상담원 연결 요구 여부도 AI가 전달한 값을 그대로 저장한다. 연결 성공·실패를 나타내는 값은 아니다.
- 새 요약의 생략·null은 정규화 해시에서 제외한다. 042 적용 후 기존 요청에서 `result`만 제거한 재전송과 요약의 명시적 null 재전송은 동일한 204다. 0·false 등 실제 값이 달라지면 409이고 누적 증가·덮어쓰기를 하지 않는다. 기존 분석에 나중에 요약을 추가하는 것도 다른 내용이므로 409다.
- 관리자 `GET /api/calls`, `GET /api/calls/{id}`는 같은 `analysis`에 새 6개 값을 제공한다. 분석 미수신은 analysis=null, 과거 분석의 새 값은 각각 null이다. [프론트 조회 계약](calls.md)을 따른다.

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

ANL-01 초 단위 계약은 025, 통화별 요약 확장은 041, 대표 분류 삭제는 042까지 팀 migration runner로 적용한다. 042는 분석 행 전체의 해시를 갱신하므로 기존 백엔드 중지·백업 후 적용하고 새 계약의 앱을 실행한다. 구버전 앱은 삭제된 컬럼을 요구하므로 함께 운영하거나 앱 이미지만 되돌리지 않는다. AI는 `result` 전송을, 프론트는 `analysis.result` 표시와 `?result=...` 필터를 제거해야 한다. 운영 DB 적용·실제 AI 전송·프론트 화면 연결은 별도다.

025부터 불만 위치는 offsetSeconds(정수 초)다. offsetMs는 거절한다. AI에서 소수 초를 버린 뒤 전송한다. 기존 데이터는 025가 밀리초를 1000으로 나눠 버림하고 해시도 새 계약으로 갱신한다. 분석 저장 시각은 보존하며 기존 024 파일은 변경하지 않는다.
