# 백엔드 서버 API (AI 서버가 쓰는 것, 제안)

고객·주문·배송지는 AI 서버가 저장하지 않는다. 이 정보를 관리하는 **별개의 백엔드 서버**에서 API로 읽고 쓴다.
이 문서는 AI 서버 쪽에서 필요한 API를 **제안**한 것이다. 백엔드 담당자가 검토해 확정하고, 바뀌면 이 문서와 `app/backend_api.py`를 같이 고친다.

- 구현: `app/backend_api.py`(클라이언트), 테스트 `tests/test_backend_api.py`(가짜 HTTP), `tests/conftest.py`의 `FakeBackend`(가짜 백엔드)
- 주소: 환경변수 `BACKEND_API_URL`(예: `http://backend:3000`). 시간 제한: `config/server.toml`의 `[backend] timeout_sec`
- HTTP: `openai`에 딸린 `httpx2`(의존성 추가 없음)

## 공통 규칙

- 경로 앞에 `/internal/ai`를 붙인다. **AI 서버 전용 내부 API**이고, 밖(공인 인터넷)에는 열지 않는다.
- 요청·응답은 JSON, 문자 인코딩 UTF-8.
- **전화번호는 URL(경로·쿼리)에 넣지 않고 본문으로 보낸다.** 접근 로그에 개인정보가 남지 않게 하려는 것이다. 그래서 조회도 `POST`를 쓴다.
- 전화번호는 숫자만 쓴다(예: `01012345678`). AI 서버가 정규화하고 자릿수를 검사한 값이다.
- 발신번호(`caller_phone`·`owner_phone`·`phone`)는 PBX에서 온 값이다. 미신뢰 입력이지만, **소유 확인 기준**은 이것뿐이다. 백엔드는 이 번호의 주문·배송지만 돌려주고 고친다.
- 주문 항목 이름은 AI 서버와 같다: `sender_name`, `sender_phone`, `sender_address`, `sender_address_detail`, `receiver_name`, `receiver_phone`, `receiver_address`, `receiver_address_detail`, `item`. 상세 주소가 없으면 빈 문자열이다.
- 주문 상태: `received`(접수) · `cancelled`(취소).
- 정해진 상태 코드 밖의 응답(5xx 등)이나 시간 초과는 AI 서버가 실패로 처리한다. 통화는 끊지 않고 고객에게 다시 확인하거나 상담원 연결을 안내한다.
- **인증: 결정 필요(백엔드 담당자).** 예: 서비스 토큰 `Authorization: Bearer ...`, 내부 네트워크 제한, mTLS. 정해지면 AI 서버 환경변수와 클라이언트 헤더를 추가한다.

## 1. 발신자 정보 — `POST /internal/ai/callers/context`

통화 시작(accept 전)에 한 번 부른다. **accept가 늦으면 통화를 놓칠 수 있으므로 빨라야 한다**(수백 ms 안쪽 권장).

요청 `{"phone": "01012345678"}`

응답 200
```json
{
  "recent_order": { "sender_name": "...", "...": "주문 항목 9개" },
  "places": [
    {"kind": "origin", "name": "김철수", "phone": "01012345678", "address": "서울 강남구 테헤란로 212", "address_detail": "1201호"},
    {"kind": "destination", "name": "이영희", "phone": "01098765432", "address": "부산 해운대구 센텀로 10", "address_detail": ""}
  ]
}
```
- `recent_order`: 이 번호의 **취소되지 않은 마지막 주문**. 없으면 `null`.
- `places`: 이 번호 주인의 저장된 배송지. `kind`는 출발지 `origin`, 도착지 `destination`. 없으면 빈 목록.
- 등록 고객 판단(지난 주문이나 저장된 배송지가 있음)은 AI 서버가 이 응답으로 한다.

## 2. 접수 — `POST /internal/ai/orders`

헤더 `Idempotency-Key: <session_id>-<그 통화의 n번째 주문>`

