# AI 서버 연동 변경 요약

이번 MR 배포 후 적용한다. AI는 상담 결과를 백엔드에 전달하고, 디버 접수·녹취 다운로드·S3 저장은 백엔드가 처리한다.

- 내부 주소: 같은 Docker 네트워크에서 `http://backend:3000`
- 외부 주소: `https://13.209.59.180`
- 공통: `Content-Type: application/json`. 아래 두 AI 호출은 현재 MVP 기준 관리자 쿠키·Bearer 토큰이 필요 없다.

## 1. 통화 시작: 고객 확인

`POST /api/customers/context`

```json
{"phoneNumber":"01012345678"}
```

`+8210...`는 `010...`으로 변환한다. 응답의 `data.lookupStatus`는 `REGISTERED`, `UNREGISTERED`, `WITHDRAWN`이다. 등록 고객 번호는 `data.customer.customerSeq`, 주소록은 `data.personalPins`·`data.companyPins`에서 읽는다. 이 호출은 고객·통화를 생성하지 않는다. 탈퇴 고객을 신규 고객으로 취급하지 않는다.

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
    "incomingAt": "2026-10-27T01:00:00Z"
  },
  "customer": {"name":"발신 고객","phoneNumber":"01012345678"},
  "paymentMethodType": "credit",
  "pickupRequestedAt": "2026-10-28T10:00:00+09:00",
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
    "clientComment": "문 앞 배송"
  }]
}
```

- `call`의 세 값은 모든 결과에 필수다. `providerCallId`는 최초 수신한 OpenAI 통화 식별자이며 재전송 때 유지한다. `incomingAt`은 수신 이벤트의 `created_at`(Unix 초)을 ISO 8601로 변환한다. 결과 전송 시각이나 AI 서버의 현재 시각을 넣지 않는다.
- 기존 고객은 `customer` 대신 `"customerSeq": 12`를 보낸다. 두 필드는 동시 입력하지 않는다. 미등록 고객은 이름·전화번호로 주문과 함께 등록한다.
- 미완료·취소는 `outcome`과 `call`만으로 전송할 수 있다. 수집한 값이 있으면 같은 구조에 추가하고, 미수집 필드는 생략한다.
- 완료는 출발지·도착지의 이름·전화번호·도로명·지번·동명·우편번호·좌표, 물품 종류/수량·가액, 미래 수거 시각이 필요하다. 결제는 `credit`(기업·개인 기본), `groupBilling`(기업), `billing`(개인)이다.
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
| `AUTH_FAILED` / `REVIEW_REQUIRED` | 성공 안내 금지, 담당자 확인. 새 주문으로 자동 재접수하지 않음 |
| 네트워크 실패·504·409 `REQUEST_IN_PROGRESS` | 같은 UUID·같은 요청으로 재시도 |

HTTP 201만으로 접수 성공을 판단하지 않는다. 오류 본문은 `error.code`·`error.message`를 읽는다. UUID는 최초 전송 전에 한 번 만들고 재시도에 재사용한다. 같은 UUID로 바꾼 본문은 재적용되지 않는다. COMPLETE 전송 후 통화가 끊겨도 별도 INCOMPLETE/CANCELLED를 보내지 않는다. HTTP timeout은 10초보다 여유 있게 둔다.

## 4. 녹취 처리

통화 종료 웹훅은 PBX가 기존 `POST /api/webhooks/pbx/call-ended`로 보낸다. 백엔드가 발신번호·시작 시각으로 연결하고 녹취를 S3에 저장하므로 AI가 별도 녹취 저장 API를 호출할 필요는 없다.

기존 AI의 `/internal/ai/callers/context`·`/internal/ai/orders`, `phone`·snake_case 주문, `order_no` 응답 처리를 위 계약으로 변경한다. 상세 필드는 [주문 명세](orders.md), 전체 흐름은 [AI·PBX 연동 명세](ai-pbx-recordings.md)를 참고한다.
