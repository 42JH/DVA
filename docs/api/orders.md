# 주문 API 계약

현재 결제 정책은 [138 주문 결제 계약](order-billing.md)과 [AI 연동 규격](ai-order-billing-integration.md)을 따른다. AI는 상담 중 주문을 계속 저장하지 않고, **상담 결과를 `POST /api/orders` 한 번으로 전달**한다. 백엔드가 완료 여부와 결제 방식을 검증하고 결제 대기 또는 결제 완료 후 디버 접수를 처리한다. 미완료·취소·접수 주문은 같은 `orders`·`order_parcels`를 사용한다.

| 호출 | 처리 |
| --- | --- |
| `POST /api/admin/orders` | 관리자 FE 전용 수기 접수. 완성 주문 한 요청으로 결제 대기 또는 디버 접수 결과를 반환. [수기 접수 계약](manual-orders.md) |
| `POST /api/orders`, `outcome=COMPLETE` | 통화·고객·금액·결제 자격 검증 → 개인 카드 결제 대기 / 월·그룹 결제 완료 후 디버 접수 |
| 같은 API, `INCOMPLETE` | 중도 종료·상담사 연결 시 수집한 항목을 `COLLECTING`으로 저장 |
| 같은 API, `CANCELLED` | 상담 중 고객 취소를 `CANCELLED`로 저장. 디버 취소 API가 아님 |
| `GET /api/orders`, `GET /api/orders/{id}` | 기존 목록·상세 조회. [조회 계약](order-read.md) |
| `PATCH /api/orders/{id}` | 기존 미완료 주문 보완. [수정 계약](order-update.md) |
| `POST /api/orders/{id}/submit` | 보완된 기존 주문의 최종 접수. AI의 새 완료 결과에는 추가 호출하지 않음. [접수 계약](order-submit.md) |
| `POST /api/orders/{id}/cancel` | 결제 전 주문 전체 즉시 취소. [취소 계약](order-cancel.md) |
| `POST /api/orders/{id}/parcels/cancel` | 상세번호 배열로 단건·복수 취소. 전부 취소되면 주문도 CANCELLED. [취소 계약](order-cancel.md) |

AI가 변경할 호출부와 전체 예시는 [AI·PBX 연동 명세](ai-pbx-recordings.md)를 따른다.

## API별 입력·응답

Orders는 주문 상태·접수·주문 내용의 관리를 담당한다. 주소와 물품은 주문의 일부이며, 배송 상태·추적번호 조회는 별도 배송 API의 책임이다.

| API | 받는 정보 | 반환하는 정보 |
| --- | --- | --- |
| `GET /api/orders` | 선택 Query: `customerSeq`, `status`, `from`, `to`, `recipientName`, `limit`, `offset` | `{data: [...], hasNext}`. 각 항목은 `orderSeq`, `customerSeq`, `status`, `paymentMethodType`, `pickupRequestedAt`, `createdAt`, `parcelCount`, `creationSource`, `totalAmount`, `paidAt`, `paymentDueAt` |
| `POST /api/orders` | `Idempotency-Key` UUID. AI는 `call`, `outcome`, 고객 지정, 결제 방식, 수거 시각, `parcels` | AI 결과는 `{orderSeq, version, status, callSessionSeq, parcelNo, totalAmount, paymentDueAt, paymentRequest}`. 기존 관리자 부분 저장은 `{orderSeq, version}`. 단건 응답의 `data`에 담음 |
| `GET /api/orders/{id}` | Path `id=orderSeq` | 주문·고객 번호, `status`, 결제 방식, 수거 시각, `version`, 생성·변경 시각, 디버 접수 참고번호·확인 시각, 총액·결제 완료 시각·대기 기한·현재 결제 요청, `parcels[]` |
| `PATCH /api/orders/{id}` | Path `id=orderSeq`, 필수 `expectedVersion`, 변경할 `paymentMethodType`, `pickupRequestedAt`, `totalAmount`, `parcels` | `{version}`. `COLLECTING`만 수정하며 상태는 유지. 수정 결과 전체는 상세 조회 |
| `POST /api/orders/{id}/submit` | Path `id=orderSeq`, 필수 `expectedVersion` | `{status}`. `notPaid`, `PAID`, `SUBMITTING`, `ACCEPTED`, `SUBMISSION_FAILED` 중 현재 접수 결과 |
| `POST /api/orders/{id}/cancel` | Path `id=orderSeq`. 본문 없음 | 204, 본문 없음. 전체 취소 재요청은 409 |
| `POST /api/orders/{id}/parcels/cancel` | Path `id=orderSeq`, 필수 본문 `orderParcelSeqs`: 중복 없는 상세번호 배열(1개 이상) | 204, 본문 없음. 이미 취소된 상세는 건너뛰며 하나라도 취소 불가이면 전체 거절 |
| `GET /api/customers/{id}/addresses` | Path `id=customerSeq`, 필수 Query `direction=ORIGIN 또는 DESTINATION`, 선택 `from`, `to`, `q`, `limit`, `offset` | `{data: [{orderSeq, orderParcelSeq, createdAt, address}], hasNext}`. 접수 완료 주문의 미취소 상세 주소만 조회 |

