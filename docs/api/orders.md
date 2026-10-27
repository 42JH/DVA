# 관리자 주문 생성 API

관련 작업: [S15P31D109-55](https://ssafy.atlassian.net/browse/S15P31D109-55).

이번 구현은 팀 API 명세 ORD-01의 **미완료 주문 생성 방식**을 따른다. Jira 55·57의 최신 설명인 완성 주문 일괄 접수/별도 미완료 상담 저장과 다르며, 기존 API 명세를 유지한다는 작업 범위 결정에 따른다.

## 범위와 인증

`POST /api/orders`는 ACTIVE 상태의 OPERATOR·SUPERVISOR·SYSTEM_ADMIN 세션으로 호출한다. `/api/auth/login`에서 받은 `dva_session` 쿠키와 허용된 `Origin`을 보낸다. 브라우저는 `credentials: 'include'`를 사용하며 Postman은 쿠키 저장소와 `Origin` 헤더를 사용한다. 기존 공통 인증 정책은 유지하고 `X-CSRF-Protection` 헤더는 요구하지 않는다.

현재 AI의 통화 처리와 `/internal/ai` 업무 호출 클라이언트는 존재하지만, 모놀리식의 해당 수신 API·서비스 인증·요청 형식은 별도 연동이 필요하다. 이번 경로는 관리자용이며 AI 토큰이나 고객/관리자 ID 헤더로 인증을 대체할 수 없다.

## 요청과 응답

`Idempotency-Key` 헤더에 새 주문 의도마다 UUID를 보낸다. 응답을 받지 못해 재시도할 때는 같은 키와 본문을 사용한다. 요청 추적용 `X-Request-Id`와는 별개다.

```http
POST /api/orders
Content-Type: application/json
Origin: http://localhost:5173
Idempotency-Key: 3f5532fb-5510-4435-8d6b-aed01355d1f1
Cookie: dva_session=<로그인으로 받은 값>
```

```json
{
  "customerSeq": 31,
  "parcels": [{ "origin": { "name": "발송인" }, "smallBoxCount": 1 }]
}
```

고객은 먼저 DB에 존재하는 ACTIVE 고객이어야 한다. 위 식별자는 예시이며 생성 API가 고객을 자동 등록하지 않는다.

| 필드 | 규칙 |
| --- | --- |
| customerSeq | 필수, 1~2147483647 정수 |
| paymentMethodType | 선택, cat/billing/credit/groupBilling. 생략 시 credit |
| pickupRequestedAt | 선택, 타임존이 포함된 ISO 8601 시각 또는 null |
| parcels | 선택, 생략/빈 배열이면 상세 0개 |
| parcels[].origin / destination | 부분 주소 객체. 미수집 필드 생략/null 가능 |
| parcels[].originPin | 선택, null 또는 scope(PERSONAL/COMPANY)·pinSeq |
| parcels[].documentCount / smallBoxCount / mediumBoxCount / bigBoxCount | 0~2147483647 정수, 기본 0 |
| parcels[].otherItemDescription / clientComment | 문자열, 기본 빈 문자열 |
| parcels[].itemPrice | 0~9007199254740991 정수 또는 null, 기본 null |

주소 필드는 name·phoneNumber·roadAddress·jibunAddress·detailAddress·dongName·postalCode·latitude·longitude다. 전화번호는 숫자 문자열이며 선행 0을 보존한다. 좌표는 위도 -90~90, 경도 -180~180이다. 임의의 필드·문자열 숫자·null 배열·음수 수량은 거절한다.

PIN 참조는 고객 본인의 개인 PIN 또는 ACTIVE 기업/소속의 기업 PIN인지 확인한다. 주소는 요청한 값을 별도 스냅샷으로 저장한다. PIN의 주소를 자동 복사하거나 원본 PIN을 변경하지 않는다.

성공하면 HTTP 201로 반환한다.

```json
{
  "data": { "orderSeq": 101, "version": 2 },
  "meta": { "requestId": "3eb9db19-bc36-4be1-b116-90b1948dc166" }
}
```

상태는 COLLECTING이며 `parcelPosition`은 배열 순서대로 1부터, `notifiedPrice`는 서버에서 3500으로 저장한다. `version`은 상세 추가 트리거까지 반영한 실제 값이다. 디버 접수·배송 생성은 하지 않으며 기본 결제 방식 저장은 고객 선택이나 결제 자격 확인을 뜻하지 않는다.

## 중복과 오류

같은 관리자·키·정규화된 본문은 최초 orderSeq/version을 반환하고 주문·성공 감사 기록을 추가하지 않는다. 생략한 기본값과 명시한 기본값, 같은 시각의 타임존 표현은 동일하게 비교한다. 다른 관리자의 같은 키는 별개 요청이다. 최초 응답 버전은 이후 주문 버전이 바뀌어도 유지한다.

| HTTP / code | 조건 |
| --- | --- |
| 400 INVALID_REQUEST | 요청/UUID 형식 오류 |
| 401 UNAUTHORIZED | 유효한 활성 관리자 세션 없음 |
| 403 FORBIDDEN | 허용되지 않은 Origin, 비활성 고객, 사용 불가 PIN |
| 404 NOT_FOUND | 고객 없음 |
| 409 REQUEST_IN_PROGRESS | 같은 관리자·키를 처리 중. 같은 요청으로 재시도 |
| 422 IDEMPOTENCY_KEY_REUSED | 같은 관리자·키에 다른 본문 |
| 500 INTERNAL_ERROR | 저장 실패. 주문·상세·중복 방지·성공 감사는 함께 롤백 |

## 접수 전 필수값 검사

`assertOrderSubmissionReady`는 형식 검증을 거쳐 정규화된 주문의 필수값을 검사한다. 상세 1개 이상, 수거 시각, 각 상세의 itemPrice, 완전한 출발/도착 주소를 요구한다. 상세주소는 선택이며 좌표 0과 물품 가액 0은 유효하다. 물품 수량 중 하나가 양수이거나 기타 물품 설명이 비어 있지 않아야 한다.

부족하면 `422 VALIDATION_FAILED` 예외의 details에 `parcels.0.origin.name`처럼 필드 경로와 사유를 담는다. 입력 원문은 포함하지 않고 주문을 수정하지 않는다. 초안 생성에는 이 검사를 적용하지 않는다.

현재 이 검사는 독립 함수와 단위 테스트까지 구현되어 있으며 HTTP 접수 경로에는 아직 연결되지 않았다. 57번 ORD-06 구현 시 저장된 최신 주문을 검사한 뒤 고객/PIN/결제 자격, 상태·버전 확인과 함께 사용한다. 수거 가능 날짜/시간대·결제 자격 정책은 확정되지 않아 임의로 추가하지 않았다.

## DB와 후속 작업

앱 배포 전에 신규 migration `005-order-creation-requests.sql`이 적용되어야 한다. 기존 orders/order_parcels 구조는 유지하고 `api_idempotency.order_creations`에 요청 해시와 최초 응답만 저장한다. 주소·전화번호 원문은 중복 방지 기록과 감사 metadata에 저장하지 않는다.

주문 목록/상세는 58번, 부분 수정은 61번, 디버 제출과 상태 전이는 57번에서 연결한다. AI 서비스 인증·통화/고객 범위 검증은 별도 계약 확정 후 연결한다. 이 문서의 생성 API만으로 최종 접수를 완료할 수는 없다.
