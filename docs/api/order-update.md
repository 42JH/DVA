# 주문 수집 정보 수정 — ORD-04

관련 Jira: [S15P31D109-61](https://ssafy.atlassian.net/browse/S15P31D109-61). 기준은 API 명세이며, `COLLECTING` 주문의 정보를 같은 `orderSeq`에 저장한다. 디버 전송·접수 후 수정·취소는 이 API의 범위가 아니다.

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

`parcels[].status=CANCELLED`인 상세는 수정할 수 없다. 요청에 취소 상세가 하나라도 포함되면 409 INVALID_STATE로 전체 변경을 롤백한다. 새 상세 추가·미취소 상세 수정은 기존 규칙을 유지한다. [취소 API](order-cancel.md)도 주문 version을 변경하므로 최신 상세를 다시 조회한다.

| 필드 | 의미 |
| --- | --- |
| expectedVersion | 필수. ORD-03 또는 직전 저장 응답의 실제 version |
| paymentMethodType | credit(공통 정산) / groupBilling(기업 그룹카드) / billing(개인카드). 생략하면 유지. 자격은 [최종 접수](order-submit.md) 시 검증 |
| pickupRequestedAt | 시간대를 포함한 ISO 8601. 생략하면 유지, null이면 비우기 |
| parcels[].orderParcelSeq | 있으면 해당 주문의 기존 상세 수정, 없으면 마지막 순번 뒤에 추가 |
| parcels[].origin / destination | 제공한 주소 하위 필드만 변경. 생략 유지, nullable 하위 필드의 null은 비우기 |
| parcels[].originPin | PERSONAL/COMPANY와 pinSeq. 생략 유지, null이면 참조 해제 |
| 수량 4종 | 0~2147483647 정수. 기존 상세는 생략 유지, 새 상세는 기본 0 |
| otherItemDescription / clientComment | 문자열. 빈 문자열로 비우기. 새 상세는 기본 빈 문자열 |
| itemPrice | 0~9007199254740991 정수 또는 null. 기존 상세는 생략 유지, 새 상세는 기본 null |

- `expectedVersion` 외 변경 필드가 하나 이상 필요하다. 빈 배열만으로는 저장하지 않는다. 배열의 각 상세에도 변경값이 필요하며, 상세 번호·빈 주소 객체만 있는 항목은 400이다.
- 주소 객체 자체의 null, 중복 상세 번호, 변경 불가 필드(customerSeq·status·parcelPosition·notifiedPrice 등)는 400이다. 타 주문의 상세와 없는 상세는 모두 404다.
- 생략한 상세는 삭제하지 않는다. 새 상세의 순번은 현재 최대 순번+1이며 기본 안내 요금은 3500원이다.
- 수정 대상 상세의 PIN 접근 권한을 다시 확인한다. 권한이 사라졌다면 `originPin: null`로 참조를 해제할 수 있다. 주문 주소 수정은 원본 PIN에 반영되지 않는다.
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
| 409 INVALID_STATE | COLLECTING이 아닌 주문, 통화 연결 충돌, 종료 후 새 연결 |
| 409 REQUEST_IN_PROGRESS | DB 잠금 획득 대기 2초 초과 |

`backend`에서 `node scripts/check.cjs`로 빌드·린트·포맷·단위/HTTP·실제 PostgreSQL·Nginx/PBX 회귀를 검증한다. 주문 수정 테스트는 부분 병합, null/0/빈 문자열, 신규 상세, 동시 수정, 실패 롤백, PIN·통화·세션 범위, 종료 후 재조회, Swagger를 포함한다.

기존 orders·order_parcels·version·통화 연결·감사 로그를 사용한다. 새 테이블·migration·의존성은 없으며 실제 AI 컨테이너 호출 및 운영 배포 검증은 별도다.
