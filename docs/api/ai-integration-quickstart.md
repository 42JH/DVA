# AI 서버 연동 변경 요약

결제·가격·부분 취소의 현재 규격과 요청·응답 전체 예시는 [AI 주문 결제 연동 규격](ai-order-billing-integration.md)을 따른다. COMPLETE는 개인 카드 결제 완료를 뜻하지 않는다.

이번 MR 배포 후 적용한다. AI는 상담 결과를 백엔드에 전달하고, 디버 접수·녹취 다운로드·S3 저장은 백엔드가 처리한다.

- 내부 주소: 같은 Docker 네트워크에서 `http://backend:3000`
- 외부 주소: `https://13.209.59.180`
- 공통: `Content-Type: application/json`. 아래 두 AI 호출은 현재 MVP 기준 관리자 쿠키·Bearer 토큰이 필요 없다.

## 1. 통화 시작: 고객 확인

`POST /api/customers/context`

```json
{
  "phoneNumber": "01012345678",
  "call": {
    "providerCallId": "call_example",
    "incomingAt": "2026-10-29T01:00:00Z"
  }
}
```

`+8210...`는 `010...`으로 변환한다. 응답의 `data.lookupStatus`는 `REGISTERED`, `UNREGISTERED`, `WITHDRAWN`이다. 등록 고객 번호는 `data.customer.customerSeq`, 주소록은 `data.personalPins`·`data.companyPins`에서 읽는다. 고객이나 주문을 새로 만들지는 않는다.

**`data.callSessionSeq`를 보관하고 상담 중 주문 조회·취소·주소록 API의 `call_session_seq` 헤더에 전달한다.** call에는 최초 수신 이벤트의 통화 ID와 created_at을 변환한 시각을 넣는다. 같은 통화의 재요청은 같은 번호를 반환하고, 발신번호·수신 시각이 달라지면 409다. 미등록·탈퇴 고객도 통화 번호는 반환하지만 기존 고객의 주문·주소록 접근 권한을 부여하지 않는다.

phoneNumber만 보내던 기존 요청도 동작하지만 통화를 만들거나 callSessionSeq를 반환하지 않는다. AI가 상담 중 업무 API를 사용하려면 위 call을 추가해야 한다.

## 2. 상담 결과: 주문 전송

`POST /api/orders` + **`Idempotency-Key: 주문별 UUID`**

| outcome | 전송 시점 | 백엔드 동작 |
| --- | --- | --- |
| `COMPLETE` | 주문 정보를 모두 수집하고 고객이 최종 확인한 뒤 | 디버 접수 후 결과 반환 |
| `INCOMPLETE` | 중도 종료·상담사 연결 | 수집한 정보만 `COLLECTING`으로 저장 |
| `CANCELLED` | 디버 접수 전 고객 취소 | `CANCELLED`로 저장 |

완료 요청 예시다. 주소·좌표는 실제 수집한 값, `pickupRequestedAt`은 미래 시각으로 보낸다.

```json
{
  "outcome": "COMPLETE",
  "call": {
    "providerCallId": "call_example",
    "callerPhoneNumber": "01012345678",
    "incomingAt": "2026-10-29T01:00:00Z"
  },
  "customer": {"name":"발신 고객","phoneNumber":"01012345678"},
  "paymentMethodType": "billing",
  "totalAmount": 3500,
  "pickupRequestedAt": "2026-10-30T10:00:00+09:00",
  "parcels": [{
    "origin": {
      "name":"발송인","phoneNumber":"01012345678",
      "roadAddress":"서울시 예시로 1","jibunAddress":"서울시 예시동 1",
      "detailAddress":"101호","dongName":"예시동","postalCode":"01234",
      "latitude":37.5,"longitude":127.0
    },
    "destination": {
      "name":"수령인","phoneNumber":"01087654321",
      "roadAddress":"서울시 배송로 2","jibunAddress":"서울시 배송동 2",
      "detailAddress":"","dongName":"배송동","postalCode":"05678",
      "latitude":37.6,"longitude":127.1
    },
    "smallBoxCount": 1,
    "itemPrice": 10000,
    "notifiedPrice": 3500,
    "clientComment": "문 앞 배송"
  }]
}
```

