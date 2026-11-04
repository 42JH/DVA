# 주문 전체·상세 취소

관련 Jira: [64](https://ssafy.atlassian.net/browse/S15P31D109-64), [결제·부분 취소 개편 138](https://ssafy.atlassian.net/browse/S15P31D109-138). 현재 정책은 [주문 결제](order-billing.md)를 따른다.

## 요청·응답

| API | 입력 | 성공 |
| --- | --- | --- |
| POST /api/orders/{id}/cancel | orderSeq. 본문 없음 | 전체 취소, 204 본문 없음 |
| POST /api/orders/{id}/parcels/cancel | orderSeq와 orderParcelSeqs 배열 | 선택 상세 취소, 204 본문 없음 |

~~~json
{"orderParcelSeqs":[101,102]}
~~~

한 개는 단건, 여러 개는 복수 취소다. 상세 번호는 GET /api/orders/{id}의 parcels[].orderParcelSeq를 사용한다. 빈 배열·중복·문자열 번호·잘못된 범위·추가 필드는 400이다. 하나라도 같은 주문에 속하지 않거나 없으면 404로 전체를 거절한다. Idempotency-Key·expectedVersion은 사용하지 않는다.

## 허용 상태와 금액

| orders.status | 전체·선택 상세 취소 |
| --- | --- |
| COLLECTING | 허용. 배송 행이 생긴 비정상 초안은 거절 |
| notPaid | 허용. 결제 승인 중 또는 배송 행이 있으면 거절 |
| PAID / SUBMITTING / ACCEPTED / SUBMISSION_FAILED | 결제 완료 주문이므로 409 |
| CANCELLED | 전체 재요청 409. 이미 취소된 상세만 선택한 반복 요청은 204 |

부분 취소 시 선택한 상세만 CANCELLED로 저장하고 나머지는 유지한다. 원래 상세 가격·주소·물품을 보존하며 totalAmount는 남은 미취소 상세의 합계다. 마지막 상세까지 취소하면 상위도 CANCELLED, totalAmount는 0원이다. 최초 AI 상담 결과가 CANCELLED인 경우도 총액은 0원으로 저장한다.

notPaid에서는 기존 결제 요청을 닫고 새 UUID·남은 합계로 요청을 만든다. 최초 결제 대기 시작 +24시간 기한은 연장하지 않는다. 전체 취소는 새 요청 없이 기존 요청만 닫는다. 결제 요청 ID는 내부 식별자이며 실제 PG URL은 추후 연동한다.

이미 취소된 상세는 건너뛰며 재요청으로 금액·감사·결제 요청을 중복 변경하지 않는다. 전체·부분 요청은 주문 행을 먼저 잠가 직렬화한다. 결제 승인이 먼저 선점되면 409이며, 취소가 먼저 끝나면 예전 결제 요청으로 결제를 시작할 수 없다. 취소·금액·요청 교체·감사 중 하나라도 실패하면 전체를 롤백한다.

## 접근·보존·감사

관리자는 ACTIVE OPERATOR/SUPERVISOR/SYSTEM_ADMIN 세션과 허용 Origin을 사용한다. AI는 call_session_seq 헤더의 발신번호와 활성 고객이 일치하는 주문만 취소한다. 진행 중 통화는 같은 고객 범위, 종료된 통화는 이미 연결된 주문 한 건만 허용한다. 잘못된 관리자 쿠키는 AI 호출로 전환하지 않는다. AI 서비스 인증은 기존 MVP 정책을 유지한다.

주문 상세·통화·녹취·감사를 삭제하지 않는다. 디버 접수 전의 내부 취소이며 외부 취소·환불은 지원하지 않는다. 관리자 내부 주문 보정은 [PATCH 수정 규칙](order-update.md)을 따르며 이 취소 API의 허용 상태는 그대로다.

AI 요청은 AI, 관리자 요청은 ADMIN(화면 표시 운영자), 24시간 자동 만료는 SYSTEM으로 기록한다. 전체 취소는 ORDER_CANCELLED, 선택 상세는 ORDER_PARCEL_CANCELLED, 금액 변경은 ORDER_AMOUNT_CHANGED에 전후 금액·상세 번호를 남긴다. 자동 만료는 ORDER_CANCELLED에 PAYMENT_EXPIRED 사유와 금액을 남긴다. 실제 운영자 ID·이름은 보존한다.

## 확인

취소 후 GET 상세로 최신 status·version·totalAmount·paymentRequest를 확인한다. 400 입력, 401 세션, 403 권한, 404 대상·고객 범위, 409 주문·통화 상태 또는 승인 처리 중 오류를 구분한다. 취소된 상세는 주소 이력 추천과 신규 디버 전송에서 제외한다.

관련 migration은 014의 상세 상태에 016~019의 가격·결제 구조를 추가한다. 적용된 이전 SQL은 수정하지 않으며 최초 전환·복구는 [DB 절차](../database/README.md)를 따른다.
