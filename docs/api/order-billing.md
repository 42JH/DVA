# 주문 결제와 접수

Jira: [S15P31D109-138](https://ssafy.atlassian.net/browse/S15P31D109-138).

## 상태

| status | 표시 | 다음 처리 |
| --- | --- | --- |
| COLLECTING | 미완료 상담 | 보완 후 최종 확정 또는 취소 |
| notPaid | 결제 대기 | 개인 카드 결제 완료 또는 전체/부분 취소·만료 |
| PAID | 결제 완료 | 디버 전송 시작 |
| SUBMITTING | 디버 접수중 | 디버 200 성공 / 400 실패 결과 반영 |
| ACCEPTED | 디버 접수 완료 | 주문 내용 수정·취소 불가 |
| SUBMISSION_FAILED | 디버 접수 실패 | 관리자 재접수 |
| CANCELLED | 취소됨 | 주문·상세·통화·녹취·감사 보존 |

결제·디버 진행은 orders.status 하나로 관리한다. 상세의 기존 ACTIVE/CANCELLED는 부분 취소 여부만 나타낸다. 별도의 상위 주문 부분 취소 상태는 추가하지 않는다. 결제 대기부터 내용 수정은 불가하고, 취소되지 않은 상세의 금액 합계만 취소 처리로 변경한다.

## 생성과 최종 확정

AI는 기존 POST /api/orders의 outcome=COMPLETE, 관리자 수기는 POST /api/admin/orders를 사용한다. 기존 미완료 주문은 PATCH /api/orders/{id}로 보완한 뒤 POST /api/orders/{id}/submit에 최신 expectedVersion을 보낸다.

최종 확정에는 totalAmount와 각 parcels[].notifiedPrice가 필수다. 배송비는 1~2,147,483,647원 정수이며 합계도 이 범위 안이어야 한다. totalAmount는 미취소 상세의 합계와 정확히 일치해야 한다. itemPrice는 별도의 물품 가액이다. 누락·범위·합계 오류는 422로 거절하고 최종 확정·디버 전송을 하지 않는다.

- billing: 개인 카드. 개인·기업 고객 모두 사용하며 notPaid로 저장한다.
- credit: 월결제. 개인 고객은 본인 설정, 기업 구성원은 활성 소속·활성 기업의 설정을 검증한 뒤 PAID로 저장한다.
- groupBilling: 활성 기업 소속 부서의 그룹결제 설정을 확인한 뒤 PAID로 저장한다.
- 월결제·그룹결제가 모두 가능하면 AI가 선택해서 전달한다. 기본 결제 방식은 billing이다.

PAID 저장과 결제 완료 감사는 먼저 커밋한다. 그 다음 SUBMITTING 저장·감사 커밋 후 DB 트랜잭션 밖에서 디버를 호출한다. 성공 시 미취소 상세만 배송·초기 paid 이력을 생성한다. 실패는 SUBMISSION_FAILED로 저장하며 외부 오류 코드를 업무 응답에 추가하지 않는다. 자동 재전송은 하지 않는다.

결과에는 totalAmount, paymentDueAt, paymentRequest를 추가한다. paymentRequest는 현재 미완료·미만료 요청의 paymentRequestId(UUID), amount, expiresAt이며 결제 완료·취소 상태에는 null이다. 이 값은 결제 요청 식별자이며 실제 결제 URL은 아니다.

## 부분 취소

POST /api/orders/{id}/parcels/cancel의 orderParcelSeqs 배열로 단건·복수를 취소한다. 같은 주문·고객 범위를 확인하고 한 항목이라도 잘못되면 전체를 저장하지 않는다. 이미 취소된 항목만 재요청하면 204이며 금액·로그·결제 요청을 추가하지 않는다.

COLLECTING 또는 notPaid에서만 취소한다. 일부 취소하면 상세 가격은 그대로 보존하고 상위 totalAmount를 미취소 상세 합계로 바꾼다. notPaid이면 기존 요청을 invalidated로 닫고 새 UUID·남은 금액으로 요청을 생성한다. 만료 시각은 최초 결제 대기 시작 +24시간을 유지한다. 전체 취소는 상위·모든 상세를 CANCELLED, 합계를 0원으로 바꾸고 결제 요청을 닫는다.

주문 잠금 → 상세/결제 요청 순서로 직렬화한다. 결제 승인이 먼저 시작되면 취소는 409, 취소가 먼저 확정되면 이전 결제 요청의 승인 시작은 409다. 결제 완료 이후 취소·수정은 지원하지 않는다.

## 결제사 연동 보류 범위

OrderPaymentsService는 내부 함수만 제공한다. 결제 성공을 자가 신고하는 HTTP endpoint는 없다. 결제사·카카오톡 발송 설정·결제 URL·실제 승인/환불은 이번 변경에 포함하지 않는다.

추후 검증된 결제 연동은 다음 순서를 지켜야 한다.

1. beginPayment(paymentRequestId, amount)로 유효한 최신 요청·금액·기한을 확인하고 승인 작업을 선점한다.
2. 서버에서 결제사 승인을 호출하고 신뢰 가능한 결제 결과를 검증한다. 클라이언트 성공 화면만으로 확정하지 않는다.
3. 승인 성공이면 confirmPayment에 같은 요청·금액·검증된 거래 식별자와 requestId를 전달한다. 같은 거래의 재확인은 추가 결제·감사·디버 재접수를 만들지 않는다.
4. 결제사에서 명확히 승인 거절된 경우만 releaseDeclinedPayment로 선점을 해제한다. 응답을 잃은 경우 임의 해제하지 말고 결제사 조회로 먼저 확인해야 한다.

## 재접수와 감사

POST /api/admin/orders/{id}/retry는 접수 실패한 동일 주문의 미취소 상세를 다시 보낸다. 현재 SUBMITTING/ACCEPTED이면 전송 없이 상태만 반환한다. 결제 처리와 월별 집계를 다시 실행하지 않는다. 재접수 시작은 ADMIN, 디버 응답과 결제 결과 반영은 SYSTEM으로 기록한다. AI 요청으로 생성·취소한 업무는 AI, 관리자 페이지 요청은 ADMIN(화면: 운영자)이다.

018 적용 전 기존 SUBMITTING/ACCEPTED/AUTH_FAILED/REVIEW_REQUIRED/EXPIRED 주문이 있으면 결제 여부를 추정하지 않고 이관을 중단한다. 이번 작업 전 업무 DB는 관리자만 남겨 초기화했으며, 이후 기존 서버에서 새 주문이 들어왔다면 배포 전에 별도 정합성 확인이 필요하다.
