# 주문 API 계약 — ORD-01~04·06

관련 작업: [55번 주문 생성](https://ssafy.atlassian.net/browse/S15P31D109-55), [58번 주문 조회](https://ssafy.atlassian.net/browse/S15P31D109-58), [61번 주문 수정](https://ssafy.atlassian.net/browse/S15P31D109-61). [조회 연동 문서](order-read.md)와 [수정 연동 문서](order-update.md)를 참고한다.
57번 최종 접수·디버 연동·결제 자격은 [최종 접수 문서](order-submit.md)를 따른다.

## 확정 기준

사용자가 2026-10-27 다시 확정한 **기존 API 명세와 이후 합의**를 따른다. Jira 55 본문의 별도 미완료 상담 스냅샷 방식은 적용하지 않는다. Jira 본문과 API 명세가 다르면 API 명세를 기준으로 구현한다.

미완료 주문과 정상 접수 주문은 **같은 orders·order_parcels와 같은 orderSeq**를 사용한다. AI와 관리자도 같은 생성 API를 호출한다. 입력 정보가 일부뿐이든 모두 갖춰졌든 생성은 COLLECTING이며, 완료 여부를 판단해서 다른 API나 테이블로 보내지 않는다.

| 단계 | API | 구현 상태 |
| --- | --- | --- |
| ORD-01 주문 생성 | POST /api/orders | 구현. COLLECTING 저장, orderSeq·version 반환 |
| ORD-02/03 목록·상세 | GET /api/orders, /api/orders/{id} | 58번 구현. 미완료도 같은 주문 조회에서 status로 구분 |
| ORD-04 수집 정보 저장 | PATCH /api/orders/{id} | 61번 구현. COLLECTING 주문을 expectedVersion으로 부분 수정·상세 추가 |
| ORD-06 최종 접수 | POST /api/orders/{id}/submit | 57번 구현. 같은 주문 재검증·디버 접수·배송 생성 |
| 통화 종료 | CALL-02 | 기존 주문에 통화 종료 결과 연결. 별도 미완료 주문 생성 없음 |

69번 관리자 수기 접수도 이 공통 생성과 최종 접수 흐름을 재사용한다. 69번이 별도 Jira라는 이유로 생성 URL을 분리하지 않는다. 이전 초안의 POST /api/orders/validation 및 /api/consultations/incomplete POST·GET·상세 GET은 제거했다.

## 호출 방법

```http
POST /api/orders
Content-Type: application/json
Idempotency-Key: 00000000-0000-4000-8000-000000000055
call_session_seq: 7
```

- Idempotency-Key: 필수 UUID. 같은 생성 의도를 재시도하면 같은 값을 사용한다.
- AI: call_session_seq에 기존 call_sessions.call_session_seq를 전달한다. providerCallId 문자열과 다르다. 이 MR은 CALL-01이나 통화 생성 API를 구현하지 않으므로 실제 연동에서는 선행 통화 생성과 이 ID 전달이 필요하다.
- 관리자: ACTIVE OPERATOR/SUPERVISOR/SYSTEM_ADMIN의 dva_session 쿠키와 기존 허용 Origin을 사용한다. call_session_seq는 선택이며, 전달하면 해당 통화에 연결한다.
- 관리자 쿠키가 존재하면 정상 인증을 요구한다. 잘못된·만료된 쿠키를 AI 호출로 전환하지 않는다.
- AI 서비스 인증은 기존 MVP 방침(135번)에 따라 생략한다. 통화 ID 자체는 인증 수단이 아니며, 실제 호출 서버·통화 소유권을 증명하지 않는다. 다른 관리자/고객/PBX API의 인증 동작은 유지한다.
- /api를 사용하며 /v1은 붙이지 않는다. Swagger: /api/docs, OpenAPI: /api/docs-json.

### 통화 헤더 이름 변경과 배포

2026-10-27 사용자 요청에 따라 통화 헤더를 실제 DB 컬럼명 `call_session_seq`로 통일한다. 값은 `call_sessions.call_session_seq`의 양의 정수다. 기존 `X-Call-Session-Id`는 더 이상 읽지 않으므로 호출 측도 새 이름으로 변경해야 한다.

- 주문 생성·목록·상세·수정과 CORS·Swagger가 같은 이름을 사용한다. DB 컬럼 변경이나 migration은 없다.
- 밑줄이 있는 헤더를 전달하도록 개발·운영 컨테이너 Nginx와 호스트 HTTPS Nginx의 server 블록에 `underscores_in_headers on;`을 설정한다.
- Jenkins 앱 배포는 호스트 Nginx 설정을 자동 적용하지 않는다. 운영 반영 시 현재 호스트 설정을 백업하고 API를 받는 server 블록에 해당 지시문을 추가한 뒤 `nginx -t` 성공 후 reload해야 한다. 별도 도메인·AI 설정이 있으므로 저장소 파일 전체로 덮어쓰지 않는다.
- 호스트 설정을 먼저 준비하고, 새 앱·컨테이너 프록시 배포와 호출 측 헤더 변경을 맞춘다. 기존 호출자가 옛 헤더만 보내면 AI 주문 API에서 400이 발생한다.

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
  "paymentMethodType": "credit",
  "pickupRequestedAt": null,
  "parcels": []
}
```

customerSeq와 customer 중 정확히 하나를 전달한다. customer 입력은 사용자의 기존 합의에 따른 확장이다. 미등록 전화번호면 주문 저장과 함께 ACTIVE 고객을 등록하고, 기존 번호라면 그 고객을 연결한다. 기존 이름·상태를 덮어쓰거나 탈퇴 고객을 복구하지 않는다. 이름의 앞뒤 공백 처리는 병합된 고객 API DTO를 그대로 재사용한다.

| 필드 | 규칙 |
| --- | --- |
| customerSeq | 기존 고객의 양의 정수 ID. customer와 동시 사용 불가 |
| customer | 이름·숫자 문자열 전화번호. customerSeq와 동시 사용 불가 |
| paymentMethodType | credit: 공통 정산(기본), groupBilling: 기업 그룹카드, billing: 개인카드. cat 입력 불가 |
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

하나의 트랜잭션에서 고객 연결/등록 → 고객 상태·PIN 범위 확인 → 생성 키를 포함한 orders와 order_parcels 저장 → 선택한 통화의 order_seq 연결 → 성공 감사를 처리한다. 하나라도 실패하면 신규 고객까지 함께 롤백한다. 감사 metadata에 전화번호·주소를 복제하지 않는다.

AI는 통화 존재·종료 여부·이미 연결된 주문을 확인한다. 통화에 확인된 발신번호가 있으면 고객 전화번호와 비교한다. 번호가 없는 통화에 대한 신원 검증이 완료됐다는 의미는 아니다. 같은 통화에 별도 키로 또 주문을 생성하면 409 INVALID_STATE이며 기존 주문을 ORD-04로 보완해야 한다.

통화가 나중에 종료되어도 COLLECTING 주문을 별도 테이블로 옮기거나 삭제하지 않는다. 자동 재통화 복원·자동 접수도 수행하지 않는다.

## 재시도와 수정 버전

- Idempotency-Key UUID를 orders.creation_request_id에 저장하며 전체 주문에서 UNIQUE다. 새 주문에는 새 키를 사용한다.
- 같은 키의 재요청은 기존 orderSeq와 **현재 version**을 반환한다. 최초 응답의 버전을 별도로 보관하지 않는다.
- 같은 키의 본문은 다시 적용하지 않는다. 본문 해시 비교와 422 IDEMPOTENCY_KEY_REUSED는 제거한다. 수정은 ORD-04를 사용한다.
- 관리자 재시도는 기존 ORDER_CREATED 성공 감사의 actor로 최초 생성자를 확인한다. 다른 관리자 키는 403이다. 생성 감사가 없으면 재시도를 허용하지 않으므로 해당 기록을 임의로 제거하지 않는다.
- AI 재시도는 기존 call_sessions.order_seq와 전달한 통화 ID가 일치해야 한다. 다른 통화나 관리자 주문의 키는 403이다. 종료된 통화도 기존 연결 주문을 재조회할 수 있다.
- 같은 키 처리 중에는 트랜잭션 잠금으로 409 REQUEST_IN_PROGRESS를 반환한다. 동시에 들어온 요청의 최종 유일성은 DB UNIQUE가 보장한다.
- 통화당 주문 하나를 유지한다. 같은 통화에 새 키로 두 번째 주문을 만들면 409 INVALID_STATE다.
- version은 기존 주문 수정 충돌 방지용이다. 생성 키와 역할이 다르므로 유지한다.

## 생성 검증과 최종 접수 검증

ORD-01은 수집 중 저장이므로 필수 배송 주소·수량·수거 시각이 모두 갖춰졌는지를 강제하지 않는다. 전달한 값의 타입·범위·고객/PIN 접근은 검증한다.

내부 assertOrderSubmissionReady는 ORD-06이 **같은 저장 주문**을 최종 접수할 때 사용하는 검증 함수다. 미래 수거 시각, 상세 1개 이상, 출발/도착 필수 주소와 연락처, 우편번호, 수량 또는 물품 설명, 가격을 검사한다. 누락·업무 오류는 422의 field/reason 목록이다. 생성 요청에 이 완전성 검증을 적용하거나 별도 HTTP 검증 호출을 강제하지 않는다. 57번의 ORD-06이 활성 소속에 따른 결제 자격을 확인하고 디버에 전송한다. 호출자는 고객이 확인한 version을 전달해야 한다.

| HTTP/code | 상황 |
| --- | --- |
| 400 INVALID_REQUEST | 잘못된 본문·키·통화 헤더·고객 지정 방식 |
| 401 UNAUTHORIZED | 잘못되거나 만료된 관리자 세션 |
| 403 FORBIDDEN | 관리자 Origin, 비활성 고객, 타 고객 PIN, 확인된 발신번호 불일치, 다른 주체의 생성 키 |
| 404 NOT_FOUND | 고객 또는 통화 없음 |
| 409 INVALID_STATE | 종료되었거나 주문이 이미 연결된 통화의 새 생성 요청 |
| 409 REQUEST_IN_PROGRESS | 같은 키 처리 중 |

## DB·검증·연동 범위

- 신규 전환 SQL: 008-simplify-creation-requests.sql. 기존 주문 생성 키를 orders로 옮기고 기업·고객·주문 요청 기록 테이블과 빈 api_idempotency 스키마를 제거한다. 001~005·007 파일은 적용 이력과 체크섬 때문에 보존한다.
- 이전 초안의 미배포 006-incomplete-consultations.sql과 별도 상담 테이블 ERD는 제외했다. 운영 DB에 DROP·데이터 초기화를 실행하지 않았다. 별도 환경에 초안 006을 수동 적용했다면 이 MR이 자동 제거하지 않는다.
- 기존 고객 API를 포함해 빌드·단위/HTTP·실제 DB·동시 요청·실패 롤백·Nginx/PBX 회귀를 node scripts/check.cjs로 검증한다.
- DB migration·제약·반복 적용·체크섬·실패 롤백·백업 복원은 infra/database/test-monolith.ps1로 검증한다.
- 현재 HTTP 구현은 ORD-01/02/03/04/06이다. ORD-06은 신규 migration 없이 기존 orders의 상태·버전·갱신 시각과 행 잠금으로 처리한다. CALL-01/02, 실제 AI 호출부 연결, 실제 디버 서버 검증·운영 배포는 별도다. 58번 조회와 61번 수정에도 신규 migration이 없다.
- 기존 AI 제안의 /internal/ai·snake_case는 이 /api·camelCase·응답 envelope 계약과 자동 호환되지 않는다. 실제 호출부는 담당 연동 작업에서 맞춰야 한다.
