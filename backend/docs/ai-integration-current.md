# AI 파트 연동 명세 — 2026-11-04

코드 기준: `feature/ai-call-updates`, DB migration `048`까지. 운영 서버에 이 코드·migration이 적용되었다는 뜻은 아니다. AI·프론트 소스와 실제 배포는 별도다. 과거 문서와 수거 시각·콜백·주소 권한·좌표·통화 등록·결제·접수 실패 상태·제거 필드 설명이 다르면 이 문서와 현재 DTO를 우선한다.

이 문서는 AI가 호출하거나 제공해야 하는 현재 계약을 모은다. 프론트 전달 사항은 [프론트 명세](frontend-integration-current.md), 이번 제거 내역과 DB 전환은 [작업 기록](unused-contract-cleanup.md)을 따른다.

## 1. 주소·인증·응답 공통

- AI가 같은 Docker 네트워크에 있으면 BE origin은 `http://backend:3000`, API prefix는 `/api`다. 외부 접속 origin은 실제 배포 설정으로 주입한다. 문서만 보고 운영 도메인·CORS 적용을 가정하지 않는다.
- JSON 요청은 `Content-Type: application/json`. 날짜는 시간대가 있는 ISO 8601, ID는 별도 설명이 없으면 양의 int32다.
- AI 요청에는 관리자 쿠키·브라우저 Origin을 넣지 않는다. 잘못된 관리자 쿠키를 보내도 AI로 우회하지 않는다.
- 현재 MVP의 무토큰 경로를 모든 관리자 API에 일반화하지 않는다. 토큰은 환경변수로 공유하며 프론트·로그에 노출하지 않는다.

| 호출                                                                  | 인증·추가 헤더                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `POST /api/customers/context` 및 허용된 고객 등록·상세·이름/주소 수정 | 현재 MVP AI 접근. 고객 상태 변경 등 관리자 전용 작업 제외                    |
| `POST /api/orders`의 AI 최종 결과                                     | `Idempotency-Key: <주문 결과별 UUID>` + 본문 `call`                          |
| 기존 주문 조회·취소, 개인 PIN, 과거 주문 주소 조회                    | `call_session_seq: <통화 번호>`로 발신 고객 범위 검증. 경로별 상세 계약 준수 |
| `GET /api/companies/search`                                           | 기업 공유 배송지 조회. 현재 MVP 계약 사용                                    |
| `GET /api/ai/faqs`                                                    | 현재 MVP 무토큰·통화 헤더 불필요                                             |
| 분석·이벤트·미답변 수집                                               | `Authorization: Bearer <AI_INSIGHTS_TOKEN>`                                  |
| 페르소나 설정 조회·적용 결과                                          | `Authorization: Bearer <AI_PERSONA_TOKEN>`                                   |
| BE → AI FAQ 변경 알림                                                 | `Authorization: Bearer <AI_FAQ_TOKEN>`                                       |
| BE → AI 페르소나 옵션·갱신 알림                                       | `Authorization: Bearer <AI_PERSONA_TOKEN>`                                   |

단건 응답은 `{ "data": ..., "meta": { "requestId": "..." } }`, 목록은 `{ "data": [], "hasNext": false, "total_count": 0 }`다. 204에는 JSON 본문이 없다. 오류는 `error.code`, `error.message`, `error.details`, `meta.requestId`를 읽는다. 전화번호·주소·불만 원문·토큰을 일반 로그에 출력하지 않는다.

## 2. 통화 수신 → 고객 확인 → 유효 통화 등록

1. 최초 전화 수신 이벤트의 `providerCallId`, `incomingAt`을 AI가 보관한다. 등록·재전송 때 현재 시각으로 교체하지 않는다.
2. 수신 직후에는 고객만 조회한다. 이 요청은 고객·통화·주문·NO_ORDER 이력을 생성하지 않는다.

```http
POST /api/customers/context
Content-Type: application/json
```

```json
{ "phoneNumber": "01012345678" }
```

3. 실제 접수·취소·접수 내역 조회·FAQ·상담원 연결 요구 등 업무 의도를 확인한 뒤 같은 API에 `call`을 추가한다.

