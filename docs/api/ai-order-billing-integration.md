# AI → 모놀리식 백엔드 주문·결제·취소 연동 규격

관련 작업: [S15P31D109-138](https://ssafy.atlassian.net/browse/S15P31D109-138). 이 문서는 백엔드 변경을 AI 팀에 인계하는 규격이다. 이번 작업에서는 AI 폴더와 AI 서버를 수정하지 않았다.

기본 경로는 `/api`다. 요청·응답 필드는 camelCase를 사용한다. 단건은 `{data,meta}`, 목록은 `{data,hasNext}`, 오류는 `{error,meta}`이며 204는 본문이 없다. meta.requestId와 응답 X-Request-Id로 문의할 요청을 연결할 수 있다.

## 1. 결제 방식과 자격

| paymentMethodType | 의미 | 사용 조건 | 주문 확정 직후 |
| --- | --- | --- | --- |
| billing | 개인 카드 결제 | 활성 개인·기업 구성원 고객 모두 | notPaid |
| credit | 월결제 | 개인은 본인 설정, 기업 구성원은 활성 소속·기업의 월결제 설정 | PAID 후 디버 접수 |
| groupBilling | 부서 그룹결제 | 활성 기업 소속 부서의 그룹결제 설정 | PAID 후 디버 접수 |

기업 구성원은 기업 하나와 부서 하나에 속한다. 기업 월결제와 부서 그룹결제가 모두 켜져 있으면 AI가 상담으로 방식을 선택한 뒤 paymentMethodType 하나를 보낸다. 신규 설정은 기본 false다. AI는 결제 자격을 켜거나 주문 본문에 monthlyBillingEnabled/groupBillingEnabled를 넣어 우회할 수 없다. 최종 확정 시 백엔드가 현재 자격을 다시 검사한다.

## 2. 상담 시작과 고객 확인

```http
POST /api/customers/context
Content-Type: application/json
```

```json
{
  "phoneNumber": "01012345678",
  "call": {
    "providerCallId": "rtc_example_138",
    "incomingAt": "2026-10-29T15:30:00Z"
  }
}
```

phoneNumber는 숫자 문자열이다. call은 실제 통화 이벤트의 식별자와 수신 시각이며 같은 통화를 재요청할 때 유지한다. 응답의 callSessionSeq는 DB 통화 번호다. 이후 주문 조회·수정·확정·취소 요청에는 `call_session_seq` 헤더로 보낸다.

기존 lookupStatus, customer, membership, organization, availableUsageTypes, personalPins, companyPins를 유지하고 다음을 추가한다.

| 응답 | 내용 |
| --- | --- |
| customer.monthlyBillingEnabled | 개인 고객의 월결제 설정 |
| organization.monthlyBillingEnabled | 기업 전체 월결제 설정 |
| membership.departmentSeq | 소속 부서 번호 |
| department | departmentSeq, organizationSeq, name, groupBillingEnabled. 부서가 없으면 null |
| availablePaymentMethods | 현재 사용할 수 있는 billing/credit/groupBilling 배열 |

미등록·탈퇴 고객은 availablePaymentMethods가 빈 배열이다. 활성 고객은 billing을 사용할 수 있다. 기업 소속이 있으면 개인 월결제 설정 대신 소속·기업 자격을 사용한다. 개인 신규 등록은 기존 고객 API를 사용하거나 주문의 customer에 이름·전화번호를 보낸다.

MVP의 AI 서비스 인증 미적용 범위는 기존과 같다(후속 Jira 135). callSessionSeq는 인증 토큰이 아니며 고객 데이터 접근 범위 확인에 사용한다. 잘못된 관리자 쿠키를 함께 보내면 AI 호출로 우회하지 않고 인증 오류가 난다.

## 3. 주문 금액

한 번 접수하는 묶음은 orders, 개별 배송 항목은 order_parcels다. 개별 항목별 배송비를 보존하며 결제는 미취소 항목의 합계를 한 번에 진행한다.

- totalAmount: 미취소 상세 배송비의 합계, 원 단위 양의 정수.
- parcels[].notifiedPrice: 해당 배송 항목의 배송비, 원 단위 양의 정수.
- 두 값의 최대는 2,147,483,647이고 전체 합계도 이 범위 안이어야 한다. 문자열·소수는 받지 않는다.
- itemPrice는 물품 가액이다. 배송비와 합산하지 않는다. 최종 확정 시 0 이상 JavaScript 안전 정수 범위의 값이 필요하다.
- AI가 전달한 totalAmount와 배송비 합계가 다르면 422이며 주문 확정·디버 전송은 하지 않는다.
- 기존 고정 3,500원 가정은 제거됐다. 미완료 상담에서는 아직 모르는 금액을 생략하거나 null로 저장할 수 있지만 최종 확정 시 모두 필요하다.

## 4. 상담 완료 주문 생성

```http
POST /api/orders
Content-Type: application/json
Idempotency-Key: 069192b9-09cc-4585-b557-2876f5e5a1b1
```

```json
{
  "outcome": "COMPLETE",
  "call": {
    "providerCallId": "rtc_example_138",
    "callerPhoneNumber": "01012345678",
    "incomingAt": "2026-10-29T15:30:00Z"
  },
  "customerSeq": 10,
  "paymentMethodType": "billing",
  "pickupRequestedAt": "2026-11-02T10:00:00+09:00",
  "totalAmount": 5000,
  "parcels": [
    {
      "origin": {
        "name": "발송인",
        "phoneNumber": "01012345678",
        "roadAddress": "서울특별시 예시로 1",
        "jibunAddress": "서울특별시 예시동 1",
        "detailAddress": "101호",
        "dongName": "예시동",
        "postalCode": "01234",
        "latitude": 37.5,
        "longitude": 127
      },
      "destination": {
        "name": "수령인",
        "phoneNumber": "01098765432",
        "roadAddress": "서울특별시 예시로 2",
        "jibunAddress": "서울특별시 예시동 2",
        "detailAddress": "202호",
        "dongName": "예시동",
        "postalCode": "01235",
        "latitude": 37.6,
        "longitude": 127.1
      },
      "smallBoxCount": 1,
      "itemPrice": 10000,
      "notifiedPrice": 5000,
      "clientComment": "문 앞 수거"
    }
  ]
}
```

예시의 번호·주소·시각은 실제 통화와 고객 데이터로 교체한다. customerSeq 또는 customer 중 하나만 보낸다. customer는 name·phoneNumber만 받으며 통화 발신번호와 일치해야 한다. call과 outcome은 함께 보낸다. body.call이 있으면 통화 헤더는 생략할 수 있고 둘 다 보내면 같은 통화여야 한다.

최종 주소에는 name, phoneNumber, roadAddress, jibunAddress, dongName, postalCode(5자리), latitude, longitude가 필요하다. detailAddress는 비어 있을 수 있다. documentCount/smallBoxCount/mediumBoxCount/bigBoxCount 중 양수가 있거나 otherItemDescription이 필요하다. pickupRequestedAt은 생략 가능하다. 서버가 결제 완료 시각 + 1시간으로 결정하고 재접수 때도 저장된 값을 유지한다.

같은 주문 의도는 Idempotency-Key UUID를 재사용한다. 재요청은 기존 주문의 현재 결과를 반환하며 본문을 재적용하지 않는다. 상담 중 수집 내용을 바꾸려면 기존 미완료 주문 수정 경로를 사용한다.

개인 카드 응답 예시:

```json
{
  "data": {
    "orderSeq": 100,
    "version": 2,
    "status": "notPaid",
    "totalAmount": 5000,
    "callSessionSeq": 20,
    "parcelNo": null,
    "paymentDueAt": "2026-10-30T15:30:00.000Z",
    "paymentRequest": {
      "paymentRequestId": "cf9c096f-a0c7-43fc-a946-dbbac5134e9a",
      "amount": 5000,
      "expiresAt": "2026-10-30T15:30:00.000Z"
    }
  },
  "meta": {"requestId": "44956de7-5380-48c5-b3f2-f5f2dfbdd565"}
}
```

paymentDueAt은 실제 결제 대기 시작 +24시간이다. paymentRequestId는 무작위 결제 요청 식별자이고 `/api/payments/p/{id}` 링크로 연결한다. 결제 완료·취소 후 현재 paymentRequest는 null이다. 연동 설정 활성화 시 백엔드가 Mattermost로 안내를 자동 발송하고, 토스 승인 확인 후 디버에 전송한다. 카카오 알림톡은 후속 범위다. AI가 별도 메시지 발송이나 결제 성공 신고 API를 호출할 필요가 없으며, 주문 저장 응답만으로 발송·결제 완료를 안내해서는 안 된다. 상세는 [실제 주문 결제 계약](order-payment-integration.md)을 따른다.

## 5. 상태 확인과 안내

```http
GET /api/orders/100
call_session_seq: 20
```

상세에는 status, totalAmount, paymentDueAt, paidAt, paymentRequest와 parcels가 포함된다. 각 상세의 orderParcelSeq는 조회 응답에서 얻고 배열 순번으로 추정하지 않는다.

| status | AI 안내 기준 |
| --- | --- |
| COLLECTING | 필요한 내용을 수집 중인 미완료 상담 |
| notPaid | 주문 저장 완료, 개인 카드 결제 대기 |
| PAID | 결제 완료, 디버 접수 시작 대기 |
| SUBMITTING | 디버 접수중 |
| ACCEPTED | 디버 접수 완료 |
| SUBMISSION_FAILED | 결제는 완료됐으나 디버 접수 실패, 운영자 확인 필요 |
| CANCELLED | 취소됨 |

COMPLETE는 상담 내용이 완성됐다는 뜻이며 개인 카드의 결제 완료나 디버 접수 성공을 뜻하지 않는다. HTTP 201/200만으로 접수 성공을 안내하지 않고 data.status를 확인한다. SUBMITTING에는 HTTP 202가 올 수 있다. 디버 응답은 200 성공·400 실패를 가정하며 외부 오류 코드는 표시하지 않는다. 응답 형식이 잘못된 경우도 접수 성공으로 안내하지 않는다.

결제 결과에 따른 상태 변경과 디버 전송은 백엔드가 수행한다. AI가 결제 완료 상태를 직접 지정하는 API는 없다. 결제 완료부터 주문 내용 수정·취소는 불가하다. SUBMISSION_FAILED도 결제 완료 주문이며 운영자 재접수 대상이다.

## 6. 미완료 상담 보완

outcome=INCOMPLETE는 기존과 같이 COLLECTING으로 저장한다. outcome=CANCELLED는 취소 상태로 보존한다. 고객을 확인하지 못한 미완료·취소 결과도 저장할 수 있다.

미완료 주문은 다음처럼 변경값을 보낸다. COLLECTING에서만 가능하다.

```http
PATCH /api/orders/100
call_session_seq: 20
Content-Type: application/json
```

```json
{
  "expectedVersion": 2,
  "totalAmount": 5000,
  "parcels": [{"orderParcelSeq": 300, "notifiedPrice": 5000}]
}
```

이후 POST /api/orders/100/submit에 새 expectedVersion을 보내 최종 확정한다. 주소·물품·고객·PIN·결제 자격·총액을 다시 검사한다. notPaid 이후에는 보완 API를 사용할 수 없다. version은 변경 항목 수에 따라 증가하므로 +1로 계산하지 않고 응답/조회 값을 사용한다.

## 7. 개별·복수·전체 취소

취소 대상은 COLLECTING 또는 개인 카드 notPaid 주문이다. 통화에 연결된 고객의 주문만 허용한다. 진행 중 통화는 같은 고객의 다른 통화 주문도 조회·취소할 수 있고 종료된 통화는 이미 연결된 주문만 허용한다.

```http
POST /api/orders/100/parcels/cancel
call_session_seq: 20
Content-Type: application/json
```

```json
{"orderParcelSeqs": [300, 301]}
```

한 개면 단건, 여러 개면 복수 취소다. 번호는 양의 DB 정수이고 배열은 비어 있거나 중복될 수 없다. 다른 주문의 번호가 섞여 있으면 전체가 거절된다. 성공은 204이며 GET 상세로 최신 상태·금액·결제 요청을 다시 확인한다.

취소한 상세는 CANCELLED로 남고 원래 금액을 보존한다. 나머지 상세는 계속 진행하며 상위 totalAmount는 남은 합계가 된다. notPaid 주문의 이전 결제 요청은 닫고 남은 금액으로 새 요청을 만든다. 최초 24시간 기한은 연장하지 않는다. 같은 상세의 반복 취소는 204이고 금액·감사·결제 요청을 중복 변경하지 않는다.

전체 취소는 본문 없이 POST /api/orders/100/cancel을 사용한다. 마지막 미취소 상세까지 취소하면 상위 주문도 CANCELLED, 결제 금액은 0원이 된다. 이미 전체 취소된 주문의 전체 취소 재요청은 409다.

결제 승인이 먼저 시작됐다면 취소는 409다. 취소가 먼저 확정됐다면 이전 결제 요청으로 결제를 시작할 수 없다. 결제 완료 이후에는 전체·부분 취소 모두 거절한다. 취소·만료는 주문 상세·통화·녹취·감사를 삭제하지 않는다.

## 8. 오류와 재시도

| HTTP | 대표 상황 | AI 처리 |
| --- | --- | --- |
| 400 | 헤더·번호·JSON 형식 오류 | 호출 형식 수정 |
| 403 | 고객·PIN·결제 방식 사용 자격 없음 | 자격 확인 후 허용된 방식 선택 |
| 404 | 통화/주문/상세 없음 또는 다른 고객 범위 | 번호와 고객 확인 |
| 409 | 상태·버전 충돌, 승인 처리 중, 통화 연결 충돌 | 최신 주문 조회 후 상태에 맞게 처리 |
| 422 | 필수 정보·배송비·합계 검증 실패 | COLLECTING에서 내용을 보완한 뒤 확정 |
| 503 | DB·디버 설정 등 의존성 사용 불가 | 성공 안내를 하지 않고 같은 요청 키로 결과 확인 |

네트워크 응답을 받지 못한 주문 생성은 새 키로 주문을 복제하지 않고 같은 키로 확인한다. 부분 취소도 조회로 상태를 확인하고 같은 상세 번호를 재요청할 수 있다. 주문 목록은 GET /api/orders의 status 필터로 조회할 수 있다.

디버 재접수는 운영자 전용 POST /api/admin/orders/{id}/retry다. 같은 주문을 재결제하거나 월별 사용액에 다시 합산하지 않는다. 같은 내용으로 다시 400이면 접수 실패 상태를 유지한다. 결제 후 내용 수정·환불은 이번 범위에 포함하지 않는다.

## 9. 자동 처리와 로그 담당자

개인 카드 미결제 주문은 최초 결제 대기 +24시간 뒤 SYSTEM 취소 대상이다. 결제 승인 처리 중인 요청은 결과 확인 전까지 임의로 취소하지 않는다. 월별 기업 사용액은 한국 시간 기준 새 월에 0원으로 시작하며 지난 월 기록을 보존한다.

| actorType | actorLabel | 의미 |
| --- | --- | --- |
| AI | AI | AI 호출로 수행한 접수·보완·취소 |
| SYSTEM | SYSTEM | 결제 결과·디버 응답 반영, 자동 만료, 월별 초기화·증가 |
| ADMIN | 운영자 | 관리자 페이지의 작업. actorSeq/actorName으로 실제 운영자 확인 |

AI 취소에는 취소 항목과 금액 변경 전후를 함께 기록한다. AI 폴더나 AI 서버의 실제 호출 코드는 AI 팀에서 이 규격에 맞춰 별도로 변경해야 한다.

## 10. 기업·부서 삭제 이후 연동

기업·부서 삭제는 활성 관리자 전용이며 AI 서버에 삭제 API 호출 권한이나 새 삭제 이벤트는 추가하지 않는다. [기업·부서 삭제 규격](company-deletion.md)의 정리와 기록 보존을 적용한다.

- 고객 확인에서 삭제 대상 사원의 membership·organization·department는 null, companyPins는 빈 배열이다. customer·personalPins는 유지하며 availablePaymentMethods를 다시 확인한다. 개인의 월결제 설정이 true이면 credit은 계속 가능하지만 기존 기업 청구가 아닌 개인 월결제로 처리한다.
- 기업 PIN 응답에 `departmentSeq`가 추가된다. null과 빈 부서명은 기업 공용, 부서 번호가 있으면 그 부서 PIN이다. 기존 미배정 부서명 PIN도 번호가 null일 수 있다. 부서만 삭제하면 기업 공용·다른 부서 PIN은 남는다.
- 과거 주문의 주소·PIN 출처 번호·결제 상태·통화·녹취는 보존한다. 주문 상세는 결제 당시 `billingOrganizationSeq/billingOrganizationName/billingDepartmentSeq/billingDepartmentName`을 반환하며, 현재 소속으로 과거 기업을 추정하지 않는다.
- COLLECTING의 최종 접수는 현재 자격·PIN을 검사하므로 삭제된 기업 자격/PIN은 403일 수 있다. 주문을 다시 생성하지 않고 기존 주문에서 허용 결제 방식과 주소 출처를 확인한다. 주소 사본은 유지할 수 있지만 삭제된 PIN은 `originPin:null`로 해제해야 한다.
- notPaid는 기존 요청·금액·만료 시각으로 개인 결제를 이어간다. 결제 완료 주문은 저장된 사본으로 디버 접수·운영자 재접수를 계속한다. 회사 삭제를 이유로 자동 취소하거나 재청구하지 않는다.

이번 변경은 Backend와 문서만 포함하며 AI 팀은 고객 확인을 다시 호출하고 403 이후 자격/PIN 재확인 안내를 연결한다.