요청
```json
{"caller_phone": "01012345678", "session_id": "live_...", "fare": 4950, "...": "주문 항목 9개"}
```
- `caller_phone`은 발신번호를 모르면 `null`이다.
- `fare`는 확인된 금액이 있을 때만 보낸다. 2026-10-27부터 미확정 금액은 생략하며0원/임시 고정값을 보내지 않는다. 백엔드가 규격을 받아 실제 요금을 계산하도록 연동해야 한다. 현재 API의 fare 생략 수용 여부와 규격 필드/응답 금액은 담당자 확인 전이다. 예시 숫자는 정책/고정값이 아니다.

응답 201 `{"order_no": "Q000123"}`
- **접수번호는 백엔드가 발급한다.** 동시 접수에서도 겹치지 않아야 한다.
- **같은 `Idempotency-Key`로 다시 오면 새로 만들지 말고 처음 발급한 접수번호를 돌려준다.** 응답을 못 받은 AI 서버가 고객 확인을 다시 받아 재요청할 때 중복 접수를 막는다.

## 3. 이 번호의 주문 조회 — `POST /internal/ai/orders/search`

요청 `{"caller_phone": "01012345678", "limit": 5}`

응답 200
```json
{"orders": [{"order_no": "Q000123", "receiver_name": "이영희", "receiver_address": "부산 ...", "item": "옷", "fare": 4950, "status": "received", "created_at": "2026-10-21T14:05"}]}
```
- 최근 접수 순이다. 없으면 빈 목록. 음성으로 안내할 것이므로 필요한 항목만 준다.

## 4. 주문 수정 — `POST /internal/ai/orders/{order_no}/update`

요청 `{"caller_phone": "01012345678", "changes": {"item": "책", "receiver_phone": "01011112222"}}`
- `changes`에는 위 주문 항목 이름만 온다. 그 밖의 키는 무시하거나 400.
- `order_no`는 경로 조각으로 인코딩해서 온다(고객이 말한 값이라 미신뢰).

응답
| 코드 | 뜻 |
|---|---|
| 200 | 수정됨 |
| 404 | 그 접수번호가 없거나 **이 발신번호의 주문이 아님**(둘을 구분하지 않는다) |
| 409 | 취소된 주문이라 수정할 수 없음 |

- 요금이 바뀌는 수정이면 응답에 새 `fare`를 넣어 달라. AI는 새 금액을 확인하기 전 미확정 상태로 안내한다.

### 실제 요금 계산 정책 (사용자 결정)

현재 실제 접수는 유인 기준이다. 백엔드가 서류=극소형3,850원, 소박스=소형4,950원, 중박스=중형6,050원, 대박스=대형7,150원으로 계산한다. AI의 현재 item은 물품 내용이므로 규격을 추정하지 않는다. 별도 규격 입력 전달·계산/접수 응답의 확정 금액 계약을 추가 합의해야 한다. FAQ의 유인/무인 안내 표와 실제 접수 기본값은 구분한다.

## 5. 주문 취소 — `POST /internal/ai/orders/{order_no}/cancel`

요청 `{"caller_phone": "01012345678"}`

응답: 200 취소됨, 404 없음 또는 이 발신번호의 주문이 아님, 409 이미 취소됨.

## 6. 배송지 저장 — `POST /internal/ai/callers/places`

요청
```json
{"owner_phone": "01012345678", "places": [{"kind": "origin", "name": "...", "phone": "...", "address": "...", "address_detail": ""}]}
```
- 고객이 저장에 동의했을 때만 부른다. 발신번호 주인의 배송지로 저장한다.

응답 200 `{"saved": 1}`
- 같은 소유자·종류·이름·연락처·주소·상세 주소가 이미 있으면 건너뛰고, 새로 저장한 개수만 센다.

## 7. 관제 화면용 최근 접수 주문 — `GET /internal/ai/orders?limit=100`

응답 200 `{"orders": [{"order_no": "...", "caller_phone": "...", "status": "...", "fare": 4950, "created_at": "...", "...": "주문 항목 9개"}]}`
- 관제 화면(임시, 인증 뒤)에서만 쓴다. 관제 화면을 없애면 이 API도 필요 없다.

## 결정 필요(백엔드 담당자)

- 인증 방식
- 경로·이름(위는 제안)
- 접수번호 형식(지금 화면·안내는 `Q000123` 형태를 가정)
- 요금 계산 주체(지금은 AI 서버 설정의 고정 요금을 보낸다)
- 응답 속도 목표(특히 1번)와 장애 시 동작
