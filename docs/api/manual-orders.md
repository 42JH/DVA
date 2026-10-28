# 관리자 수기 주문 접수

관련 이슈: [S15P31D109-69](https://ssafy.atlassian.net/browse/S15P31D109-69).

관리자가 입력을 끝내고 접수 버튼을 누르면 **FE가 완성된 주문을 한 번 전송**한다. 백엔드는 검증·주문 저장·디버 최초 접수·결과 저장을 처리하고 결과를 반환한다. 입력 중에는 디버를 호출하지 않는다.

| 호출자 | API | 접근 조건 |
| --- | --- | --- |
| 관리자 FE | `POST /api/admin/orders` | ACTIVE 관리자 세션 쿠키와 허용 Origin. 통화 정보 불필요 |
| AI 상담 | `POST /api/orders` | 기존 `call`·`outcome` 계약 유지. MVP 서비스 인증 생략 |

고객 연결·등록, PIN 접근, 결제 자격, 주소·물품 검증, 가격, 외부 전송 및 결과 저장 로직은 공통으로 사용한다. 기존 관리자 임시 저장·보완·`/submit`은 호환 유지한다. FE의 신규 수기 접수는 관리자 전용 API를 사용한다.

## 요청

```http
POST /api/admin/orders
Origin: http://localhost:5173
Cookie: dva_session=<로그인 쿠키>
Content-Type: application/json
Idempotency-Key: 00000000-0000-4000-8000-000000000069
```

```json
{
  "customerSeq": 123,
  "paymentMethodType": "credit",
  "pickupRequestedAt": "2026-11-01T10:00:00+09:00",
  "parcels": [{
    "origin": {
      "name": "발송인", "phoneNumber": "01012345678",
      "roadAddress": "서울시 예시로 1", "jibunAddress": "서울시 예시동 1",
      "detailAddress": "101호", "dongName": "예시동", "postalCode": "01234",
      "latitude": 37.5, "longitude": 127
    },
    "destination": {
      "name": "수령인", "phoneNumber": "01087654321",
      "roadAddress": "서울시 배송로 2", "jibunAddress": "서울시 배송동 2",
      "detailAddress": "", "dongName": "배송동", "postalCode": "05678",
      "latitude": 37.6, "longitude": 127.1
    },
    "smallBoxCount": 2,
    "itemPrice": 10000,
    "clientComment": "문 앞에서 연락"
  }]
}
```

- ACTIVE `OPERATOR`·`SUPERVISOR`·`SYSTEM_ADMIN` 모두 허용한다. 브라우저는 로그인 쿠키를 포함한다. 잘못된 쿠키를 익명 AI 요청으로 전환하지 않는다.
- `customerSeq` 또는 `customer: {name, phoneNumber}` 중 하나만 전달한다. 미등록 번호는 주문과 같은 트랜잭션에서 고객을 생성하고, 기존 활성 번호이면 연결한다. 기존 이름·상태를 덮어쓰지 않는다. 탈퇴 고객은 접수할 수 없다.
- 미래의 시간대 포함 `pickupRequestedAt`과 완성된 `parcels` 한 건 이상이 필수다. 출발·도착 이름/숫자 연락처/도로명·지번 주소/동명/5자리 우편번호/위경도, 물품 수량 또는 기타 물품 설명, 물품 가액이 필요하다. 상세 주소는 선택이다.
- `originPin: {scope, pinSeq}`는 선택이다. 관리자라도 주문 고객이 사용할 수 있는 PIN인지 검사한다. 주소 내용은 `origin`에 별도 전달한다.
- `credit`은 공통 기본값, `groupBilling`은 활성 기업 소속 고객, `billing`은 개인 고객만 사용한다. 실제 카드 승인·청구·환불 기능은 포함하지 않는다.
- `notifiedPrice=3500`은 **택배 상세별** 서버 지정 금액이다. 한 요청은 주문 한 건, 상세 수만큼 `order_parcels`, 접수 성공 후 상세별 `shipments` 한 건이다. 박스 수량마다 배송을 생성하지 않는다.
- `call`·`outcome`·`call_session_seq` 헤더·`status`·`version`·`creationSource`는 받지 않는다. 서버가 `creationSource=ADMIN`을 결정한다.

## 응답

```json
{
  "data": {
    "orderSeq": 123,
    "version": 2,
    "status": "ACCEPTED",
    "parcelNo": "TEST0069",
    "creationSource": "ADMIN"
  },
  "meta": { "requestId": "추적 UUID" }
}
```

`Location: /api/orders/123`과 `Cache-Control: no-store`를 반환한다. 응답에는 통화 번호를 포함하지 않는다. 기존 공통 주문 목록·상세에서 `creationSource`와 저장된 주문·배송 결과를 확인한다.

| HTTP / status | 의미 |
| --- | --- |
| 201 / `ACCEPTED` | 디버 접수와 결과 DB 저장 성공. 이 상태만 접수 완료 안내 |
| 201 / `AUTH_FAILED` | 디버 인증 거절. 서버 설정 확인 필요 |
| 201 / `REVIEW_REQUIRED` | 타임아웃·비정상 응답 등으로 실제 접수 여부 확인 필요 |
| 202 / `SUBMITTING` | 처리 중 또는 결과 저장 미확정. 같은 생성 키로 재확인 |

기존 임시 저장 주문의 키를 재사용하면 새로 접수하지 않고 그 주문의 현재 상태를 반환한다. 기존 임시 저장 주문의 최종 접수는 `/api/orders/{id}/submit`을 사용한다.

## 재요청과 실패 처리

1. FE는 주문 의도별 UUID를 **전송 전에 보관**한다. 중복 클릭·응답 유실·재시도에도 같은 키를 사용한다. 호출 중 버튼 중복 클릭을 막고, 응답을 못 받았다고 새 키로 접수하지 않는다.
2. 기존 `orders.creation_request_id` 고유 제약과 DB 잠금을 재사용한다. 별도 요청 키 테이블은 추가하지 않는다. 같은 키는 최초 생성자만 현재 결과를 조회하며 본문 재적용·디버 재전송은 없다.
3. `SUBMITTING` 커밋 후 DB 트랜잭션 밖에서 디버를 한 번 호출한다. 응답 본문까지 최대 10초이고 자동 재전송하지 않는다. FE 제한 시간은 이보다 여유 있게 설정한다.
4. 입력·고객/PIN/결제 자격·디버 설정 검증 실패는 신규 고객·주문·상세·생성 키를 함께 롤백한다. 같은 키로 입력을 보완해 다시 보낼 수 있다.
5. 결과 저장 실패는 `SUBMITTING`을 유지한다. 마지막 갱신 후 1분이 지난 같은 키 재호출은 `REVIEW_REQUIRED`로 전환하며 디버에 재전송하지 않는다.

| HTTP / code | 원인 |
| --- | --- |
| 400 / `INVALID_REQUEST` | UUID·본문 형식·고객 지정·추가 필드·통화 헤더 오류 |
| 401 / `UNAUTHORIZED` | 로그인 없음·만료·비활성 관리자 |
| 403 / `FORBIDDEN` | Origin, 활성 고객, PIN·결제 자격 또는 키 소유자 불일치 |
| 404 / `NOT_FOUND` | 고객 없음 |
| 409 / `REQUEST_IN_PROGRESS` | 같은 생성 키 또는 고객 소속 변경 처리 중 |
| 409 / `INVALID_STATE` | AI/출처 미확인 주문의 키를 수기 API에서 재사용 |
| 422 / `VALIDATION_FAILED` | 필수 주소·물품·미래 수거 시각 미충족. `details`의 필드 경로로 보완 |
| 503 / `DEPENDENCY_UNAVAILABLE` | 디버 설정 누락. 외부 전송 없음 |

## DB 및 검증

- `012-order-creation-source.sql`을 추가한다. 기존 001~011은 수정하지 않는다.
- `orders.creation_source`: AI / ADMIN / UNKNOWN. 신규 AI·관리자 주문은 서버가 구분한다. 기존 주문은 출처를 추측하지 않고 UNKNOWN으로 유지하며 주문 내용·상태·버전·시각을 보존한다.
- `node scripts/check.cjs`: 실제 NestJS HTTP·임시 PostgreSQL·로컬 디버 모의 서버로 권한, 다중 상세, 고객 등록, 결제/PIN, 재요청·동시 요청, 재시작, 타임아웃·결과 저장 실패, 기존 AI 및 Nginx를 검증한다.
- `infra/database/test-monolith.ps1`: 새 DB, 009/011에서 업그레이드, 데이터 보존·제약·실패 롤백·체크섬·반복 적용·백업 복원을 검증한다.
- Swagger: `/api/docs` → `Admin Orders`. FE 화면 연결, 실제 디버 주문 전송과 운영 배포는 이 변경에서 실행하지 않는다.