- `call`의 세 값은 모든 결과에 필수다. `providerCallId`는 최초 수신한 OpenAI 통화 식별자이며 재전송 때 유지한다. `incomingAt`은 수신 이벤트의 `created_at`(Unix 초)을 ISO 8601로 변환한다. 결과 전송 시각이나 AI 서버의 현재 시각을 넣지 않는다.
- 고객 확인에서 보낸 것과 같은 통화 ID·발신번호·수신 시각을 사용한다. 백엔드는 앞서 만든 통화를 재사용해 주문을 연결한다.
- 기존 고객은 `customer` 대신 `"customerSeq": 12`를 보낸다. 두 필드는 동시 입력하지 않는다. 미등록 고객은 이름·전화번호로 주문과 함께 등록한다.
- 미완료·취소는 `outcome`과 `call`만으로 전송할 수 있다. 수집한 값이 있으면 같은 구조에 추가하고, 미수집 필드는 생략한다.
- 완료는 출발지·도착지의 이름·전화번호·도로명·지번·동명·우편번호·좌표, 물품 종류/수량·가액, 미래 수거 시각이 필요하다. 결제는 `billing`(개인·기업 카드, 기본값), `credit`(월결제 자격), `groupBilling`(부서 그룹결제 자격)이다.
- 이 결과 전송에는 `call_session_seq` 헤더나 별도 `/submit` 호출이 필요 없다. 통화 한 건의 여러 택배는 `parcels`에 묶는다.

## 3. 응답과 재시도

```json
{
  "data": {"orderSeq":123,"version":4,"status":"ACCEPTED","callSessionSeq":7,"parcelNo":"TEST0057"},
  "meta": {"requestId":"a73c0008-775a-42ca-8903-1a240654fcfa"}
}
```

| 응답 | AI 처리 |
| --- | --- |
| `data.status=ACCEPTED` | 접수 성공 안내. `parcelNo`는 디버 접수 참고번호 |
| `COLLECTING` / `CANCELLED` | 미완료·취소 저장 완료 |
| HTTP 202 / `SUBMITTING` | 처리 중. 같은 UUID·같은 요청으로 잠시 후 재확인 |
| `SUBMISSION_FAILED` | 성공 안내 금지, 담당자 확인. 새 주문으로 자동 재접수하지 않음 |
| 네트워크 실패·504·409 `REQUEST_IN_PROGRESS` | 같은 UUID·같은 요청으로 재시도 |

HTTP 201만으로 접수 성공을 판단하지 않는다. 오류 본문은 `error.code`·`error.message`를 읽는다. UUID는 최초 전송 전에 한 번 만들고 재시도에 재사용한다. 같은 UUID로 바꾼 본문은 재적용되지 않는다. COMPLETE 전송 후 통화가 끊겨도 별도 INCOMPLETE/CANCELLED를 보내지 않는다. HTTP timeout은 10초보다 여유 있게 둔다.

## 기존 주문 취소 추가

1번 고객 확인 응답의 `data.callSessionSeq`를 `call_session_seq` 헤더로 전달한다. 전화번호가 같은 활성 고객의 주문만 허용한다. Idempotency-Key는 없다.

| 호출 | 처리 |
| --- | --- |
| `POST /api/orders/{orderSeq}/cancel` | 전체 취소. 204, 본문 없음. 이미 전체 취소면 409 |
| `POST /api/orders/{orderSeq}/parcels/cancel` | 본문 `{"orderParcelSeqs":[456,457]}`. 한 개면 단건, 여러 개면 복수 취소. 마지막 상세까지 취소하면 주문도 취소. 성공 204 |

상세 취소는 `Content-Type: application/json`과 같은 주문의 번호 배열이 필수다. 빈 배열·중복 번호는 400이다. 이미 취소된 상세는 건너뛰며, 선택한 상세 중 하나라도 없거나 취소 불가이면 전체 요청을 거절한다. 기존 URL의 상세번호 자리는 제거하고 단건도 배열로 보낸다.

번호는 주문 목록·상세 응답에서 선택한다. 결제 전만 취소하며 접수 처리 중·결과 미확정은 409다. 성공 후 상세를 재조회한다. `parcels[].status`는 ACTIVE/CANCELLED이고 부분 취소 시 주문 상태는 유지된다. 새 상담의 `outcome=CANCELLED`는 기존 주문을 취소하는 호출이 아니다. 실제 디버 취소 연동은 없으며 [상세 계약](order-cancel.md)을 따른다.

## 4. 녹취 처리

통화 종료 웹훅은 PBX가 기존 `POST /api/webhooks/pbx/call-ended`로 보낸다. 백엔드가 발신번호·시작 시각으로 연결하고 녹취를 S3에 저장하므로 AI가 별도 녹취 저장 API를 호출할 필요는 없다.
조회·취소만 한 상담도 1번에서 통화가 저장되므로 신규 주문 없이 녹취를 연결할 수 있다.

기존 AI의 `/internal/ai/callers/context`·`/internal/ai/orders`, `phone`·snake_case 주문, `order_no` 응답 처리를 위 계약으로 변경한다. 상세 필드는 [주문 명세](orders.md), 전체 흐름은 [AI·PBX 연동 명세](ai-pbx-recordings.md)를 참고한다.
