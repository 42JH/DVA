# 주문 정보가 없는 AI 통화 결과

POST /api/orders의 AI 결과 수신에 적용한다. endpoint·요청 필드는 그대로다. frontend·AI 소스 변경은 이번 작업에 포함하지 않는다.

## 주문을 만들지 않는 조건

본문 call이 있고 outcome이 INCOMPLETE 또는 CANCELLED이며 아래 주문 정보가 모두 비어 있을 때다.

- paymentMethodType·pickupRequestedAt·totalAmount가 미수집이다.
- parcels가 없거나 빈 배열이거나, 모든 항목이 빈 주소·수량 0·빈 설명·미수집 가격으로만 구성된다.
- 고객 번호·고객 이름·발신번호·통화 ID만 있는 것은 주문 정보로 계산하지 않는다.

부분 주소·물품 수량·배송 요청사항·선택한 PIN·결제수단·수거시각·금액 중 하나라도 수집했으면 기존처럼 미완료·취소 주문을 보존한다. 물품 가액 0원과 좌표 0은 수집한 값이며 지우지 않는다. 일부 수집한 문의 통화인지 실제 접수 의도인지는 현재 요청만으로 구분하지 않는다.

실제 AI 클라이언트는 모르는 필드를 생략한다. 기존 요청 검증을 유지하므로 paymentMethodType나 parcels 자체에 명시적 null을 보내면 400이다. 주소의 개별 필드·가격처럼 원래 null을 허용한 필드는 계속 허용한다. COMPLETE의 필수값 누락은 기존대로 422이며 NO_ORDER로 바꾸지 않는다. 관리자 수기·기존 부분 저장·AI의 기존 통화 헤더 방식은 유지한다.

## 요청·응답

```http
POST /api/orders
Content-Type: application/json
Idempotency-Key: 8d613ee5-27d2-4a91-9050-cb2bad356b09
```

```json
{
  "outcome": "INCOMPLETE",
  "call": {
    "providerCallId": "inquiry-001",
    "callerPhoneNumber": "01012345678",
    "incomingAt": "2026-11-01T11:00:00Z"
  },
  "customerSeq": 10
}
```

HTTP 201, data의 상태는 NO_ORDER다. 통화 번호는 실제 DB 번호다.

```json
{
  "data": {
    "orderSeq": null,
    "version": null,
    "status": "NO_ORDER",
    "callSessionSeq": 123,
    "parcelNo": null,
    "totalAmount": null,
    "paymentDueAt": null,
    "paymentRequest": null
  },
  "meta": { "requestId": "server-request-id" }
}
```

NO_ORDER는 API 수신 성공이며 접수 실패나 디버 접수 성공을 뜻하지 않는다. orders의 상태 코드에는 추가하지 않는다. orderSeq가 null이면 주문 상세·수정·최종 접수·취소 API를 호출하지 않는다.

## 보존·재전송·후속 흐름

통화 이력은 call_sessions에 보존하고 order_seq는 null이다. 통화 이벤트·분석·미답변은 기존 callSessionSeq로 처리하며 관리자 통화 조회에서도 유지된다. 주문 목록·건수에는 포함하지 않는다. 주문·배송상세·결제 요청·디버 호출은 생성하지 않는다. 기존 고객 검증과 명시적 customer 입력에 따른 신규 고객 등록 동작은 유지한다.

동일한 Idempotency-Key·동일 통화·동일 호출 주체는 재시작·통화 종료 뒤에도 같은 NO_ORDER 응답을 받는다. 현재 API의 재전송 규칙대로 나중에 본문을 바꿔도 첫 결과는 바뀌지 않는다. 키를 다른 통화·호출 주체가 재사용하면 403이다. 결과가 이미 확정된 통화에 다른 키로 새 주문을 만들면 409이며 기존 키로 확인한다. 동시 처리 중에는 기존 409 REQUEST_IN_PROGRESS 뒤 같은 키로 재시도한다.

현재 develop-ai(0f756d7c)의 결과 수신기는 data를 그대로 반환하고 status=SUBMITTING일 때만 계속 확인한다. 주문 번호 참조는 null을 허용하므로 이 응답을 소비할 수 있다. AI 관제 화면에서 NO_ORDER를 사람이 읽는 이름으로 표시하는 변경은 AI 팀이 반영한다. 실제 양 서버 연결 검증은 별도다.

## DB 적용

migration 037·038이 필요하다. 038은 empty_ai_order_results에 요청 UUID(PK), 통화 번호(UNIQUE), 호출 관리자 번호(없으면 null), 수신 시각만 저장한다. 통화·관리자 번호는 논리 참조다. 주문 행이 없으므로 여기에 재전송 키와 최종 결과 여부를 보존한다. 해당 기록과 통화 생성은 같은 트랜잭션이며 저장 실패 시 함께 롤백한다.

과거의 빈 주문과 결제 이력은 자동 삭제·변경하지 않는다. 실제 서버 DB 적용·배포는 이번 작업에서 수행하지 않는다.