```json
{
  "phoneNumber": "01012345678",
  "call": {
    "providerCallId": "rtc_original_session_id",
    "incomingAt": "2026-11-03T10:00:00+09:00"
  }
}
```

4. HTTP 200의 `data.callSessionSeq`를 보관한다. 같은 통화 ID·발신번호·수신 시각의 재전송은 같은 통화를 재사용한다. 다른 전화번호·시각으로 같은 ID를 쓰면 409다.
5. `data.lookupStatus`는 `REGISTERED`, `UNREGISTERED`, `WITHDRAWN`이다. 통화 등록과 고객 신규 등록은 별개다. 미등록·탈퇴 고객의 통화 번호가 생겨도 다른 고객의 주문·주소록 권한을 얻지는 않는다.
6. `data.customer`, `personalPins`, 소속·부서·가능 결제수단을 사용한다. 호환 필드 `companyPins`는 항상 빈 배열이며 기업 배송지는 `GET /api/companies/search`를 사용한다.

장난전화·무응답·업무 무관 통화는 2번 조회에서 종료한다. `call` 등록, 빈 주문, NO_ORDER, 분석·이벤트·미답변 쓰기를 보내지 않는다. 백엔드는 대화 내용을 다시 분류하지 않는다. [통화 등록 상세](meaningful-call-registration-handoff.md)

| 식별자                       | 의미·보관 규칙                                                         |
| ---------------------------- | ---------------------------------------------------------------------- |
| `providerCallId`             | 최초 AI 통화 ID. 모든 통화 쓰기에서 동일 값                            |
| `incomingAt`                 | 최초 수신 시각. 통화 5년 보관·PBX 연결 기준                            |
| `callSessionSeq`             | BE 통화 번호. 경로 `{id}`, 이벤트 연결, `call_session_seq` 헤더에 사용 |
| `orderSeq`, `orderParcelSeq` | 주문 헤더와 배송 상세의 서로 다른 번호                                 |
| `aiPersonaVersionSeq`        | 해당 통화가 실제 사용한 불변 설정 버전 ID. 표시용 `version`과 다름     |

## 3. 주소·주문·결제

### 주소

출발·도착 주소는 아래 7개 필드다. 완료 접수에는 상세주소를 제외한 값이 필요하며, 수집 중에는 기존처럼 부분 입력을 허용한다. 고객의 `address`에는 이름·전화번호를 중복 넣지 않는다.

```json
{
  "name": "수령인",
  "phoneNumber": "01087654321",
  "roadAddress": "서울시 예시로 2",
  "jibunAddress": "서울시 예시동 2",
  "detailAddress": "101호",
  "dongName": "예시동",
  "postalCode": "01234"
}
```

`latitude`, `longitude`는 선택 필드가 아니다. 숫자·문자열·null 모두 보내지 않는다. 보내면 400이며 BE도 디버 요청에 전송하지 않는다. 우편번호는 선행 0을 보존하는 문자열이다. [좌표 제거 상세](address-coordinates-removal.md)

### AI 결과 전송

`POST /api/orders`에 주문 결과별 UUID를 `Idempotency-Key`로 보낸다. 최초 시도 전에 만들고 재전송에도 같은 키·같은 본문을 유지한다. 이 방식은 본문 `call`로 통화를 연결하므로 별도 `call_session_seq` 헤더나 `/submit` 호출이 필요 없다.

```json
{
  "outcome": "COMPLETE",
  "call": {
    "providerCallId": "rtc_original_session_id",
    "callerPhoneNumber": "01012345678",
    "incomingAt": "2026-11-03T10:00:00+09:00"
  },
  "customerSeq": 12,
  "paymentMethodType": "billing",
  "totalAmount": 3500,
  "parcels": [
    {
      "origin": {
        "name": "발송인",
        "phoneNumber": "01012345678",
        "roadAddress": "서울시 예시로 1",
        "jibunAddress": "서울시 예시동 1",
        "detailAddress": "",
        "dongName": "예시동",
        "postalCode": "01234"
      },
      "destination": {
        "name": "수령인",
        "phoneNumber": "01087654321",
        "roadAddress": "서울시 배송로 2",
        "jibunAddress": "서울시 배송동 2",
        "detailAddress": "101호",
        "dongName": "배송동",
        "postalCode": "05678"
      },
      "smallBoxCount": 1,
      "itemPrice": 10000,
      "notifiedPrice": 3500
    }
  ]
}
```

