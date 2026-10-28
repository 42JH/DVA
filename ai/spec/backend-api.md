# 백엔드 서버 API (AI 서버가 쓰는 것)

고객·주문·배송지는 AI 서버가 저장하지 않는다. 별개의 **백엔드 서버**가 관리하고, AI 서버는 API로 읽고 쓴다.
계약의 원문은 백엔드 문서다: `spec/orders.md`(주문 API), `spec/ai-pbx-recordings.md`(AI·PBX 연동). 백엔드 저장소 `develop-backend`의 `docs/api/`·`backend/src/orders/`에서 옮겨 왔다. 이 문서에는 AI 서버가 그 계약을 어떻게 쓰는지만 적는다. 계약이 바뀌면 원문을 다시 받아 오고 이 문서와 `app/backend_api.py`를 같이 고친다.

- 구현: `app/backend_api.py`(클라이언트·본문 만들기), 테스트 `tests/test_backend_api.py`(가짜 HTTP)
- 가짜 백엔드: `app/mock_backend.py`의 `MockBackend`. 테스트와 `[backend] mock = true` 배포에서 쓴다. 통화당 주문 한 건, 같은 키는 기존 결과, COMPLETE 필수값 같은 주요 검증만 흉내 낸다.
- 주소: 환경변수 `BACKEND_API_URL`(같은 Docker 네트워크에서 `http://backend:3000`). 설정: `config/server.toml` `[backend]`
- HTTP: `openai`에 딸린 `httpx2`(의존성 추가 없음)
- 인증: MVP 합의로 아래 두 호출은 인증이 없다(백엔드 Jira S15P31D109-135에서 추가 예정).

## 공통

- JSON, UTF-8. 전화번호는 URL에 넣지 않고 본문으로 보낸다. 숫자만 쓰고 `+82`는 `0`으로 바꾼다.
- 성공 응답은 `{data, meta: {requestId}}`, 오류는 `{error: {code, message, details}, meta}`.

## 1. 고객 확인 — `POST /api/customers/context`

통화 시작(accept 전)에 한 번. 요청 `{"phoneNumber": "01012345678"}`. 고객·통화를 만들지 않는다. 시간 제한 `[backend] timeout_sec`.

| `data.lookupStatus` | AI 처리 |
|---|---|
| `REGISTERED` | 등록 고객. `customer.customerSeq`·`name`을 쓰고, 주소록 `personalPins`·`companyPins`의 `addressData`를 출발지·도착지 후보로 쓴다. 9개 항목(좌표 포함)이 다 있으면 다시 찾지 않는다. `availableUsageTypes`(PERSONAL·COMPANY)로 결제 방식 선택지를 거른다 |
| `UNREGISTERED` | 신규 고객 |
| `WITHDRAWN` | 신규로 다루지 않는다. 바로 상담원 연결 |

실패(시간 초과·5xx)면 신규 고객으로 진행한다.

## 2. 통화 결과 — `POST /api/orders`

**통화 하나에 한 번.** 백엔드는 통화 한 건에 주문 한 건만 받는다(같은 통화에 다른 키 → 409). 그 통화에서 고객이 확인한 택배들은 `parcels`에 묶는다. 언제 무엇을 보내는지는 `spec/scenario.md` "통화 결과"에 있다.

