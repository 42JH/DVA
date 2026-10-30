# 실제 주문의 토스 테스트 결제·안내 발송·디버 접수

관련 이슈: [S15P31D109-140](https://ssafy.atlassian.net/browse/S15P31D109-140).
이 문서의 흐름은 정식 Nest 백엔드·PostgreSQL의 실제 주문을 사용한다. `/payment-test/`의 독립 샘플 서비스와 데이터가 섞이지 않는다.

## 확정 정책

- 개인 카드 `billing`: 주문 확정 → `notPaid` 및 결제 요청 저장 → Mattermost 안내 자동 발송 → 토스 테스트 승인 확인 → DB 결제 완료 → 디버 POST.
- 월결제 `credit`·부서 그룹결제 `groupBilling`: 기존 자격 검증 후 바로 결제 완료·디버 접수. 토스 링크나 결제 메시지를 생성하지 않는다.
- 디버가 제공한 API는 목 접수 API이며 이번 흐름에서는 실제 접수 단계처럼 취급한다.
- 수거 시각은 **결제 완료 시각 + 1시간**이다. 카드에서는 토스의 검증된 `approvedAt`, 월·그룹에서는 DB 결제 처리 시각을 기준으로 한다. 디버 재접수 때 다시 계산하지 않는다.
- 결제 전에는 `pickupRequestedAt`가 null이며 안내 문구는 `결제 완료 후 1시간 뒤`다. AI·FE가 수거 시각을 계산하거나 필수로 전달할 필요가 없다. 기존 요청의 형식이 올바른 수거 시각은 호환상 수신하지만 결제 시 서버가 최종 결정한다.

## 기존 주문 API와 연결

AI `POST /api/orders`의 `outcome=COMPLETE`, 관리자 `POST /api/admin/orders`, 미완료 주문의 `POST /api/orders/{id}/submit`을 그대로 사용한다. 추가적인 ‘메시지 발송 API’ 호출은 필요 없다.

`billing` 주문이 커밋되면 같은 트랜잭션에서 생성된 `order_payment_requests` 행의 `notificationStatus=PENDING`을 워커가 최대 5초 간격으로 확인한다. 통화가 끝나거나 앱이 재기동되어도 전송 대기가 남는다. 같은 주문 생성 요청의 재전송은 결제 요청이나 메시지를 새로 만들지 않는다.

주문 응답의 `paymentRequest`는 `paymentRequestId`, `amount`, `expiresAt`, `notificationStatus`를 제공한다. UUID는 무작위 결제 링크 식별자이자 토스 `orderId`로 사용한다. 메시지의 표시 주문번호는 실제 `orderSeq`다. 금액은 DB에 저장된 미취소 배송비의 합계이며 1,000원으로 고정하지 않는다.

부분 취소는 기존 요청을 무효화하고 남은 금액의 새 요청·새 메시지 대기를 생성한다. 최초 24시간 기한을 연장하지 않으며, 이전 링크로 결제를 시작할 수 없다. 전체 취소·만료도 결제를 차단한다. 승인 진행 중에는 취소를 차단한다.

## 고객 결제 경로

기본 URL 예시는 `https://13.209.59.180/api/payments`다. 모두 기존 `/api/` 프록시로 정식 백엔드에 전달되므로 `/payment-test/`용 Nginx 경로를 재사용하지 않는다.

| 메서드·경로 | 용도 |
| --- | --- |
| `GET /api/payments/p/{id}` | 고객 결제 페이지 HTML |
| `GET /api/payments/success/{id}` | 토스 인증 후 돌아오는 페이지. GET 자체는 주문을 변경하지 않음 |
| `GET /api/payments/fail/{id}` | 사용자 중단·인증 실패 페이지 |
| `GET /api/payments/requests/{id}` | 결제·디버 상태 조회 |
| `POST /api/payments/requests/{id}/confirm` | 서버의 토스 승인 확인·DB 반영·디버 접수 |
| `POST /api/payments/requests/{id}/reconcile` | 저장된 결제 키로 결과 조회만 수행 |
| `POST /api/payments/notifications/{id}/retry` | 관리자 로그인·허용 Origin 필수. 같은 유효 링크의 안내 재발송 대기 |

`id`는 `paymentRequestId`(UUID v4)다. 고객 경로는 링크 소유자가 관리자 로그인·통화 번호 없이 사용한다. 토스 승인·재조회 POST에는 `PAYMENT_PUBLIC_URL`과 정확히 같은 Origin이 필요하다. 결제 페이지 자체가 이 요청을 보내며 FE나 AI가 결제 완료 여부를 자가 신고하지 않는다. 관리자 재발송 경로에는 익명·AI 접근 예외를 적용하지 않는다.

승인 요청:

```json
{
  "orderId": "12345678-1234-4123-8123-123456789abc",
  "amount": 3500,
  "paymentKey": "토스 SDK가 전달한 불투명한 결제 키"
}
```

`orderId`는 경로의 요청 ID와 같아야 하며 금액은 DB 요청·주문의 현재 합계와 일치해야 한다. `reconcile`·관리자 재발송 본문은 `{}`다. 추가 필드는 거절한다.

JSON 성공 응답은 기존 `{data,meta:{requestId}}` 형식이다. `data`에는 `token`, `orderId`, `orderSeq`, `orderName`, `amount`, `senderName`, `recipientSummary`, `parcelCount`, `expiresAt`, `approvedAt`, `pickupRequestedAt`, `status`, `orderStatus`, `notificationStatus`가 있다. `token`은 경로의 무작위 요청 ID와 같은 값이며 별도 서비스 인증 토큰이 아니다. 시크릿·웹훅·토스 결제 키·전체 결제 응답은 반환하지 않는다.

결제 `status`는 `PENDING`, `REVIEW_REQUIRED`, `PAID`, `EXPIRED`, `CANCELLED`다. `orderStatus`는 기존 주문 상태이며 결제 완료와 디버 접수 완료를 구분한다. 결제 결과가 `PAID`여도 디버 상태는 `SUBMITTING`·`SUBMISSION_FAILED`일 수 있다. 프론트는 접수 성공을 `ACCEPTED`에서만 표시한다.

대표 오류: 400 입력 오류, 401 관리자 인증 없음, 403 Origin·관리자 권한 오류, 404 없는 요청, 409 금액·상태·진행 중 충돌, 422 명확한 승인 거절, 502 `PAYMENT_RESULT_UNKNOWN`, 503 연동 비활성. HTML·정적 파일은 Swagger에서 제외하고 JSON 계약은 Payments 태그에 제공한다.

## 승인과 장애 복구

1. 주문 행 → 결제 요청 행 순서로 잠그고 현재 금액·기한·취소 상태를 검증한다.
2. **토스 호출 전에** 결제 키와 승인 시작·45초 처리권을 DB에 기록한다. 외부 통신 중 DB 트랜잭션을 유지하지 않는다.
3. 최초 요청만 토스 승인 POST를 수행한다. 같은 프로세스의 중복 호출은 합치고, 다른 인스턴스는 DB 처리권으로 중복 승인을 막는다. 승인 요청의 `Idempotency-Key`는 저장된 결제 요청 UUID다.
4. `DONE`, 주문번호·결제 키·금액·KRW·승인 시각을 검증한 뒤 기존 `OrderPaymentsService.confirmPayment`로 결제와 감사·수거 시각을 먼저 커밋한다.
5. 기존 `submitPaidOrder`로 디버에 전송한다. 디버 실패는 결제를 되돌리거나 재결제를 요구하지 않으며, 기존 관리자 재접수를 사용한다.
6. 응답 유실·5xx·잘못된 응답은 진행 표시를 유지한다. 고객의 결과 확인 또는 워커가 토스 GET 조회로 확인하며 재승인하지 않는다. 처리권을 가진 프로세스가 종료되면 45초 뒤 다른 인스턴스가 조회로 복구한다.
7. 토스 승인 후 DB 저장에 실패해도 저장된 결제 키로 복구한다. 결제 DB 커밋 후 디버 전송 전에 중단된 `PAID` 주문은 기존 유지보수 작업이 이어간다.

명확한 `REJECT_CARD_PAYMENT` 또는 조회로 확인한 `ABORTED`·`EXPIRED`만 승인 선점을 해제한다. 결과가 계속 불명확하거나 조회에서 찾지 못한 경우에는 자동으로 취소·재승인하지 않고 운영자가 확인한다. 결제 완료 후 취소·환불은 이번 범위에 포함하지 않는다. 장시간 장애 후 확인된 결제의 수거 시각이 이미 지난 경우에도 재접수 시각을 임의로 새로 계산하지 않는다.

## 메시지 발송과 복구

최종 합의한 친근한 인삿말·감사 인사와 실제 주문번호·수령인·건수·금액·결제 링크를 보낸다. 메시지에는 이모지·테스트 안내를 넣지 않고, 결제 화면에는 테스트 표시를 유지한다. 수거 시각은 결제 전이므로 상대 문구로 안내한다.

DB에서 `PENDING`을 한 워커만 `SENDING`으로 바꾼 뒤 발송한다. Mattermost HTTP 200 + `ok`일 때 `SENT`, 명확한 4xx는 `FAILED`, 응답 유실은 `UNKNOWN`이다. 재기동 후 오래된 `SENDING`도 `UNKNOWN`으로 두며 자동으로 다시 보내지 않는다. 수신 여부를 확인한 관리자가 재발송 API를 사용할 수 있고, 같은 링크를 사용하므로 주문·결제 요청은 새로 만들지 않는다. 재발송 요청과 감사는 같은 트랜잭션이다. `UNKNOWN` 재발송에는 중복 메시지 가능성이 있다.

발송 실패가 주문을 삭제하거나 롤백하지 않는다. 결제 진행·완료·취소·만료 요청은 재발송 대기로 바꿀 수 없다. 메시지 전송과 취소가 동시에 일어나 이미 발송 중인 안내가 도착할 수 있지만 해당 링크의 결제는 서버에서 차단한다.

## 배포

022 마이그레이션은 기존 `order_payment_requests`에 결제 식별자·승인 시각·처리권과 발송 상태 컬럼·인덱스를 추가한다. 새 업무 테이블이나 기능별 등록 요청 키 테이블은 만들지 않는다. 기존 마이그레이션은 수정하지 않는다.

정식 BE의 서버 전용 환경 설정에 아래 항목을 넣는다. 실제 값을 Git·채팅·공유 로그에 출력하지 않는다.

```dotenv
ORDER_PAYMENTS_ENABLED=true
PAYMENT_PUBLIC_URL=https://13.209.59.180/api/payments
TOSS_TEST_CLIENT_KEY=<기존 문서용 test_gck 키>
TOSS_TEST_SECRET_KEY=<짝이 맞는 기존 문서용 test_gsk 키>
PAYMENT_MATTERMOST_WEBHOOK_URL=<기존 결제 전용 웹훅>
```

`CORS_ORIGINS`에 `https://13.209.59.180`을 포함한다. 토스 주소는 운영 설정에서 변경할 수 없고 라이브 키도 거절한다. 모형 주소는 `NODE_ENV=test`의 loopback에서만 허용한다. 현재 `/srv/dva-payment-test/settings`에 있는 키·웹훅은 배포 때 서버 내부에서 정식 BE 환경 설정으로 이관해야 한다. 이번 코드 작업에서 서버 설정을 변경하거나 메시지·디버 요청을 발송하지 않는다.

기본 활성화는 false이며 비활성 상태에서도 주문·결제 요청을 보존한다. 활성화하면 아직 유효한 기존 `PENDING` 요청도 발송 대상으로 처리한다. 기존 3002 포트의 샘플 서비스는 실제 주문과 무관하며, 새 흐름 확인 후 운영자가 중지할 수 있다. 기존 샘플 JSON 파일을 업무 주문으로 이관하지 않는다. 카카오 알림톡은 후속 발송 채널 연동 범위다.

## 검증과 범위

실제 임시 PostgreSQL과 Nest HTTP를 사용해 AI·관리자 주문, 자동 안내, 월·그룹결제 분기, 부분 취소, 승인 중복, 서로 다른 앱의 경합, 응답 유실·재기동·DB 실패 복구, 디버 실패·재접수, 관리자 재발송을 검증한다. Postman 시뮬레이션은 토스·Mattermost·디버 세 의존성을 제공하며 실제 결제를 발생시키지 않는다. Chrome 검증도 토스 SDK를 모형으로 대체하므로 실제 테스트 카드 인증·승인 증거는 아니다.

```bash
postman simulation run postman/simulations/payment-test/payment-test.sim.yaml --port 4598 --output ndjson --no-history
# 다른 터미널: 격리된 dva_webhook_test DB의 NODE_ENV=test·DB_* 설정 후
cd backend
npm run build
node scripts/verify-order-payment-simulation.cjs
```

설치된 Playwright·Chrome을 사용하려면 `PAYMENT_TEST_PLAYWRIGHT_MODULE`, `PAYMENT_TEST_CHROME_PATH`를 지정한다. 고객 페이지의 결제·콜백·접수 결과·새로고침·모바일 폭을 추가 검증한다. 실제 서버의 메시지 수신·토스 테스트 인증·디버 목 접수는 MR 반영·설정 활성화 후 확인한다.

외부 계약: [토스 V2 연동](https://docs.tosspayments.com/guides/v2/payment-widget/integration), [토스 승인·조회](https://docs.tosspayments.com/reference).