- 기존 고객은 `customerSeq`, 신규 고객은 `customer: { name, phoneNumber }`를 사용하며 둘을 함께 보내지 않는다. 최종 결과에는 먼저 등록한 동일 `call`을 사용한다.
- `COMPLETE`는 주문 정보 확정이다. 카드 승인·디버 접수 성공을 뜻하지 않는다. 배송 상세별 `notifiedPrice`와 미취소 상세 합계 `totalAmount`가 필요하다.
- `paymentMethodType`은 `billing` 카드, `credit` 월결제, `groupBilling` 부서 그룹결제다. 자격은 BE가 검증한다. 미완료에서 생략하면 null이며 기본값으로 billing을 선택하지 않는다. 필드 자체에 null을 보내면 400이다. COMPLETE에는 선택이 필요하다.
- `pickupRequestedAt`은 선택값이며 결제 대기 중에도 보존한다. 결제가 요청 시각 이전 또는 같으면 유지하고, 이후 결제 또는 미전송이면 결제 완료 + 1시간을 한국시간 09:00~17:00에 맞춘다(09시 이전은 당일 09시, 17시 초과는 다음날 09시). AI가 보낸 시각에는 별도 영업시간·예약 일수 제한을 두지 않는다. 개인 카드·월·그룹결제 모두 같으며 재접수 시 다시 계산하지 않는다. [변경 계약](ai-call-follow-up.md)을 따른다.
- `INCOMPLETE`, `CANCELLED`는 확인한 정보만 보낸다. 주문 정보가 전혀 없는 유효 통화는 `status=NO_ORDER`, `orderSeq/version/paymentRequest=null`로 수신 완료된다. 질문·조회·연결 요구 이력은 같은 통화에 보존한다. NO_ORDER를 장난전화 제외 신호로 사용하지 않는다.

| 반환 `data.status`  | AI 처리                                                    |
| ------------------- | ---------------------------------------------------------- |
| `COLLECTING`        | 미완료 주문 저장                                           |
| `notPaid`           | 카드 결제 대기. 접수 성공 안내 금지                        |
| `PAID`              | 결제·정산 완료, 접수 결과 확인 필요                        |
| `SUBMITTING`        | 디버 요청 처리 중. 같은 주문 결과 키로 확인                |
| `SUBMITTING_FAILED` | 10분 기한 안에서 자동 재시도 중인 실패                     |
| `ACCEPTED`          | 디버 접수 성공. 이 상태만 접수 성공으로 안내               |
| `SUBMISSION_FAILED` | 자동 재시도 종료. 새 주문을 자동 생성하지 않고 담당자 확인 |
| `CANCELLED`         | 주문/상담 결과 취소 저장. 카드 환불 성공으로 해석하지 않음 |
| `NO_ORDER`          | 유효 통화 결과 수신 완료, 주문 번호 없음                   |

디버 응답은 최대 10초, 재신청은 최초 전송부터 10분 동안 마지막 전송 시작 기준 최소 1분 간격이다. 성공하면 중단한다. 서버 재시작·재호출로 기한을 연장하지 않으며 BE가 결제·청구를 반복하지 않는다. AI는 `SUBMITTING_FAILED`를 보고 새 UUID로 중복 주문을 만들지 않는다. 명시적 수동 재시도는 관리자 API다. 디버 자체의 멱등키·결과 조회 계약이 없어 응답 유실 후 외부 중복 접수 가능성은 별도 확인이 필요하다.

기존 주문 전체 취소는 `POST /api/orders/{id}/cancel`, 일부 취소는 `POST /api/orders/{id}/parcels/cancel`에 `{ "orderParcelSeqs": [34,35] }`를 보낸다. AI는 현재 통화의 `call_session_seq` 헤더가 필요하고 같은 발신 고객 범위·결제 전 취소 조건을 지킨다. 성공 204 후 재조회한다. `outcome=CANCELLED` 전송은 기존 주문 취소 API를 대신하지 않는다.