- 단건 응답은 `{data, meta: {requestId}}`, 목록·이전 주소는 `{data: [], hasNext}`다.
- 목록의 `limit` 기본값은 20(최대 100), `offset`은 0이다. `from` 포함·`to` 미포함이며 시간대 포함 ISO 8601을 사용한다. 최신 생성 시각·주문 번호 순으로 정렬한다.
- 상세의 `parcels[]`에는 상세 번호·순번, `origin`, `destination`, `originPin`, 수량 4종, 기타 물품 설명, 요청 사항, 안내 요금, 물품 가액을 반환한다. 주소는 이름·전화번호·도로명·지번·상세 주소·동명·우편번호·위경도의 9개 필드다.
- `PATCH`는 생략한 값을 유지하고 nullable 필드의 `null`은 비운다. 상세 번호가 있으면 수정하고 없으면 추가하며, 생략한 상세를 삭제하지 않는다. `status`를 임의로 바꾸는 API는 아니다.
- 새 AI 상담 완료는 `POST /api/orders`의 `COMPLETE` 한 번으로 접수까지 처리한다. `/submit`은 이미 저장된 미완료 주문을 보완한 뒤 접수할 때 사용한다.
- 이전 주소 조회는 배송 상태 조회가 아니다. 해당 고객의 `ACCEPTED` 주문에서 출발지 또는 도착지 스냅샷을 읽으며 배송 추적을 하지 않는다.

### 주문 상태

목록·상세의 `status`는 기존 DB `orders.status`를 그대로 반환한다. 016~019 migration으로 가격·부서·결제·월별 원장을 반영한다. 주문 진행은 status 하나로 관리한다.

| status | 의미 |
| --- | --- |
| COLLECTING | 미완료·정보 보완 중 |
| notPaid | 개인 카드 결제 대기 |
| PAID | 결제 완료 |
| SUBMITTING | 디버 접수 중 또는 결과 저장 미확정 |
| ACCEPTED | 디버 접수 완료 |
| SUBMISSION_FAILED | 디버 접수 실패. 관리자 재접수 대상 |
| CANCELLED | 취소된 주문 |

### 배송 조회 분리에 따른 호출부 변경

- `GET /api/orders`의 `shipmentStatus` Query와 `shipmentStatuses` 응답을 제거했다. 이전 Query를 보내면 `400 INVALID_REQUEST`다.
- `GET /api/orders/{id}`의 `parcels[].shipment`를 제거했다. 추적번호·배송 상태·배송 버전을 Orders에서 읽지 않는다.
- 디버 접수 성공 시 기존 배송 데이터·초기 이력을 함께 저장하고, 이미 배송 데이터가 있는 주문의 중복 접수도 계속 차단한다. 기존 데이터를 삭제하지 않으며 별도 배송 조회 API는 이번 변경에서 추가하지 않는다.
- Swagger 태그는 `Orders`를 유지하고 제목·설명의 명세 번호는 제거했다.

## AI 결과 요청

```http
POST /api/orders
Content-Type: application/json
Idempotency-Key: 00000000-0000-4000-8000-000000000055
```

```json
{
  "outcome": "INCOMPLETE",
  "call": {
    "providerCallId": "sess_example",
    "callerPhoneNumber": "+821012345678",
    "incomingAt": "2026-10-27T01:00:00Z"
  },
  "customer": { "name": "고객", "phoneNumber": "01012345678" },
  "parcels": [{ "origin": { "roadAddress": "서울시 예시로 1" } }]
}
```

