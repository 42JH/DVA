# 주문 결제와 접수

Jira: [S15P31D109-138](https://ssafy.atlassian.net/browse/S15P31D109-138).

021부터 기업·부서 삭제 후에도 주문·청구 원장·월별 합계와 당시 기업/부서 번호·이름을 보존한다. 주문 상세에 billingOrganizationSeq·billingOrganizationName·billingDepartmentSeq·billingDepartmentName, 월별 사용액에 organizationName을 추가한다. 삭제된 기업의 기록된 청구 월도 기존 billing API로 조회할 수 있다. [삭제·진행 중 주문·배포 계약](company-deletion.md)을 따른다.

## 상태

| status | 표시 | 다음 처리 |
| --- | --- | --- |
| COLLECTING | 미완료 상담 | 보완 후 최종 확정 또는 취소 |
| notPaid | 결제 대기 | 개인 카드 결제 완료 또는 전체/부분 취소·만료 |
| PAID | 결제 완료 | 디버 전송 시작 |
| SUBMITTING | 디버 접수중 | 디버 200 성공 / 400 실패 결과 반영 |
| ACCEPTED | 디버 접수 완료 | 관리자 내부 내용 보정 가능. 외부 변경·환불은 별도 |
| SUBMISSION_FAILED | 디버 접수 실패 | 관리자 재접수 |
| CANCELLED | 취소됨 | 주문·상세·통화·녹취·감사 보존 |

결제·디버 진행은 orders.status 하나로 관리한다. 상세의 기존 ACTIVE/CANCELLED는 부분 취소 여부만 나타낸다. 별도의 상위 주문 부분 취소 상태는 추가하지 않는다. AI는 결제 대기부터 내용을 수정할 수 없다. 관리자는 [수정 API](order-update.md)로 모든 상태의 내부 내용을 보정하며 총액을 재계산한다. 상태·접수·원결제 기록은 유지한다.

## 생성과 최종 확정

AI는 기존 POST /api/orders의 outcome=COMPLETE, 관리자 수기는 POST /api/admin/orders를 사용한다. 기존 미완료 주문은 PATCH /api/orders/{id}로 보완한 뒤 POST /api/orders/{id}/submit에 최신 expectedVersion을 보낸다.

최종 확정에는 totalAmount와 각 parcels[].notifiedPrice가 필수다. 배송비는 1~2,147,483,647원 정수이며 합계도 이 범위 안이어야 한다. totalAmount는 미취소 상세의 합계와 정확히 일치해야 한다. itemPrice는 별도의 물품 가액으로 1~100,000,000원 정수만 허용한다. AI·수기 생성과 수정에서 범위 밖 값은 400으로 거절한다. 미수집 값의 생략·null은 유지하되, 최종 확정·디버 전송에는 필수이며 저장된 범위 밖 가액은 422 VALIDATION_FAILED(details의 parcels.N.itemPrice / priceRange)로 거절한다. 과거 저장값을 자동 변경하거나 조회에서 숨기지 않는다. JSON 형식·입력 범위 오류는 400, 저장된 배송비 누락·합계 오류는 422로 거절하고 최종 확정·디버 전송을 하지 않는다.

기존 결제 대기 주문도 최초 카드 승인 전에 같은 가액을 검증하며, 오류 시 외부 결제사 호출과 승인 키 예약을 하지 않는다. 결제 대기 상태의 확정 상세는 기존처럼 수정할 수 없으므로 범위 밖 과거 가액은 미결제 주문을 취소한 뒤 정상 가액으로 다시 접수한다. 승인 절차가 이미 시작됐거나 완료된 결제는 새 입력 검증으로 결과 확인·복구를 중단하지 않으며 기존 승인 이력을 보존한다.

- billing: 개인 카드. 개인·기업 고객 모두 사용하며 notPaid로 저장한다.
- credit: 월결제. 개인 고객은 본인 설정, 기업 구성원은 활성 소속·활성 기업의 설정을 검증한 뒤 PAID로 저장한다.
- groupBilling: 활성 기업 소속 부서의 그룹결제 설정을 확인한 뒤 PAID로 저장한다.
- 월결제·그룹결제가 모두 가능하면 AI가 선택해서 전달한다. 기본 결제 방식은 billing이다.

PAID 저장과 결제 완료 감사는 먼저 커밋한다. 그 다음 SUBMITTING 저장·감사 커밋 후 DB 트랜잭션 밖에서 디버를 호출한다. 성공 시 미취소 상세만 배송·초기 paid 이력을 생성한다. 실패는 SUBMISSION_FAILED로 저장하며 외부 오류 코드를 업무 응답에 추가하지 않는다. 자동 재전송은 하지 않는다.

결과에는 totalAmount, paymentDueAt, paymentRequest를 추가한다. paymentRequest는 현재 미완료·미만료 요청의 paymentRequestId(UUID), amount, expiresAt, notificationStatus이며 결제 완료·취소 상태에는 null이다. 설정된 정식 결제 페이지 `/api/payments/p/{paymentRequestId}`로 연결한다. 안내 발송·토스 승인은 [주문 결제 연동](order-payment-integration.md)을 따른다.

## 부분 취소

POST /api/orders/{id}/parcels/cancel의 orderParcelSeqs 배열로 단건·복수를 취소한다. 같은 주문·고객 범위를 확인하고 한 항목이라도 잘못되면 전체를 저장하지 않는다. 이미 취소된 항목만 재요청하면 204이며 금액·로그·결제 요청을 추가하지 않는다.

COLLECTING 또는 notPaid에서만 취소한다. 일부 취소하면 상세 가격은 그대로 보존하고 상위 totalAmount를 미취소 상세 합계로 바꾼다. notPaid이면 기존 요청을 invalidated로 닫고 새 UUID·남은 금액으로 요청을 생성한다. 만료 시각은 최초 결제 대기 시작 +24시간을 유지한다. 전체 취소는 상위·모든 상세를 CANCELLED, 합계를 0원으로 바꾸고 결제 요청을 닫는다.

주문 잠금 → 상세/결제 요청 순서로 직렬화한다. 결제 승인이 먼저 시작되면 취소는 409, 취소가 먼저 확정되면 이전 결제 요청의 승인 시작은 409다. 이 취소 API는 결제 완료 이후를 지원하지 않는다. 관리자 내부 수정은 별도 PATCH 규칙을 따르며 실제 환불·추가 결제는 포함하지 않는다.

## 결제사 연동

정식 토스 테스트 연동은 [140번 계약](order-payment-integration.md)으로 제공한다. OrderPaymentsService는 검증된 승인 결과를 반영하는 내부 함수이며 클라이언트의 결제 성공 자가 신고를 신뢰하지 않는다. 결제 안내는 현재 Mattermost를 사용하고 카카오 알림톡·환불은 후속 범위다. 수거 시각은 결제 완료 시각 + 1시간으로 확정한다.

결제 연동은 DB 처리권과 승인 전에 저장된 결제 키를 사용한다. 아래 내부 함수는 기존 도메인 경계를 설명하며 실제 호출 순서와 복구 계약은 140번 문서를 따른다.

1. claimApproval(paymentRequestId, amount, paymentKey)로 유효한 최신 요청·금액·기한을 확인하고 결제 키와 처리권을 저장한다.
2. 서버에서 결제사 승인을 호출하고 신뢰 가능한 결제 결과를 검증한다. 클라이언트 성공 화면만으로 확정하지 않는다.
3. 승인 성공이면 confirmPayment에 같은 요청·금액·검증된 거래 식별자와 requestId를 전달한다. 같은 거래의 재확인은 추가 결제·감사·디버 재접수를 만들지 않는다.
4. 결제사에서 명확히 승인 거절된 경우만 releaseClaim(paymentRequestId, claimId, true)로 결제 키·승인 시작을 초기화한다. 응답을 잃으면 releaseClaim의 기본값으로 처리권만 해제하고 결제 키를 보존하여 결제사 조회로 먼저 확인한다.

## 재접수와 감사

POST /api/admin/orders/{id}/retry는 접수 실패한 동일 주문의 미취소 상세를 다시 보낸다. 현재 SUBMITTING/ACCEPTED이면 전송 없이 상태만 반환한다. 결제 처리와 월별 집계를 다시 실행하지 않는다. 재접수 시작은 ADMIN, 디버 응답과 결제 결과 반영은 SYSTEM으로 기록한다. AI 요청으로 생성·취소한 업무는 AI, 관리자 페이지 요청은 ADMIN(화면: 운영자)이다.

018 적용 전 기존 SUBMITTING/ACCEPTED/AUTH_FAILED/REVIEW_REQUIRED/EXPIRED 주문이 있으면 결제 여부를 추정하지 않고 이관을 중단한다. 이번 작업 전 업무 DB는 관리자만 남겨 초기화했으며, 이후 기존 서버에서 새 주문이 들어왔다면 배포 전에 별도 정합성 확인이 필요하다.

## 자동 만료와 월별 사용액

백엔드 시작 시 및 매 분 경계에 maintenance 작업을 실행한다. 중복 실행을 막고 여러 인스턴스 사이에는 DB 잠금·유일성 제약으로 직렬화한다. 테스트 환경에서는 타이머 대신 동일 작업 함수를 직접 호출한다.

미결제 기한이 지난 notPaid 주문은 CANCELLED로 바꾸고 모든 상세·통화·녹취·감사를 보존한다. 합계는 0원, 결제 요청은 무효화되며 ORDER_CANCELLED를 SYSTEM과 reason=PAYMENT_EXPIRED로 기록한다. 이미 승인 선점된 요청은 임의로 취소하지 않는다. 추후 결제사 연동에서 승인 결과를 확인한 뒤 완료하거나 명확한 거절을 해제해야 한다. 작업은 한 번에 최대 100건을 처리하고 나머지는 다음 실행에서 처리한다.

결제 완료 후 디버 전송을 시작하기 전에 프로세스가 종료되어 PAID로 남은 주문은 유지보수 작업이 전송을 이어간다. SUBMISSION_FAILED는 자동 재전송하지 않으며 관리자 재접수를 사용한다.

기업 월결제·그룹결제는 결제 완료 트랜잭션 안에서 주문당 원장 한 건을 기록하고 해당 KST 월의 사용액을 증가시킨다. 디버 응답 전에도 집계하며 접수 실패·재접수로 사용액을 다시 늘리지 않는다. 개인 카드 및 소속 없는 개인 월결제는 기업 사용액에 넣지 않는다.

GET /api/companies/{id}/billing?month=YYYY-MM으로 monthlyAmount·groupBillingAmount를 조회한다. 월 생략 시 현재 KST 월이며, 집계 행이 아직 없으면 두 금액을 0으로 반환한다. 조회는 원장을 변경하지 않는다. 금액은 JavaScript 안전 정수 범위의 원 단위 숫자다.

`GET /api/customers/{id}/billing?month=YYYY-MM`은 ACTIVE 관리자 세션으로 조회한다. 응답의
`data`는 `{ customerSeq, month, monthlyAmount }`이며 공통 `meta`를 포함한다. 월 생략 시 KST 이번 달이고,
잘못된 월은 400, 없거나 삭제된 고객은 404, 해당 월 사용액이 없으면 0원이다.

개인 `credit`은 결제 확정 트랜잭션에서 주문당 원장 한 건을 기록한다. 결제 확정 시점의 고객과 금액을 보존하며
기업 소속 변경이나 주문 금액 보정 이후에도 원래 개인 청구를 조회한다. 집계 월은 `paid_at`의 KST 월이다.
결제 전 취소는 청구가 없고, 결제 이후 디버 접수 실패는 사용액에 포함된다.
기업 월결제·그룹결제는 기업 API에서 조회한다.

062 migration 적용이 필요하다. 2026-11-11 운영 DB 읽기 전용 확인 당시 결제 확정된 개인 월결제 주문은 0건이었다.
최초 금액은 보존 중인 `ORDER_PAYMENT_COMPLETED` 감사 기록에서 확인할 수 있으며 감사 보존 기간은 7일이다.
이번 migration은 기존 주문의 현재 총액을 청구 원금으로 이관하지 않는다.

새 월은 별도의 0원 행으로 시작한다. 이전 월을 덮어쓰지 않고, 재시작 시 누락된 월도 순서대로 생성한다. BILLING_MONTH_INITIALIZED는 각 결제 방식의 이전 월 금액→0원, BILLING_AMOUNT_INCREASED는 증가 전후 금액을 SYSTEM으로 기록한다. 원장·사용액·감사는 함께 커밋하거나 롤백한다.

관리자 통화 조회에는 orderStatus와 orderTotalAmount를 반환한다. GET /api/calls의 orderStatus 필터로 상담에 연결된 결제 대기·접수·취소 주문을 검색할 수 있으며 통화 종료 사유는 그대로 보존한다.

감사 조회는 actorType=AI/SYSTEM/ADMIN 필터와 actorLabel=AI/SYSTEM/운영자를 제공한다. 운영자의 실제 이름과 번호는 actorName·actorSeq로 유지한다.