[주문 결제 상세](../../docs/api/ai-order-billing-integration.md) · [빈 주문 방지](empty-ai-order-results.md) · [10초·10분 재시도](order-submission-retry.md) · [취소](../../docs/api/order-cancel.md)

## 4. 최종 통화 분석 — AI가 7개 값을 확정

`POST /api/ai/calls/{callSessionSeq}/analysis`, `Authorization: Bearer <AI_INSIGHTS_TOKEN>`. HTTP 204이며 응답 JSON을 읽지 않는다. 분석 API는 통화를 생성하지 않는다.

```json
{
  "providerCallId": "rtc_original_session_id",
  "startedAt": "2026-11-03T10:00:00+09:00",
  "endedAt": "2026-11-03T10:03:40+09:00",
  "aiPersonaVersionSeq": 7,
  "isNewCustomer": false,
  "registeredParcelCount": 3,
  "faqAnswerCount": 2,
  "orderLookupCount": 1,
  "cancelledParcelCount": 1,
  "hasHandoffRequest": true,
  "hasCallbackRequest": false,
  "repeatQuestionCount": 0,
  "hasComplaint": false,
  "complaints": []
}
```

| 값                      | 의미                                                                           |
| ----------------------- | ------------------------------------------------------------------------------ |
| `isNewCustomer`         | 신규 true / 기존 false. T/F로 전송하며 문자열·고객 유형 enum을 보내지 않음     |
| `aiPersonaVersionSeq`   | 통화 시작 때 고정한 실제 적용 버전. BE가 현재 ACTIVE로 대신 채우지 않음        |
| `registeredParcelCount` | 접수 정보가 확정된 `order_parcels` 수. 헤더 1개에 상세 3개면 3, 결제 대기 포함 |
| `faqAnswerCount`        | FAQ를 사용해 답변한 건수                                                       |
| `orderLookupCount`      | 접수 내역을 조회해 안내한 건수. shipment 필드명을 쓰지 않음                    |
| `cancelledParcelCount`  | 취소 완료 배송 상세 수. 이전 통화의 접수 건 취소도 가능                        |
| `hasHandoffRequest`     | 상담원 연결 요구 여부. 연결 성공·실패 상태가 아님                              |
| `hasCallbackRequest`    | 콜백 요청 여부. 기존 발신번호로 연락하며 별도 콜백 처리 완료 상태는 없음      |

네 건수는 0 이상 int32, 세 boolean은 true/false다. 요약 7개는 생략·null을 허용하지만 미수집을 뜻한다. 새 AI는 측정한 최종값을 모두 명시한다. `0`, `false`, `null`을 구분하며 BE는 주문·이벤트를 다시 세어 덮어쓰지 않는다. 콜백은 별도 접수 API 없이 최초 최종 분석에 `hasCallbackRequest`로 포함한다. 생략/null은 기존 해시를 유지하며 확정 후 true/false 변경은 다른 분석과 동일하게 409다.

기존 핵심 필드 `aiPersonaVersionSeq`, `repeatQuestionCount`, `hasComplaint`, `complaints`, 시작·종료 시각은 필수다. nullable 허용과 생략 허용은 다르다. `hasComplaint=true`이면 근거 1개 이상, false/null이면 `complaints=[]`. 근거는 `type`, `evidenceText`, 정수 초 `offsetSeconds` 또는 null, 같은 통화의 `utteranceOrders`를 사용한다.

통화당 최종 분석 한 건이다. 동일 내용 재전송은 204, 다른 최종값은 409 `EVENT_PAYLOAD_CONFLICT`다. 먼저 임시 분석을 보낸 뒤 값이 모일 때마다 갱신하지 않는다. `result`, `customerType`, `shipmentLookupCount`, `endReason`, `handoff`, `offsetMs`는 분석 입력이 아니며 보내지 않는다. [필드·불만 근거·오류 상세](../../docs/api/call-analysis.md)

