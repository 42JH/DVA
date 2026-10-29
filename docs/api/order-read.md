# 주문 목록·상세 조회

관련 Jira: [S15P31D109-58](https://ssafy.atlassian.net/browse/S15P31D109-58). 기준 브랜치: `develop-backend`, 작업 브랜치: `feature/order-read`.

## 호출 범위

- 관리자: ACTIVE OPERATOR/SUPERVISOR/SYSTEM_ADMIN의 `dva_session` 쿠키로 전체 주문 조회. GET에는 Origin·Idempotency-Key가 필요하지 않다.
- AI: 관리자 쿠키 없이 `call_session_seq` 헤더에 DB `call_sessions.call_session_seq` 값을 전달한다. 발신번호와 일치하는 ACTIVE 고객의 주문만 조회한다. 목록의 customerSeq를 생략해도 서버가 이 범위를 적용한다.
- 발신번호가 없거나 활성 고객과 연결되지 않은 통화는 403이다. 종료된 통화는 기존 연결 주문 한 건의 상세만 조회할 수 있으며 목록·다른 주문은 409다. 이는 [ORD-04](order-update.md) 후처리의 응답 유실 복구를 위한 범위다. 같은 기업 소속이라는 이유로 다른 고객 주문을 공개하지 않는다.
- 관리자 쿠키가 있으면 반드시 정상 세션이어야 한다. 만료·잘못된 쿠키는 AI 요청으로 전환하지 않는다.
- 서비스 인증은 기존 MVP 방침대로 미적용이다. 통화 번호를 아는 호출자를 인증하는 기능은 아니며, 발신번호의 진위도 보증하지 않는다. 이 한계는 [135번](https://ssafy.atlassian.net/browse/S15P31D109-135)의 서비스 인증과 통화 결속 작업에서 보완해야 한다.

## 주문 목록

목록·상세에 `creationSource`를 포함한다. `AI`는 통화 기반 접수, `ADMIN`은 관리자 수기, `UNKNOWN`은 012 이전 출처 미확인 주문이다. 관리자 신규 수기 접수는 [POST /api/admin/orders](manual-orders.md)를 사용한다.

```http
GET /api/orders?status=COLLECTING&limit=20&offset=0
call_session_seq: 7
```

| Query | 의미 |
| --- | --- |
| customerSeq | 고객 번호. AI는 통화 고객과 다른 번호 지정 불가 |
| from / to | 주문 생성 시각. from 포함·to 미포함. 시간대 포함 ISO 8601, from < to |
| status | COLLECTING / notPaid / PAID / SUBMITTING / ACCEPTED / SUBMISSION_FAILED / CANCELLED |
| recipientName | 수령인 이름 부분 검색. 앞뒤 공백 제거·대소문자 구분 없음. `%`, `_`는 일반 문자 |
| limit / offset | 기본 20 / 0. limit 1~100, offset 0 이상 정수 |

모든 필터는 AND다. 수령인 필터는 주문 내 일치하는 상세가 있는지 검사한다. 정렬은 `createdAt DESC, orderSeq DESC`이며, 상세가 여러 개여도 주문은 한 번만 반환한다. 배송 상태 필터 `shipmentStatus`는 지원하지 않으며 전달하면 400이다.

`status`는 `orders.status`이며 배송 상태와 별개다.

| status | 의미 |
| --- | --- |
| COLLECTING | 정보를 수집·보완 중인 미완료 주문 |
| SUBMITTING | 디버 접수 처리 중 또는 결과 저장 미확정 |
| ACCEPTED | 디버 접수 완료 |
| notPaid | 개인 카드 결제 대기 |
| PAID | 결제 완료 |
| SUBMISSION_FAILED | 디버 접수 실패 |
| CANCELLED | 취소된 주문 |

```json
{
  "data": [
    {
      "orderSeq": 123,
      "customerSeq": 31,
      "status": "COLLECTING",
      "paymentMethodType": "credit",
      "pickupRequestedAt": null,
      "createdAt": "2026-10-27T00:00:00.000Z",
      "creationSource": "AI",
      "totalAmount": null,
      "paidAt": null,
      "paymentDueAt": null,
      "parcelCount": 1
    }
  ],
  "hasNext": false
}
```

`parcelCount`는 취소된 상세를 포함한 주문 전체 상세 수다. 일부 상세만 취소하면 주문 상태는 유지하고 전부 취소되었을 때 CANCELLED다. 목록은 주문 요약만 반환하며 `shipmentStatuses`는 제거했다. 조회 결과가 없으면 `data: []`, `hasNext: false`다. 목록에는 meta나 page 객체를 붙이지 않는다. 수령인·주소·물품을 확인하려면 각 orderSeq로 주문 상세를 조회한다.

## 주문 상세

```http
GET /api/orders/123
call_session_seq: 7
```

응답은 `{ "data": Order, "meta": { "requestId": "UUID" } }`다.

| 응답 | 의미 |
| --- | --- |
| orderSeq / customerSeq | 주문·고객 번호 |
| status / paymentMethodType / pickupRequestedAt | 저장된 주문 상태·결제 방식·수거 요청 시각 |
| version | 현재 DB 버전. 수정·최종 접수의 expectedVersion으로 전달 |
| parcelNo / dverReceivedAt | 디버 접수 참고값·확인 시각. 접수 전에는 null. parcelNo는 식별 키가 아님 |
| createdAt / updatedAt | 주문 생성·최종 변경 시각 |
| parcels[] | parcelPosition 오름차순 상세 목록. 상세가 없으면 빈 배열 |
| parcels[].orderParcelSeq | 이후 수정할 기존 상세 번호 |
| parcels[].status | ACTIVE: 미취소 / CANCELLED: 취소. 접수·결제·배송 상태와 별개 |
| origin / destination | 저장된 주소 스냅샷. 9개 필드를 항상 반환하며 미수집 값은 null |
| originPin | 원본 주소록 scope·pinSeq 또는 null. 원본 변경을 주문 주소에 덮어쓰지 않음 |
| 수량·설명·clientComment·itemPrice | 저장된 물품 정보·요청 사항·가액. 0과 null을 구분 |
| notifiedPrice | AI가 전달한 상세별 배송비. 수집 중 미확인은 null, 취소 상세도 원가 보존 |
| totalAmount / paidAt / paymentDueAt | 미취소 상세의 합계, 결제 완료 시각, 최초 결제 대기 기한 |
| paymentRequest | 현재 유효한 미완료·미만료 결제 요청 또는 null. 상세 응답에서 ID·금액·만료 시각 제공 |

`parcels[].shipment`와 배송 추적번호·배송 상태는 반환하지 않는다. 취소된 상세의 주소·물품과 디버 접수번호·시각도 보존해 반환한다. 주문·상세·버전은 같은 DB 스냅샷에서 읽어 동시 수정으로 응답 내용이 섞이지 않게 한다. [전체·상세 단건/복수 취소](order-cancel.md) 이후에는 최신 version을 다시 조회한다.

배송 상태 조회는 Orders API의 책임에서 제외하며 별도 배송 API에서 다룬다. 기존 디버 접수 성공 시의 배송 데이터·초기 이력 저장과 중복 접수 방지는 유지한다. 배송 조회 API 자체는 이 변경에서 추가하지 않는다.

## 오류

| HTTP / code | 조건 |
| --- | --- |
| 400 INVALID_REQUEST | 잘못된 번호·필터·기간, AI 통화 헤더 누락 |
| 401 UNAUTHORIZED | 전달한 관리자 쿠키가 잘못되었거나 만료됨 |
| 403 FORBIDDEN | 관리자 권한 부족, 통화의 활성 고객 확인 불가, 다른 customerSeq 요청 |
| 404 NOT_FOUND | 통화·주문 없음. AI의 고객 범위 밖 주문 상세도 동일한 오류 |
| 409 INVALID_STATE | 종료된 통화로 목록 또는 기존 연결 주문 외 상세 조회 |

## AI 연동과 후속 작업

특정 시점에 사용한 출발지·도착지를 신규 주문에 재사용하려면 [42번 이전 주문 주소 조회](order-address-history.md)를 사용한다.

1. 상담 시작 시 POST /api/customers/context에 phoneNumber와 call(providerCallId·incomingAt)을 보내 고객·주소록과 `callSessionSeq`를 받는다. 상담 중 조회·취소에서는 이 값을 `call_session_seq` 헤더로 사용한다. 새 주문 결과는 POST /api/orders에 같은 통화 정보를 보내 기존 통화에 연결한다.
2. AI는 목록의 `data[]`에서 orderSeq를 선택하고, 상세의 `data`에서 주소·상세 번호·version을 읽는다.
3. 기존 주문 조회·보완은 같은 orderSeq를 사용한다. 새 AI 완료 결과는 ORD-01에서 디버 접수까지 처리하며 ORD-04·ORD-06을 추가 호출하지 않는다. [AI·PBX 계약](ai-pbx-recordings.md)을 참고한다.
4. 현재 `develop-ai`의 제안 호출부는 `/internal/ai/orders/search` POST·snake_case를 사용한다. 담당 호출부를 이 문서의 `/api/orders` GET·camelCase·응답 구조에 맞춰야 하며, 이번 백엔드 변경만으로 자동 연결되지 않는다.

Swagger `/api/docs`와 OpenAPI `/api/docs-json`에 각 API 요약·필터·헤더·응답 필드·오류를 등록했다. 통화 헤더 이름은 DB 컬럼명과 같은 `call_session_seq`다.

## 검증

`backend`에서 `node scripts/check.cjs`를 실행한다. 임시 PostgreSQL과 실제 NestJS HTTP 요청으로 필터·페이지·고객 범위·주소 스냅샷·동시 수정·Swagger를 검사하고, 기존 인증·주문 생성·기업·고객·구성원·PBX·Nginx를 회귀 검증한다.

이번 결제 구조는 016~019 migration을 요구하며 조회 자체는 데이터를 바꾸거나 외부 연동을 호출하지 않는다. 운영 데이터와 배포 설정을 변경하지 않는다. 실제 AI 컨테이너와의 통화 연동 및 운영 배포 검증은 별도다.