- 헤더 `Idempotency-Key`: 통화마다 UUID 하나(`Call.result_key`). 재시도·재확인에도 같은 키와 **처음 만든 본문 그대로**(`Call.result_body`) 보낸다. 같은 키는 백엔드가 본문을 다시 적용하지 않고 기존 결과를 돌려준다.
- `call`: `providerCallId` = OpenAI `session_id`, `callerPhoneNumber` = SIP 발신번호(숫자), `incomingAt` = 수신 웹훅 이벤트 `created_at`을 ISO 8601(UTC, `Z`)로 바꾼 값. 서버 시각을 쓰지 않는다(백엔드가 이 시각으로 PBX 녹취와 통화를 잇는다). 발신번호나 수신 시각을 모르면 결과를 보내지 않는다.
- 고객: 등록이면 `customerSeq`, 미등록이면 `customer: {name, phoneNumber: 발신번호}`. 이름은 보내는 분 번호가 발신번호면 보내는 분 성함, 아니면 따로 묻는다. 미완료·취소는 모르면 생략한다.
- `paymentMethodType`(`credit` 정산 · `groupBilling` 기업 그룹카드 · `billing` 개인카드), `pickupRequestedAt`(시간대 포함, 미래).
- `parcels[]`: `origin`·`destination`(이름·전화번호·도로명·지번·상세·동명·우편번호·위경도), `documentCount`·`smallBoxCount`·`mediumBoxCount`·`bigBoxCount`, `otherItemDescription`, `clientComment`, `itemPrice`. **모르는 값은 넣지 않는다**(임의 기본값 금지). 안내 요금(`notifiedPrice`)은 백엔드가 정한다.
- COMPLETE 필수: 고객, 결제 방식, 미래 수거 시각, 택배 한 건 이상, 택배마다 주소 9개 항목(상세 주소만 선택), 수량 하나 이상 또는 기타 물품 설명, 물품 가액. 지번·좌표 등을 못 찾은 택배가 있으면 AI가 COMPLETE 대신 INCOMPLETE로 보낸다(`Call.complete_ready`).

### 응답과 재시도(`BackendAPI.submit_result`)

| 응답 | AI 처리 |
|---|---|
| 201, `data.status` = `ACCEPTED` | 접수 성공. `parcelNo`(디버 참고번호)를 안내 |
| 201, `COLLECTING` · `CANCELLED` | 미완료·취소 저장 완료 |
| 201, `AUTH_FAILED` · `REVIEW_REQUIRED` | 성공 안내 금지("확인 후 연락"). 새 키로 다시 접수하지 않는다 |
| 연결 실패 · 504 · 202(`SUBMITTING`) · 409 `REQUEST_IN_PROGRESS` | 같은 키·같은 본문으로 `retry_interval_sec`마다 다시 확인, 총 `submit_retry_sec`까지. 끝까지 처리 중이면 마지막 상태(SUBMITTING)를 돌려준다 |
| 그 밖(400·403·404·409·422·503 등) | 다시 보내지 않고 실패(`BackendError`). 성공 안내 금지 |

- 요청 하나의 시간 제한은 `submit_timeout_sec`(백엔드가 디버를 최대 10초 기다리므로 그보다 길게).
- "더 없어요"에서 COMPLETE를 보낸 통화는 끊겨도 INCOMPLETE·CANCELLED를 따로 보내지 않는다. 처리 중이었으면 끊길 때 같은 키로 확인만 한다.
- HTTP 201만으로 성공을 판단하지 않는다. `data.status`가 `ACCEPTED`일 때만 성공이다.

## 쓰지 않는 것(보류)

- 조회(`GET /api/orders`, `GET /api/orders/{id}`)와 이전 주소(`GET /api/customers/{id}/addresses`)는 AI에게 `call_session_seq` 헤더를 요구한다. 그런데 이 값은 `POST /api/orders` 응답에서만 받는다. 통화 끝에 결과를 한 번 보내는 흐름에서는 통화 중에 이 값이 없다. 통화가 끝난 뒤에는 그 통화에 연결된 주문 한 건만 조회할 수 있다.
- 수정(`PATCH /api/orders/{id}`)은 미완료(COLLECTING) 주문만 고친다. 접수된 주문을 취소하는 API는 없다(`CANCELLED`는 상담 중 취소 기록일 뿐이다).
- 그래서 조회·수정·취소 도구(`lookup_orders`·`modify_order`·`cancel_order`)는 **사용 보류**다. 코드와 옛 계약 메서드(`/internal/ai/...`)는 두고 흐름에서는 쓰지 않는다(`spec/scenario.md` "하위 흐름"). 그 용건은 상담원 연결 제안으로 간다.
- 배송지 저장 API는 없다. 이전 주소는 백엔드가 접수 완료된 주문에서 만든다. 그래서 통화 중 "배송지 저장" 단계는 없앴다.
- 관제 화면의 주문 목록(`recent_orders`)은 옛 계약이다. 실제 백엔드에서는 관리자 세션이 필요해 실패하고, 가짜 백엔드에서만 보인다.