## 5. STT·AI 동작·업무 결과와 미답변

`POST /api/ai/calls/{id}/events`는 `AI_INSIGHTS_TOKEN`으로 수집한다. 한 요청에 1~50개, JSON 최대 100KiB다. `eventId`는 발생 시 UUID를 만들고 재전송에도 유지하며 `eventOrder`는 통화 전체에서 증가한다.

```json
{
  "providerCallId": "rtc_original_session_id",
  "events": [
    {
      "eventId": "ea692c7e-4852-4b48-8e44-b3d6b63e9256",
      "eventOrder": 1,
      "kind": "UTTERANCE",
      "occurredAt": "2026-11-03T10:00:31+09:00",
      "offsetSeconds": 31,
      "payload": {
        "utteranceOrder": 1,
        "speaker": "CUSTOMER",
        "utteranceText": "택배를 접수하고 싶어요.",
        "lastSentenceSeq": 1
      }
    }
  ]
}
```

성공 204. `UTTERANCE`, `AI_ACTION`, `BUSINESS_RESULT`별 payload가 다르며 임의 tool 인자·추가 status를 보내지 않는다. `HANDOFF_REQUESTED` 업무 이벤트는 유지한다. 별도 `handoff_requests` 쓰기 API는 없다. FAQ 답변 결과의 `FAQ_ANSWERED` 참조 필드와 순서·재전송 규칙은 [이벤트 상세](../../docs/api/call-events.md)를 따른다.

미답변은 `POST /api/ai/unanswered-questions`에 `eventId`, `callSessionSeq`, `providerCallId`, `questionText`, `occurredAt`, `offsetSeconds`를 보낸다. 같은 이벤트 UUID로 재전송한다. 생성 응답의 번호를 관련 업무 결과 이벤트에서 참조하는 계약은 [미답변 수집](../../docs/api/unanswered-questions.md)을 따른다.

삭제·만료된 주문을 참조하는 새 이벤트는 404다. 유효·만료 참조가 한 요청에 섞여도 전체가 롤백되므로 204가 아니면 일부 저장됐다고 가정하지 않는다. AI 이벤트·STT는 7일 로그 정리 대상이 아니다.

## 6. FAQ 원본 조회·변경 알림

- `GET /api/ai/faqs?faqEntrySeqs=123,124&limit=100&offset=0`. 단건도 같은 목록에 번호 하나를 지정한다.
- `faqEntrySeqs`는 중복 없는 1~100개. 결과는 번호 오름차순, `{ data, hasNext, total_count }`. 각 행은 `faqEntrySeq`, `question`, `answer`, `updatedAt`이며 관리자 식별자·분류를 포함하지 않는다.
- 삭제·미존재 번호는 결과에서 빠지며 빈 목록도 정상 200이다. 전체 동기화는 번호 필터를 생략하고 `hasNext=false`까지 순회한다.
- `GET /api/ai/faqs/{id}`는 제거되어 404다. 원본 단건 조회에 이 경로를 쓰지 않는다.

AI는 `POST /internal/faqs/refresh`를 제공한다. `AI_FAQ_TOKEN`을 검증하고 `{ eventId, operation, faqEntrySeqs }`를 재시작해도 유실되지 않게 저장한 뒤 **202**를 반환한다. 같은 eventId도 202다. INSERT/UPDATE는 최신 BE 원본을 조회해 색인하고 DELETE는 검색 데이터·벡터를 제거한다. 조회 요청에 있었지만 결과에 없는 번호도 제거한다. 202는 색인 완료 ACK가 아니므로 이후 작업 실패는 AI 내부에서 복구한다. [전체 FAQ 규격](../../docs/api/ai-faq-integration.md)

## 7. 페르소나 — 새 통화에만 전환

AI → BE는 `AI_PERSONA_TOKEN`을 사용한다.