- `call`과 `outcome`은 함께 전달한다. 새 AI 흐름에는 `call_session_seq` 헤더가 필요 없다.
- `providerCallId`: OpenAI 통화 세션 ID. 1~200자, 공백 불가. PBX `recordingId`와 다르다.
- `incomingAt`: OpenAI **수신 이벤트의 `created_at`(Unix 초)**을 시간대 포함 ISO 8601로 변환한다. AI 서버 수신 시각으로 대체하지 않는다.
- 같은 세션의 발신번호·수신 이벤트 시각은 변경할 수 없다. `+82`·`0082`는 국내 `0`으로 통일한다.
- 상담 시작 시 POST /api/customers/context에 phoneNumber와 call(providerCallId·incomingAt)을 보내 통화 번호를 먼저 받는다. 결과 전송은 같은 통화 정보를 사용하며 기존 통화에 주문을 연결한다. 기존처럼 고객 확인 없이 call·outcome을 보낸 요청도 지원한다.
- `customerSeq` 또는 `customer` 중 하나로 고객을 지정한다. 고객의 번호는 발신번호와 같아야 한다. 이름·번호로 미등록 고객을 지정하면 주문과 같은 트랜잭션에서 생성한다. 기존 고객 이름·상태는 덮어쓰지 않는다.
- `INCOMPLETE`·`CANCELLED`는 고객을 생략할 수 있다. 발신번호와 일치하는 활성 고객이 있으면 연결하고, 없으면 `customer_seq=NULL`로 보존한다. 알 수 없는 이름을 만들어 고객으로 등록하지 않는다.
- `COMPLETE`는 고객 지정과 필수 주문 정보가 필요하다. 디버 전달 형식의 주소·물품·가격·결제 자격을 검증한다. 부족하면 `422 VALIDATION_FAILED`이며 해당 요청에서 새로 저장한 통화·고객·주문을 롤백한다. 고객 확인에서 이미 저장한 통화는 보존한다.

| 주문 필드 | 규칙 |
| --- | --- |
| `paymentMethodType` | `billing`: 개인·기업 개인 카드, 기본값 / `credit`: 월결제 사용 자격 필요 / `groupBilling`: 활성 소속 부서의 그룹결제 자격 필요 |
| `pickupRequestedAt` | 시간대 포함 ISO 8601. 생략·null 가능. 최종 수거 시각은 결제 완료 시각 + 1시간으로 서버가 결정 |
| `parcels` | 상세 목록. 미완료는 생략·빈 배열 가능, 완료는 한 건 이상 |
| `origin`, `destination` | 이름·숫자 전화번호·도로명·지번 주소·동명·5자리 우편번호·위경도. 완료 시 모두 필요하며 상세 주소는 선택 |
| `originPin` | 선택. `scope`(PERSONAL/COMPANY), `pinSeq`. 해당 고객의 사용 권한 검사 |
| 수량 | `documentCount`, `smallBoxCount`, `mediumBoxCount`, `bigBoxCount`: 정수 0~2147483647, 기본 0 |
| 물품·요청 사항 | `otherItemDescription`, `clientComment`: 기본 빈 문자열. 완료는 양의 수량 또는 기타 물품 설명 필요 |
| `itemPrice` | 물품 가액, 0~Number.MAX_SAFE_INTEGER 정수. 완료 시 필수 |

AI는 totalAmount와 상세별 notifiedPrice를 전달한다. 최종 확정에는 양의 정수 배송비와 미취소 상세 합계의 일치가 필요하며 itemPrice는 별도 물품 가액이다. 서버는 상세 순번을 지정한다. 호출자는 `status`, `version`, 디버 결과를 지정할 수 없다.

## 응답과 트랜잭션

```json
{
  "data": {
    "orderSeq": 123,
    "version": 4,
    "status": "ACCEPTED",
    "callSessionSeq": 7,
    "parcelNo": "TEST0057",
    "totalAmount": 3500,
    "paymentDueAt": null,
    "paymentRequest": null
  },
  "meta": { "requestId": "요청 추적 UUID" }
}
```

`ACCEPTED`만 디버 접수 성공이다. `parcelNo`는 참고번호이며 주문 고유 키는 `orderSeq`다.

| HTTP / status | AI 처리 |
| --- | --- |
| 201 / `COLLECTING` | 미완료 저장 완료 |
| 201 / `CANCELLED` | 상담 중 취소 기록 완료 |
| 201 / `ACCEPTED` | 디버 접수와 결과 DB 저장 완료. 고객에게 접수 완료 안내 |
| 201 / `notPaid` | 개인 카드 결제 대기. 디버 미전송 |
| 201 / `PAID` | 결제 완료. 전송 복구 대상 |
| 201 / `SUBMISSION_FAILED` | 디버 접수 실패. 관리자 재접수 대상 |
| 202 / `SUBMITTING` | 처리 중 또는 결과 DB 저장 미확정. 같은 생성 키로 재확인 |

1. 하나의 DB 트랜잭션에서 요청 키 잠금 → 통화 생성·조회 → 고객 연결·등록 → 주문·상세·통화 연결·감사를 저장한다. COMPLETE는 접수 조건·총액·결제 자격까지 검증하고 billing은 notPaid, 월·그룹은 PAID를 커밋한다.
2. 결제 완료 주문만 SUBMITTING을 커밋한 뒤 트랜잭션 밖에서 디버에 한 번 요청한다. 응답 본문까지 최대 10초, 자동 재전송 없음.
3. 성공 시 주문 상태·디버 참고값·택배별 배송·초기 이력·감사를 함께 커밋한 뒤 AI에 응답한다. DB와 외부 디버를 하나의 원자적 트랜잭션으로 묶을 수는 없다.

