# 택배 테스트 결제 HTTP 계약

이 서비스는 기존 Nest `/api` 및 Swagger와 별도다. 운영자 생성·발송은 서버 내부에서만 호출한다. 운영 시 공개 origin은 `PAYMENT_TEST_PUBLIC_URL`의 origin이며 모든 응답은 `Cache-Control: no-store`, `Referrer-Policy: no-referrer`를 사용한다. JSON 요청 최대 8KiB. 별도 CORS 허용 없음.

| 메서드·경로 | 입력·접근 | 성공 |
| --- | --- | --- |
| `GET /health` | 호스트 내부 상태 확인 | 200 `{ "status": "ok" }` |
| `POST /internal/payment-test/requests` | `Authorization: Bearer <operator token>`, JSON `{}` | 201 샘플 DTO + `token`, `paymentUrl` |
| `POST /internal/payment-test/requests/{token}/notify` | 같은 운영자 인증, JSON `{}` | 200 `{ "notificationStatus": "SENT" }` 또는 `FAILED`/`UNKNOWN` |
| `GET /payment-test/p/{token}` | 링크 소유자 | 200 HTML 결제 페이지 |
| `GET /payment-test/success/{token}` | SDK 인증 성공 리다이렉트. `orderId`, `amount`, `paymentKey` 쿼리 | 200 HTML. GET 자체는 승인하지 않으며 화면 JS가 아래 confirm 호출 |
| `GET /payment-test/fail/{token}` | SDK 실패·사용자 중단 리다이렉트 | 200 HTML. 상태 변경 없음, 외부 오류 원문 표시 없음 |
| `GET /payment-test/api/requests/{token}` | 링크 소유자 | 200 공개 DTO |
| `POST /payment-test/api/requests/{token}/confirm` | 정확한 `Origin`, JSON `{ "orderId": "DVA_TEST_<uuid>", "amount": 1000, "paymentKey": "<SDK result>" }` | 200 검증 완료된 공개 DTO (`PAID`) |
| `POST /payment-test/api/requests/{token}/reconcile` | 정확한 `Origin`, JSON `{}` | 200 조회로 확인된 공개 DTO. 저장된 결제 키만 사용 |

`token`은 64자리 소문자 hex. 공개 DTO는 `orderId`, `orderName`, `senderName`, `recipientSummary`, `parcelCount`, `pickupRequestedAt`, `amount`, `status`, `approvedAt`, `expiresAt`, `notificationStatus`만 포함한다. 시각은 ISO 8601 UTC, 화면·메시지의 수거일시는 한국 시간으로 표시한다. 결제 키·서버 시크릿·운영자 토큰은 공개 DTO에 포함하지 않는다.

샘플은 서버에서 가상 정보·1,000원으로 생성한다. 호출자가 금액·수령인·URL을 지정할 수 없다. 토스 승인에 전달할 주문번호·금액은 반드시 저장한 값과 비교한다. 같은 요청에 대한 승인 호출은 진행 중 한 번으로 합치고, 완료 후에는 저장된 결과를 반환한다. 다른 결제 키로 바꾸는 요청은 거절한다.

오류는 `{ "error": { "code": "PAYMENT_RESULT_UNKNOWN" } }` 형태다. 대표 상태는 다음과 같다.

| HTTP | 코드 예시·처리 |
| --- | --- |
| 400 | `INVALID_REQUEST`, `PAYMENT_DETAILS_MISMATCH`, `EMPTY_BODY_REQUIRED`: 입력 수정 |
| 401 / 403 | `UNAUTHORIZED` / `ORIGIN_REQUIRED`: 운영자 인증·페이지 origin 확인 |
| 404 | `NOT_FOUND`: 알 수 없는 경로·링크 |
| 409 | `PAYMENT_KEY_MISMATCH`, `CONFIRMATION_IN_PROGRESS`, `MESSAGE_ALREADY_ATTEMPTED`, `INVALID_STATE`, `DEMO_CAPACITY_REACHED`: 상태 확인 |
| 410 | `PAYMENT_EXPIRED`: 새 샘플 필요 |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `JSON_REQUIRED` |
| 422 | `PAYMENT_FAILED`: 명확한 카드 승인 거절 |
| 502 | `PAYMENT_RESULT_UNKNOWN`: 결과 재조회. 재승인 금지 |
| 500 | `INTERNAL_ERROR`: 저장 장치 등 운영 상태 확인. 오류 세부·키 미노출 |

내부 상태: `PENDING` → `CONFIRMING` → `PAID` 또는 `FAILED`/`REVIEW_REQUIRED`. 새 승인 전 파일에 진행 상태와 결제 키를 기록한다. 타임아웃·5xx·잘못된 성공 응답·결과 불명확은 `REVIEW_REQUIRED`로 남긴다. `ALREADY_PROCESSED_PAYMENT` 응답은 조회로 확인한다. `REJECT_CARD_PAYMENT` 이외의 4xx도 결과 확인 대상으로 보수적으로 처리한다. `REVIEW_REQUIRED`와 재기동한 `CONFIRMING`은 GET 조회만 수행하며 `DONE`, 주문번호, 결제 키, 금액, `KRW`, 승인 시각이 모두 맞아야 `PAID`가 된다.

토스: `POST https://api.tosspayments.com/v1/payments/confirm`에 `paymentKey`, `orderId`, `amount`; `GET /v1/payments/{paymentKey}`로 조회한다. 인증은 `Basic base64(secretKey + ':')`. 승인 요청에는 저장된 UUID `Idempotency-Key`를 사용한다. Mattermost: 전용 `/hooks/...` URL로 `{ "text": "<formatted message>" }`를 POST하고 HTTP 200 + 본문 `ok`일 때만 `SENT`로 기록한다. 알 수 없는 전송 결과를 자동으로 재발송하지 않는다.

이 계약의 모형은 `postman/mocks/`에 있으며 소비하는 필드만 제공한다. 전체 PG·카드사 규칙과 실제 결제위젯은 재현하지 않는다.