| API                                 | 처리                                                 |
| ----------------------------------- | ---------------------------------------------------- |
| `GET /api/ai/config`                | ACTIVE 기본 설정 조회. 없으면 404                    |
| `GET /api/ai/config?status=PENDING` | 최신 적용 대기 설정과 applicationId 조회. 없으면 404 |
| `POST /api/ai/config/apply-result`  | 실제 설치 결과 APPLIED/FAILED 회신                   |

```json
{
  "aiPersonaVersionSeq": 7,
  "applicationId": "00000000-0000-4000-8000-000000000007",
  "result": "APPLIED"
}
```

위 `result`는 페르소나 적용 결과의 필수 필드다. 삭제한 **통화 분석의 result**와 구분한다. `activeCallCount`는 생략 가능한 호환값이며 적용 판단·저장에 사용하지 않는다.

새 통화 진입과 기본 설정 전환을 직렬화해 최신 PENDING을 확인하고 실제 프롬프트·음성·옵션을 준비한다. 실제 설치 후 회신하고 응답의 ACTIVE·버전·applicationId를 확인한 뒤 새 통화를 연다. 기존 통화가 끝날 때까지 기다리지 않으며 진행 중 통화는 시작 때 고정한 설정·버전을 유지한다. 회신 유실·409·재시작이면 다시 동기화한다. FAILED는 허용 errorCode가 필요하며 현재 PENDING·기존 ACTIVE를 유지한다.

AI가 제공하는 `GET /internal/persona/options`는 지원 옵션의 직접 JSON을, `POST /internal/persona/refresh`는 `{ aiPersonaVersionSeq, applicationId }` 변경 힌트의 202를 반환한다. 알림만 받고 APPLIED로 회신하지 않는다. 실제 옵션·인증·동시성 계약은 [다음 통화 적용](ai-persona-next-call.md)을 따른다.

## 8. 종료·삭제·보관·오류 처리

- PBX가 종료 웹훅을 보내면 BE가 연결된 통화의 종료를 반영하고 녹취 다운로드·S3 저장은 비동기 처리한다. AI는 녹취 저장 API나 진행 통화 수 증감 POST를 호출하지 않는다.
- 계속 연결되지 않은 PBX 수신은 BE 수신 시각부터 30분 후 정리한다. 이 30분은 통화 자동 종료·AI 분석 전송 기한이 아니다.
- 통화·녹취·STT·분석·AI 이벤트·미답변·의미 있는 NO_ORDER는 최초 `incomingAt`부터 5년이다. 늦은 업로드·분석·soft delete로 연장하지 않는다. 주문은 최초 완료/취소 시각, 미완료는 생성 시각 기준 5년이다.
- 삭제·만료된 통화에 새 데이터 전송은 404 또는 등록 시 409다. 과거 통화 ID·수신 시각을 바꾸어 재생성하지 말고 해당 전송을 종료한다. 토큰·의존성의 503이나 네트워크 장애는 같은 식별자·본문으로 재시도한다. 충돌 409는 무조건 재시도하지 말고 `error.code`를 구분한다.
- 삭제 FAQ와 AI 자체 검색 캐시·복제 데이터는 AI에서도 제거해야 한다. BE의 DELETE 알림이 AI 저장소까지 자동 삭제하는 것은 아니다.

## 9. 인계 확인 항목

1. 무의미 통화에는 등록·쓰기 없음, 유효 문의만 있는 통화는 정상 보존.
2. 최초 통화 ID·수신 시각·결과 UUID·이벤트 UUID를 재시작·재전송에도 유지.
3. 좌표·통화 분석 result·offsetMs 제거, 미선택 결제수단을 임의 billing으로 채우지 않음.
4. notPaid·SUBMITTING_FAILED·SUBMISSION_FAILED·NO_ORDER를 ACCEPTED와 구분.
5. 최종 요약 7개와 실제 적용 버전을 전송하고 null/0/false를 구분.
6. FAQ 단건도 목록 API 사용, DELETE·미존재 원본을 검색 데이터에서 제거.
7. 새 통화는 최신 페르소나, 기존 통화는 기존 버전으로 종료 분석까지 유지.
8. BE 로컬 검증과 실제 AI 배포·전화·디버·S3 연동 검증을 구분. 실제 연동은 양 파트 배포 후 확인.