고객·기업 소속을 다른 요청이 변경 중이면 DB 잠금이 풀릴 때까지 기다린 뒤 최신 상태로
PIN·결제 자격을 검사한다. 각 잠금 획득 대기는 최대 2초이며 초과하면 이번 저장 전체를
롤백하고 `409 REQUEST_IN_PROGRESS`를 반환한다. 이때 디버는 호출하지 않는다.
이 규칙은 공통 처리를 사용하는 관리자 수기 접수에도 적용된다. 대기 자체가 권한을 보장하지는
않으므로 소속 비활성화가 먼저 완료됐다면 기업 PIN·그룹카드 사용은 403이 될 수 있다.

## 재시도

- `Idempotency-Key`는 **주문 의도별 UUID**다. AI가 전송 전에 보관하고 재시도·재시작에도 유지한다. `sessionId-1` 같은 문자열은 UUID가 아니므로 400이다.
- 키는 기존 `orders.creation_request_id` UNIQUE에 저장한다. 별도 중복 검증 테이블은 없다.
- 같은 키는 기존 주문의 현재 상태·버전을 반환하며 본문을 다시 적용하지 않는다. PAID이면 전송을 이어가고 SUBMITTING·ACCEPTED·SUBMISSION_FAILED는 자동 재전송하지 않는다. COMPLETE 전송 후 종료 이벤트에서 같은 주문을 CANCELLED로 덮어쓰지 않는다.
- 동시에 첫 저장 중이면 `409 REQUEST_IN_PROGRESS`, 디버 처리 중이면 `202 SUBMITTING`이다.
- `SUBMITTING`의 마지막 갱신 후 1분이 지난 재호출은 `SUBMISSION_FAILED`로 전환한다. 결과가 불명확한 주문을 새 키로 다시 보내면 안 된다.
- 현재 DB 관계는 통화 한 건에 주문 한 건이다. 여러 택배는 `parcels`로 묶는다. 같은 통화에 다른 키로 새 주문을 생성하면 409다.
- 세션 ID를 바꾸거나 다른 고객의 키를 이용할 수 없다. 기존 관리자 생성 키는 최초 생성자만 재사용할 수 있다.

## 기존 관리자·통화 헤더 호출

관리자 FE의 신규 수기 접수는 [POST /api/admin/orders](manual-orders.md)를 사용한다. AI의 `call`·`outcome` 규격은 유지한다. 신규 주문의 접수 경로는 서버가 AI/ADMIN으로 저장하고 기존 주문 목록·상세의 `creationSource`로 반환한다. 012 이전 출처 미확인 주문은 UNKNOWN이다.

`call`·`outcome` 없이 기존 `{customerSeq 또는 customer, parcels, ...}`를 보내면 종전처럼 COLLECTING을 저장하고 `{orderSeq,version}`을 반환한다. 관리자는 활성 세션과 허용 Origin이 필요하다. 이전 AI 헤더 방식도 호환 유지하지만 신규 상담 결과에는 사용하지 않는다.

조회·수정·기존 접수 API의 `call_session_seq`는 **DB의 양의 정수**이며 인증 토큰이 아니다. 이 헤더를 브라우저/공개 프록시로 보낼 때는 각 Nginx 계층의 `underscores_in_headers on;` 설정이 필요하다. 새 AI 결과 생성은 본문으로 통화를 전달하므로 이 헤더에 의존하지 않는다.

MVP 합의에 따라 AI 서비스 인증은 아직 생략한다. 관리자 쿠키를 보낸 요청은 정상 세션 검사를 거치며, 잘못된 쿠키를 AI 요청으로 전환하지 않는다. PBX Bearer 인증은 유지한다.

고객이 미확인된 미완료 주문은 관리자 조회와 수신 결과 재확인이 가능하지만, 기존 PATCH·submit은 활성 고객 연결을 요구한다. 고객 미확인 주문의 사후 고객 지정 기능은 이 변경에 포함하지 않는다.

## 검증 및 DB

- `011-call-recording-correlation.sql`은 OpenAI 이벤트 시각과 기존 PBX 수신함의 연결·재시도 컬럼만 추가한다. 가격·결제 개편에는 016~019 migration과 결제 요청·기업 원장 테이블을 추가한다.
- `npm run check:docker`: 단위·HTTP·실제 임시 PostgreSQL·모의 디버/S3·동시 요청·실패 복구·Nginx 회귀.
- `infra/database/test-monolith.ps1`: 데이터 보존·제약·반복 적용·체크섬·실패 롤백·백업 복원.
- 실제 AI 클라이언트 수정, 실제 디버 전송, AWS 리소스 생성과 운영 배포는 수행하지 않는다. AI 측 변경점은 [연동 명세](ai-pbx-recordings.md), 사용자 AWS 설정은 [S3 설정](recording-s3-setup.md)에 정리한다.
