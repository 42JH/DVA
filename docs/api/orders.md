# 주문 API 계약 — ORD-01

관련 작업: [S15P31D109-55](https://ssafy.atlassian.net/browse/S15P31D109-55).

## 확정 기준

사용자가 2026-10-27 다시 확정한 **기존 API 명세**를 따른다. Jira 55 본문의 별도 미완료 상담 스냅샷 방식과 충돌하므로 이 MR에서는 그 방식을 적용하지 않는다. Jira 본문·상태는 자동 변경하지 않았다.

미완료 주문과 정상 접수 주문은 **같은 orders·order_parcels와 같은 orderSeq**를 사용한다. AI와 관리자도 같은 생성 API를 호출한다. 입력 정보가 일부뿐이든 모두 갖춰졌든 생성은 COLLECTING이며, 완료 여부를 판단해서 다른 API나 테이블로 보내지 않는다.

| 단계 | API | 이번 MR |
| --- | --- | --- |
| ORD-01 주문 생성 | POST /api/orders | 구현. COLLECTING 저장, orderSeq·version 반환 |
| ORD-02/03 목록·상세 | GET /api/orders, /api/orders/{id} | 58번. 미완료도 같은 주문 조회에서 status로 구분 |
| ORD-04 수집 정보 저장 | PATCH /api/orders/{id} | 61번. 같은 주문에 expectedVersion으로 수정 |
| ORD-06 최종 접수 | POST /api/orders/{id}/submit | 57번. 같은 주문 재검증·디버 접수 |
| 통화 종료 | CALL-02 | 기존 주문에 통화 종료 결과 연결. 별도 미완료 주문 생성 없음 |

69번 관리자 수기 접수도 이 공통 생성과 최종 접수 흐름을 재사용한다. 69번이 별도 Jira라는 이유로 생성 URL을 분리하지 않는다. 이전 초안의 POST /api/orders/validation 및 /api/consultations/incomplete POST·GET·상세 GET은 제거했다.

## 호출 방법

```http
POST /api/orders
Content-Type: application/json
Idempotency-Key: 00000000-0000-4000-8000-000000000055
X-Call-Session-Id: 7
```

- Idempotency-Key: 필수 UUID. 같은 생성 의도를 재시도하면 같은 값을 사용한다.
- AI: X-Call-Session-Id에 기존 call_sessions.call_session_seq를 전달한다. providerCallId 문자열과 다르다. 이 MR은 CALL-01이나 통화 생성 API를 구현하지 않으므로 실제 연동에서는 선행 통화 생성과 이 ID 전달이 필요하다.
- 관리자: ACTIVE OPERATOR/SUPERVISOR/SYSTEM_ADMIN의 dva_session 쿠키와 기존 허용 Origin을 사용한다. X-Call-Session-Id는 선택이며, 전달하면 해당 통화에 연결한다.
- 관리자 쿠키가 존재하면 정상 인증을 요구한다. 잘못된·만료된 쿠키를 AI 호출로 전환하지 않는다.
- AI 서비스 인증은 기존 MVP 방침(135번)에 따라 생략한다. 통화 ID 자체는 인증 수단이 아니며, 실제 호출 서버·통화 소유권을 증명하지 않는다. 다른 관리자/고객/PBX API의 인증 동작은 유지한다.
- /api를 사용하며 /v1은 붙이지 않는다. Swagger: /api/docs, OpenAPI: /api/docs-json.

## 요청

기존 고객:

```json
{
  "customerSeq": 31,
  "parcels": [{ "origin": { "name": "발송인" } }]
}
```

기존 고객 ID를 모르는 경우:

```json
{
  "customer": { "name": "신규 고객", "phoneNumber": "01012345678" },
  "paymentMethodType": "cat",
  "pickupRequestedAt": null,
  "parcels": []
}
```

customerSeq와 customer 중 정확히 하나를 전달한다. customer 입력은 사용자의 기존 합의에 따른 확장이다. 미등록 전화번호면 주문 저장과 함께 ACTIVE 고객을 등록하고, 기존 번호라면 그 고객을 연결한다. 기존 이름·상태를 덮어쓰거나 탈퇴 고객을 복구하지 않는다. 이름의 앞뒤 공백 처리는 병합된 고객 API DTO를 그대로 재사용한다.

| 필드 | 규칙 |
| --- | --- |
| customerSeq | 기존 고객의 양의 정수 ID. customer와 동시 사용 불가 |
| customer | 이름·숫자 문자열 전화번호. customerSeq와 동시 사용 불가 |
| paymentMethodType | cat/billing/credit/groupBilling. 생략 시 명세·DB 기본값 credit |
| pickupRequestedAt | 선택/null. 전달 시 실제 해석 가능한 타임존 포함 ISO 8601 |
| parcels | 선택. 생략·빈 배열이면 상세 0개 |
| parcels[].origin/destination | 수집한 주소 필드만 전달. 내부 미수집 값은 null |
| parcels[].originPin | 선택/null. PERSONAL/COMPANY scope와 pinSeq를 함께 전달 |
| documentCount/smallBoxCount/mediumBoxCount/bigBoxCount | 선택, 생략 시 0. 전달 시 0~2147483647 정수 |
| otherItemDescription/clientComment | 선택, 생략 시 빈 문자열 |
| itemPrice | 선택/null. 전달 시 0~Number.MAX_SAFE_INTEGER 정수 |

주소 필드는 name, phoneNumber, roadAddress, jibunAddress, detailAddress, dongName, postalCode, latitude, longitude다. 숫자 문자열 전화번호의 선행 0을 보존한다. 좌표는 위도 -90~90, 경도 -180~180이다. 미수집 주소를 거짓 기본값으로 채우지 않는다.

parcelPosition과 notifiedPrice는 요청에서 받지 않는다. 서버가 상세 순서 1부터, 고정 요금 3500을 지정한다. status·version·외부 접수 결과 등 미지원 필드를 전달하면 400이다. credit 기본값은 고객 결제 동의나 자격 확인을 뜻하지 않는다.

## 저장·응답

```json
{
  "data": { "orderSeq": 123, "version": 2 },
  "meta": { "requestId": "추적 UUID" }
}
```

201 응답이다. version은 상세 추가 트리거까지 실행된 DB 실제 값을 읽어 반환한다. 상세 개수로 추정하거나 1로 고정하지 않는다. 디버 접수번호·배송은 생성하지 않는다.

하나의 트랜잭션에서 고객 연결/등록 → 고객 상태·PIN 범위 확인 → orders와 order_parcels 저장 → 선택한 통화의 order_seq 연결 → 재시도 결과 저장 → 성공 감사를 처리한다. 하나라도 실패하면 신규 고객까지 함께 롤백한다. 감사 metadata에 전화번호·주소를 복제하지 않는다.

AI는 통화 존재·종료 여부·이미 연결된 주문을 확인한다. 통화에 확인된 발신번호가 있으면 고객 전화번호와 비교한다. 번호가 없는 통화에 대한 신원 검증이 완료됐다는 의미는 아니다. 같은 통화에 별도 키로 또 주문을 생성하면 409 INVALID_STATE이며 기존 주문을 ORD-04로 보완해야 한다.

통화가 나중에 종료되어도 COLLECTING 주문을 별도 테이블로 옮기거나 삭제하지 않는다. 자동 재통화 복원·자동 접수도 수행하지 않는다.

## 재시도와 수정 버전

- 관리자: 인증된 관리자 ID + 멱등키. AI: 통화 ID + 멱등키로 요청을 구분한다.
- 같은 키·정규화된 동일 본문: 최초 orderSeq·version을 반환한다. 이후 주문 버전이 증가하거나 통화가 종료돼도 최초 응답을 회수할 수 있다.
- 같은 키·다른 본문 또는 통화 연결 변경: 422 IDEMPOTENCY_KEY_REUSED.
- 같은 키 처리 중: 409 REQUEST_IN_PROGRESS. 같은 요청으로 재시도한다.
- DB 잠금과 UNIQUE 제약으로 여러 앱 인스턴스에서 중복 저장을 막는다.
- version은 **이미 존재하는 주문의 수정 충돌**을 막는다. 아직 orderSeq가 없고 응답도 유실될 수 있는 **생성 중복**은 별도의 생성 영수증(api_idempotency.order_creations)으로 처리한다. 업무 데이터를 복제하는 별도 주문·상담 테이블은 아니다.

## 생성 검증과 최종 접수 검증

ORD-01은 수집 중 저장이므로 필수 배송 주소·수량·수거 시각이 모두 갖춰졌는지를 강제하지 않는다. 전달한 값의 타입·범위·고객/PIN 접근은 검증한다.

내부 assertOrderSubmissionReady는 ORD-06이 **같은 저장 주문**을 최종 접수할 때 재사용할 검증 함수다. 미래 수거 시각, 상세 1개 이상, 출발/도착 필수 주소와 연락처, 우편번호, 수량 또는 물품 설명, 가격을 검사한다. 누락·업무 오류는 422의 field/reason 목록이다. 생성 요청에 이 완전성 검증을 적용하거나 별도 HTTP 검증 호출을 강제하지 않는다. 실제 결제 자격·고객 최종 동의·외부 접수는 57번에서 확인해야 한다.

| HTTP/code | 상황 |
| --- | --- |
| 400 INVALID_REQUEST | 잘못된 본문·키·통화 헤더·고객 지정 방식 |
| 401 UNAUTHORIZED | 잘못되거나 만료된 관리자 세션 |
| 403 FORBIDDEN | 관리자 Origin, 비활성 고객, 타 고객 PIN, 확인된 발신번호 불일치 |
| 404 NOT_FOUND | 고객 또는 통화 없음 |
| 409 INVALID_STATE | 종료되었거나 주문이 이미 연결된 통화의 새 생성 요청 |
| 409 REQUEST_IN_PROGRESS | 같은 키 처리 중 |
| 422 IDEMPOTENCY_KEY_REUSED | 같은 키에 다른 내용 |

## DB·검증·연동 범위

- 신규 SQL: 007-order-creation-requests.sql. 고객 API의 005와 중복되지 않는다. 앱 교체 전에 적용한다.
- 이전 초안의 미배포 006-incomplete-consultations.sql과 별도 상담 테이블 ERD는 제외했다. 운영 DB에 DROP·데이터 초기화를 실행하지 않았다. 별도 환경에 초안 006을 수동 적용했다면 이 MR이 자동 제거하지 않는다.
- 기존 고객 API를 포함해 빌드·단위/HTTP·실제 DB·동시 요청·실패 롤백·Nginx/PBX 회귀를 node scripts/check.cjs로 검증한다.
- DB migration·제약·반복 적용·체크섬·실패 롤백·백업 복원은 infra/database/test-monolith.ps1로 검증한다.
- 이 MR의 HTTP 구현은 ORD-01이다. ORD-02/03/04/06 및 CALL-01/02 구현, 실제 AI 호출부의 통화 ID·경로·필드 연결, 디버 연동, 원격 DB 적용·운영 배포는 완료 범위가 아니다.
- 기존 AI 제안의 /internal/ai·snake_case는 이 /api·camelCase·응답 envelope 계약과 자동 호환되지 않는다. 실제 호출부는 담당 연동 작업에서 맞춰야 한다.
