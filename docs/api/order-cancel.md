# 주문 전체·상세 취소

관련 Jira: [S15P31D109-64](https://ssafy.atlassian.net/browse/S15P31D109-64). 2026-10-28 사용자 확정 정책을 따른다. 승인 대기 없이 내부 DB에서 즉시 처리하며 실제 디버 취소 API는 호출하지 않는다.

## 요청·응답

| API | 받는 값 | 결과 |
| --- | --- | --- |
| `POST /api/orders/{id}/cancel` | `id`: orders.order_seq | 모든 미취소 상세와 주문을 CANCELLED로 변경. 204, 본문 없음 |
| `POST /api/orders/{id}/parcels/cancel` | `id`: orders.order_seq, 본문 `orderParcelSeqs`: order_parcels.order_parcel_seq 배열 | 선택한 상세를 함께 CANCELLED로 변경. 마지막 미취소 상세까지 취소하면 주문도 CANCELLED. 204, 본문 없음 |

전체 취소에는 본문이 없다. 상세 취소는 `orderParcelSeqs`에 같은 주문의 상세번호를 한 개 이상 넣는다. 한 개면 단건, 여러 개면 복수 취소이며 빈 배열·중복·문자열 번호는 400이다. 번호는 1~2147483647 정수다. 두 API 모두 Idempotency-Key·expectedVersion은 필요하지 않다. 상세 번호는 `GET /api/orders/{id}`의 `data.parcels[].orderParcelSeq`를 사용한다. 취소 후 주문 상세로 현재 상태·version을 다시 조회한다.

```http
POST /api/orders/123/parcels/cancel
call_session_seq: 7
Content-Type: application/json

{"orderParcelSeqs":[456,457]}
```

기존 URL의 `/{orderParcelSeq}`는 제거한다. 단건도 새 경로에 `{"orderParcelSeqs":[456]}`을 보낸다.

- 관리자: ACTIVE OPERATOR·SUPERVISOR·SYSTEM_ADMIN 세션과 기존 허용 Origin. 관리자에게 통화 헤더는 필요 없다.
- AI: 기존 주문 상세 조회와 동일하게 `call_session_seq`를 전달한다. 발신번호와 일치하는 ACTIVE 고객의 주문만 허용하며 다른 고객 주문은 404다. 진행 중 통화는 같은 고객의 다른 통화에서 만든 주문도 취소할 수 있다.
- 종료된 통화는 기존 연결 주문만 허용한다. 없는 통화는 404, 활성 고객이 없는 통화는 403이다. 잘못된 관리자 쿠키를 AI 요청으로 우회하지 않는다.
- 통화 번호는 DB 식별자이며 인증 토큰이 아니다. 이번 변경은 기존 AI 서비스 인증 미적용 범위를 유지한다. AI 코드나 통화 생성 시점은 바꾸지 않는다. 고객 확인 API만으로 통화가 생성되는 것은 아니므로 기존 연동에서 확보한 유효한 call_session_seq를 사용한다.

## 취소 조건

| 현재 상태 | 전체 취소 | 상세 단건·복수 취소 |
| --- | --- | --- |
| COLLECTING, 대상 상세에 배송 없음 | 허용. 상세 0개도 허용 | 선택한 미취소 상세 허용 |
| ACCEPTED, 대상 상세의 배송이 모두 notPaid | 허용 | 선택한 미취소 상세가 모두 notPaid이면 허용. 선택하지 않은 상세의 결제 상태는 무관 |
| SUBMITTING·AUTH_FAILED·REVIEW_REQUIRED·EXPIRED | 409 | 미취소 상세는 409 |
| 이미 전체 CANCELLED | 409, `이미 취소된 주문입니다.` | 선택한 상세가 모두 해당 주문의 CANCELLED이면 204 |
| 일부 상세 CANCELLED | 기존 취소 상세는 건너뛰고 남은 상세 조건 확인 | 이미 취소된 상세를 건너뛰고 나머지만 취소. 모두 이미 취소됐으면 204, 변경 없음 |

`notPaid`는 현재 내부 배송 데이터의 결제 전 표시다. 실제 디버 결제 확인·환불·취소를 대신하지 않는다. 접수 주문의 대상 배송이 없거나 결제 전 이외의 상태면 취소하지 않는다. 전체·복수 취소 모두 한 건이라도 조건을 충족하지 못하면 전체 요청을 거절하고 아무 상태도 바꾸지 않는다. 다른 주문의 상세나 없는 상세가 섞여 있어도 404로 전부 거절하며, 이미 취소됐다는 이유로 소속 확인을 생략하지 않는다.

## 저장·중복·동시성

1. 주문 행을 잠그고 고객 범위·주문 상태·상세 소속을 확인한다.
2. 대상 상세와 배송 행을 잠근 뒤 결제 전 조건을 확인한다. 다른 결제 갱신이 먼저 잠금을 잡았다면 완료를 기다린 후 상태를 다시 확인한다.
3. 상세의 `status=CANCELLED`, 관련 내부 배송의 `status=canceled`, 배송 버전·상태 이력·성공 감사를 같은 트랜잭션에 저장한다. 전체 취소 또는 마지막 상세 취소이면 주문도 CANCELLED다.
4. 일부만 취소하면 주문은 기존 COLLECTING/ACCEPTED를 유지한다. PARTIALLY_CANCELLED·승인 대기는 만들지 않는다. 주문 내용·주소·디버 접수번호와 접수 시각은 보존한다.

동시 전체 취소는 한 요청만 204이고 나머지는 이미 취소된 주문으로 409다. 선택 상세가 겹치는 복수 요청은 순서대로 처리하고 이미 취소된 상세는 건너뛴다. 모두 이미 취소된 요청은 204이며 버전·배송 이력·성공 감사를 추가하지 않는다. 행 잠금과 기존 상태를 사용하므로 별도 요청 기록 테이블·메모리 대기열이 없다. 두 번째 상세의 감사 저장이 실패해도 먼저 변경한 상세·배송·이력·감사까지 함께 롤백한다.

성공 감사는 전체 취소 `ORDER_CANCELLED / ORDER`, 선택 상세 취소는 새로 취소한 상세마다 `ORDER_PARCEL_CANCELLED / ORDER_PARCEL`이다. 마지막 미취소 상세까지 취소하면 주문 감사도 같은 requestId로 남긴다. 이미 취소된 상세에는 성공 감사를 추가하지 않는다. 실패 감사의 대상은 요청의 상위 ORDER이며 성공 기록과 구분된다.

## 기존 API 영향

- `GET /api/orders`: `status=CANCELLED`는 전체 취소 주문이다. `parcelCount`는 취소된 상세를 포함한 전체 수다.
- `GET /api/orders/{id}`: `parcels[].status`에 ACTIVE/CANCELLED를 추가한다. ACTIVE는 취소되지 않았다는 의미이며 접수·결제 완료가 아니다. 취소된 상세도 주소·물품과 함께 반환한다.
- `PATCH /api/orders/{id}`: COLLECTING의 미취소 상세만 수정한다. 취소된 상세를 포함하면 409로 요청 전체를 롤백한다. 취소로 version이 달라지므로 최신 상세를 조회해야 한다.
- `POST /api/orders/{id}/submit`: 취소되지 않은 상세만 필수 정보·PIN을 검증하고 디버로 보낸다. 초기 배송·이력도 해당 상세에만 생성한다. 오류의 `parcels.N`은 원래 상세 목록의 인덱스를 유지한다.
- `GET /api/customers/{id}/addresses`: 접수된 주문의 미취소 상세만 주소 후보로 반환한다.
- `POST /api/orders`의 `outcome=CANCELLED`: 새 상담 결과 저장이며 기존 주문 취소와 구별한다. 생성된 상세도 CANCELLED로 저장한다. 기존 COMPLETE/INCOMPLETE 전송 형식은 유지한다.

## 오류·배포·검증

400은 번호·헤더 형식 오류와 상세번호 배열 누락·빈 배열·중복, 401은 세션 오류, 403은 권한·Origin·활성 고객 오류, 404는 주문·통화·상세 없음 또는 AI 범위 밖, 409 INVALID_STATE는 취소 조건 불충족이다. 상세가 다른 주문에 속해도 404다.

배포 전에 `014-order-cancellation.sql`을 기존 migration runner로 적용한다. 새 테이블 없이 상세 상태와 접수 이력 보존 제약·트리거만 추가한다. 적용된 001~013 파일은 바꾸지 않는다. 단건·복수 취소 통합에 추가 DB 변경은 없다. 부분 취소 데이터를 만든 뒤에는 상세 취소 상태를 모르는 구버전 앱으로 복귀하면 재접수에 취소 상세가 포함될 수 있으므로 호환되는 앱을 사용한다.

검증: `infra/database/test-monolith.ps1`로 업그레이드·데이터 보존·롤백을 확인하고, backend의 `npm run check:docker`로 권한·반복·동시 요청·결제 경합·감사 실패·접수 제외·Swagger·실제 Nginx 경유를 검증한다. 운영 DB 적용·실제 디버 취소·실제 AI 통화는 별도다.
