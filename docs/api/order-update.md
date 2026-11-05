# 주문 수집 정보 수정 — ORD-04

관련 Jira: [S15P31D109-61](https://ssafy.atlassian.net/browse/S15P31D109-61). AI는 `COLLECTING`에서만 수정한다. 관리자는 모든 주문 상태에서 배송상세를 추가·수정·제거하고 같은 `orderSeq`에 저장한다. 주문 상태·접수 번호·결제 완료 기록은 유지하며, 디버 변경 전송·실제 환불·추가 결제는 이번 범위에서 제외한다.

새 AI 상담은 중간에 이 API를 반복 호출하지 않고 수집 완료·중도 종료·취소 결과를 [POST /api/orders](orders.md)에 한 번 전달한다. 이 PATCH는 기존 미완료 주문의 보완 경로로 유지한다.

## 호출 방법

```http
PATCH /api/orders/123
Content-Type: application/json
call_session_seq: 7
```

```json
{
  "expectedVersion": 4,
  "parcels": [
    { "orderParcelSeq": 101, "destination": { "roadAddress": "예시시 배송로 2" } },
    { "destination": { "name": "새 수령인" }, "smallBoxCount": 1 }
  ]
}
```

- 관리자: ACTIVE OPERATOR/SUPERVISOR/SYSTEM_ADMIN의 `dva_session` 쿠키와 허용된 `Origin`. 통화 헤더는 선택이다.
- AI: 관리자 쿠키 없이 DB `call_sessions.call_session_seq` 값을 같은 이름의 `call_session_seq` 헤더로 전달한다. 활성 고객의 전화번호와 통화 발신번호가 같아야 한다.
- `Idempotency-Key`와 `X-CSRF-Protection`은 요구하지 않는다. 수정의 동시 요청·재전송은 `expectedVersion`으로 처리한다.
- 잘못되거나 만료된 관리자 쿠키가 있으면 인증 오류이며 AI 요청으로 바꾸지 않는다.

## 변경 규칙

AI는 `parcels[].status=CANCELLED`인 상세를 수정할 수 없으며 전체 변경을 409로 롤백한다. 관리자는 취소된 상세의 내용도 정정할 수 있으나 상태를 ACTIVE로 되돌리지 않는다. `removeParcelSeqs`는 관리자 전용이며 실제 행을 보존하고 CANCELLED로 표시한다. 생략한 상세는 유지하고 같은 번호를 수정·제거 목록에 함께 넣으면 400이다. 취소된 상위 주문에 새로 추가한 상세도 CANCELLED로 보존한다. [취소 API](order-cancel.md)도 주문 version을 변경하므로 최신 상세를 다시 조회한다.

| 필드 | 의미 |
| --- | --- |
| expectedVersion | 필수. ORD-03 또는 직전 저장 응답의 실제 version |
| paymentMethodType | credit(월결제) / groupBilling(부서 그룹결제) / billing(개인·기업 개인 카드). 생략하면 유지. 자격은 [최종 접수](order-submit.md) 시 검증 |
| totalAmount | AI는 기존 수집 값. 관리자는 미취소 상세의 notifiedPrice 합계를 서버가 계산하므로 생략 권장. 전달하면 계산 결과와 같아야 하며 불일치 시 422 |
| removeParcelSeqs | 관리자 전용 제거 번호 배열. 1개 이상·중복 불가·같은 주문 소속 필수. 제거한 행은 이력으로 남음 |
| parcels[].notifiedPrice | 상세 배송비. 생략 유지, null은 미확인. 최종 확정 시 양의 정수 필수 |
| pickupRequestedAt | 시간대를 포함한 ISO 8601. 생략하면 유지, null이면 비우기 |
| parcels[].orderParcelSeq | 있으면 해당 주문의 기존 상세 수정, 없으면 마지막 순번 뒤에 추가 |
| parcels[].origin / destination | 제공한 주소 하위 필드만 변경. 생략 유지, nullable 하위 필드의 null은 비우기 |
| parcels[].originPin | PERSONAL과 pinSeq. 생략 유지, null이면 해제. COMPANY는 기존 동일 상세의 동일 참조·출발지 주소 유지에만 허용 |
| 수량 4종 | 0~2147483647 정수. 기존 상세는 생략 유지, 새 상세는 기본 0 |
| otherItemDescription / clientComment | 문자열. 빈 문자열로 비우기. 새 상세는 기본 빈 문자열 |
| itemPrice | 0~9007199254740991 정수 또는 null. 기존 상세는 생략 유지, 새 상세는 기본 null |

- `expectedVersion` 외 변경 필드가 하나 이상 필요하다. 빈 배열만으로는 저장하지 않는다. 배열의 각 상세에도 변경값이 필요하며, 상세 번호·빈 주소 객체만 있는 항목은 400이다.
- 주소 객체 자체의 null, 중복 상세 번호, 변경 불가 필드(customerSeq·status·parcelPosition 등)는 400이다. 타 주문의 상세와 없는 상세는 모두 404다.
- 생략한 상세는 삭제하지 않는다. 새 상세의 순번은 현재 최대 순번+1이며 새 상세 배송비 기본값은 null이다.
- 수정 대상 상세의 PERSONAL PIN 접근 권한을 다시 확인한다. 권한이 사라졌다면 `originPin: null`로 참조를 해제할 수 있다. 과거 COMPANY는 새로 선택하거나 번호를 바꿀 수 없고 주소 변경 시 null 또는 유효한 PERSONAL로 전환한다. 동일 참조·주소를 유지하는 수정은 테이블 없이 처리한다. 주문 주소 수정은 원본 PIN에 반영되지 않는다. [053 호환 계약](../../backend/docs/company-pin-retirement.md)을 따른다.
- 주문에 활성 고객이 연결되어 있어야 한다. 결제 자격·입력 완전성·최종 동의·디버 접수는 ORD-06에서 다룬다.

## 응답과 재시도

```json
{
  "data": { "version": 7 },
  "meta": { "requestId": "추적 UUID" }
}
```

HTTP 200이며 저장한 전체 본문을 다시 보내지 않는다. 반환 버전은 DB 트리거 실행 후 실제 값이다. 예시의 7은 고정 증가량이 아니며 클라이언트는 +1로 계산하지 않는다. 같은 값을 명시적으로 저장해도 버전은 증가한다.

1. ORD-03으로 현재 내용·상세 번호·version을 읽는다.
2. 해당 version을 expectedVersion으로 보내 변경값을 저장한다.
3. 응답 유실이나 409 VERSION_CONFLICT가 발생하면 ORD-03으로 다시 조회한다.
4. 새 상세가 이미 추가됐는지 확인하고 그 상세 번호로 후속 변경을 보낸다. 새 상세 추가를 무조건 재전송하지 않는다.

주문 잠금 → 고객·통화·버전·상세/PIN 확인 → 헤더·상세 저장 → 통화 연결 → 성공 감사 기록을 한 트랜잭션으로 처리한다. 하나라도 실패하면 모두 롤백한다. 같은 버전의 동시 요청은 한 건만 저장된다. 실패 감사는 별도로 남긴다.

고객·소속 변경과 겹치면 잠금이 풀린 뒤 같은 요청을 이어서 처리하고 최신 고객·PIN 권한을
검사한다. 각 DB 잠금 획득 대기는 최대 2초이며 초과하면 변경 전체를 롤백한다.

## AI 통화 연결과 종료 후 처리

- 진행 중인 미연결 통화는 고객이 선택한 주문을 PATCH로 저장할 때 연결한다. 이전 주문을 자동 선택하지 않으며, AI가 고객 의사를 확인해야 한다.
- 통화에 다른 주문이 연결되어 있으면 409이며 연결을 덮어쓰지 않는다. 관리자도 통화 헤더를 전달한 경우 같은 연결 규칙을 따른다.
- 종료된 통화는 이미 연결된 주문에 종료 전에 수집한 내용을 마저 저장할 수 있다. 새 주문 연결은 허용하지 않는다. 서버는 고객 범위·연결 주문·COLLECTING 상태·버전을 검사한다.
- 종료 후 응답 유실 복구를 위해 ORD-03은 기존 연결 주문 한 건의 조회를 허용한다. 목록과 다른 주문 조회는 계속 409다.
- 입력의 실제 수집 시각은 요청에 없으므로 AI 측에서 종료 전 수집 내용만 전송해야 한다.
- 기존 MVP 방침대로 AI 서비스 인증은 미적용이다. 통화 번호는 인증 토큰이 아니며 발신번호의 진위를 증명하지 않는다. 서비스 인증은 [135번](https://ssafy.atlassian.net/browse/S15P31D109-135) 후속 작업이다.

## 오류와 검증

| HTTP / code | 상황 |
| --- | --- |
| 400 INVALID_REQUEST | 잘못된 형식·범위, 필수 버전/변경값 누락, 중복 상세 번호 |
| 401 UNAUTHORIZED | 유효하지 않은 관리자 세션 |
| 403 FORBIDDEN | 관리자 권한·Origin, 활성 고객·통화 발신번호·PIN 범위 오류 |
| 404 NOT_FOUND | 주문·통화 또는 해당 주문 소속 상세 없음 |
| 409 VERSION_CONFLICT | 저장된 버전과 expectedVersion 불일치 |
| 409 INVALID_STATE | AI의 비 COLLECTING 수정·취소 상세 수정, 확정 주문 결제수단 변경, 통화 연결 충돌, 종료 후 새 연결 |
| 409 REQUEST_IN_PROGRESS | 결제 승인 진행 중 또는 DB 잠금 획득 대기 2초 초과 |
| 422 VALIDATION_FAILED | 확정 주문의 미취소 상세 배송비 누락, 합계 int32 초과 또는 전달 총액 불일치 |

`backend`에서 `node scripts/check.cjs`로 빌드·린트·포맷·단위/HTTP·실제 PostgreSQL·Nginx/PBX 회귀를 검증한다. 주문 수정 테스트는 부분 병합, null/0/빈 문자열, 신규 상세, 동시 수정, 실패 롤백, PIN·통화·세션 범위, 종료 후 재조회, Swagger를 포함한다.

기존 orders·order_parcels·version·통화 연결·감사 로그를 사용한다. 새 테이블·의존성은 없으며, 새 앱 전에 030 migration으로 관리자 트랜잭션의 주문별 편집 허용을 적용한다. 실제 AI 컨테이너 호출 및 운영 배포 검증은 별도다.

## 관리자 금액 처리

관리자는 상세 변경과 총액 재계산을 한 DB 트랜잭션으로 저장한다. 상세 요금이 미확인인 COLLECTING은 총액 null, 미취소 상세가 없으면 0원이다. 확정된 주문에는 남은 상세별 양의 정수 요금이 모두 필요하다. 전체 상세를 제거해도 이 수정 API는 상위 주문 상태를 바꾸지 않는다. 결제수단은 COLLECTING에서만 변경할 수 있다.

notPaid의 금액이 달라지면 기존 미완료 결제 요청을 무효화하고 새 UUID·금액으로 교체한다. 최초 만료 시각은 유지한다. 금액이 같으면 결제 요청도 유지하고, 0원이면 새 결제 요청을 만들지 않는다. 이미 시작한 승인은 409로 보호한다. 승인 완료 원본·월 청구 원본·배송/접수 기록은 덮어쓰지 않는다. 이 변경은 내부 주문 금액 보정이며 외부 환불·추가 결제·청구 차액·디버 변경 동기화는 별도다.

~~~json
{
  "expectedVersion": 4,
  "parcels": [
    { "orderParcelSeq": 101, "notifiedPrice": 3000 },
    { "destination": { "name": "새 수령인" }, "smallBoxCount": 1, "notifiedPrice": 4000 }
  ],
  "removeParcelSeqs": [102]
}
~~~

응답은 기존 {data:{version},meta:{requestId}}를 유지한다. 프론트는 GET /api/orders/{id}로 최종 totalAmount·parcels·paymentRequest를 갱신한다. 이력·결제·통화 참조는 삭제하지 않는다.
