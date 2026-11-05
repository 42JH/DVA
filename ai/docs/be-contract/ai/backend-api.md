# 백엔드 서버 API (AI 서버가 쓰는 것)

고객·주문·배송지는 AI 서버가 저장하지 않는다. 별개의 **백엔드 서버**가 관리하고, AI 서버는 API로 읽고 쓴다.
계약의 원문은 백엔드 문서다(수거 시각만 AI 팀 결정으로 원문과 다르게 고쳐 두었다, 4번): `spec/ai-order-billing-integration.md`(AI 주문·결제·취소 연동 규격, S15P31D109-138), `spec/orders.md`(주문 API), `spec/order-address-history.md`(이전 주소), `spec/ai-pbx-recordings.md`(AI·PBX 연동). 백엔드 저장소 `develop-backend`의 `docs/api/`에서 옮겨 왔다(2026-10-31). 이 문서에는 AI 서버가 그 계약을 어떻게 쓰는지만 적는다. 계약이 바뀌면 원문을 다시 받아 오고 이 문서와 `app/backend_api.py`를 같이 고친다.

- 구현: `app/backend_api.py`(클라이언트·본문 만들기), 테스트 `tests/test_backend_api.py`(가짜 HTTP)
- 가짜 백엔드: `app/mock_backend.py`의 `MockBackend`. 테스트와 환경변수 `BACKEND_MOCK=true` 배포에서 쓴다. 통화당 주문 한 건, 같은 키는 기존 결과, COMPLETE 필수값(배송비·합계 포함), 결제 방식별 상태, 통화 고객 범위의 조회·상세 취소 같은 주요 검증만 흉내 낸다. `BackendAPI`의 공개 메서드를 모두 같은 이름으로 갖는다(`tests/test_mock_backend.py`가 검사): 주소 이력·주문 상세·FAQ 최초 조회 포함, 이전 접수 주소는 실제 클라이언트처럼 주소 이력으로 읽는다.
- 주소: 환경변수 `BACKEND_API_URL`(같은 Docker 네트워크에서 `http://backend:3000`). 설정: `config/server.toml` `[backend]`
- HTTP: `openai`에 딸린 `httpx2`(의존성 추가 없음)
- 인증: MVP 합의로 AI 호출은 서비스 인증이 없다(백엔드 Jira S15P31D109-135에서 추가 예정). 통화 번호(`call_session_seq` 헤더)는 인증 토큰이 아니라 고객 범위 확인용이다.
- FAQ 변경 알림 처리용 `BackendAPI.faq_entries`: 번호 필터로 최신 원문을 조회한다. 별도 MVP 무인증 계약이며 상세는 [FAQ 동기화](faq-sync.md). 통화 중이 아니라 색인 준비에 사용한다.

## 공통

- JSON, UTF-8. 단건 `{data, meta: {requestId}}`, 목록 `{data, hasNext}`, 오류 `{error: {code, message, details}, meta}`, 204는 본문 없음.
- **기업 배송지 검색의 `q`를 제외하고 개인정보를 URL에 넣지 않는다.** 전화번호는 본문으로, 받는 분 성함으로 거르는 것은 AI 서버가 한다(목록의 `recipientName` 쿼리를 쓰지 않음). 경로에는 백엔드가 준 정수 번호만 넣는다.
- 통화 중 조회·취소·이전 주소 요청에는 고객 확인에서 받은 통화 번호를 `call_session_seq` 헤더로 보낸다(`Call.call_session_seq`). 백엔드는 그 통화 고객의 주문만 보여 주고 취소하게 한다.

## 1. 고객 확인 — `POST /api/customers/context`

통화 시작(accept 전)에 한 번. 요청 `{"phoneNumber": "01012345678", "call": {"providerCallId": session_id, "incomingAt": 수신 시각}}`. 백엔드가 통화를 만들거나(같은 통화면 다시 써서) `callSessionSeq`를 준다. 고객·주문은 만들지 않는다. 시간 제한 `[backend] timeout_sec`.

| `data.lookupStatus` | AI 처리 |
|---|---|
| `REGISTERED` | 등록 고객. `customer.customerSeq`·`name`·`phoneNumber`·`address`(현재 기본 출발지), 주소록 `personalPins`의 `addressData`(도착지 핀 후보, 9개 항목이 다 있으면 다시 찾지 않음), `availablePaymentMethods`(결제 방식, 아래 3번) |
| `UNREGISTERED` | 신규 고객(`availablePaymentMethods`는 빈 배열) |
| `WITHDRAWN` | 신규로 다루지 않는다. 바로 상담원 연결 |

- 실패(시간 초과·5xx)면 신규 고객으로 진행한다. 통화 번호가 없으므로 조회·취소는 "조회가 어려워요"(C3_FAIL)가 된다.
- **이전 접수 주소** `GET /api/customers/{customerSeq}/addresses?direction=ORIGIN|DESTINATION&limit=`: 등록 고객이고 통화 번호가 있으면 이어서 부른다. 최근 것부터 오는 접수 완료(ACCEPTED) 주문의 주소다. 출발지 1건은 과거 이력으로만 보존하며 현재 기본 출발지를 대신하지 않는다. 도착지 `[flow] pin_recent_count`건은 "이번에도 {도착지 주소}로"와 도착지 핀 후보 맨 앞에 쓴다(`spec/scenario.md` B). 실패해도 고객 확인과 현재 기본 출발지는 그대로 쓴다.
  - ACCEPTED 주문만 오므로 개인 카드 결제 대기(notPaid) 중인 최근 주문은 빠진다.

## 1-0. 현재 기본주소와 기업 배송지 검색 (2026-11-02 인계)

- `customer.address`는 주소 객체 또는 null이며 이름·전화번호를 중복 저장하지 않는다. `CallerContext.default_origin`은 현재 고객 이름과 서버가 확인한 발신번호를 주소에 결합한다. 개인 PIN·과거 주문과 분리하며 고객 이름 변경을 PIN에 전파하지 않는다.
- 기본주소가 있으면 첫 택배의 출발지로 제안한다. 없으면 과거 주문/발신번호가 같은 개인 PIN을 자동 채택하지 않고 주소를 묻는다. 저장된 출발지를 적용해도 현재 이름·연락처와 통화 중 명시적 정정을 보존한다. 두 번째 택배부터 직전 출발지를 재사용한다.
- `companyPins`는 폐기 호환 필드이며 AI는 읽지 않는다. 전체 기업 사원을 통화 시작 때 가져오지 않는다.
- 기업·사원 배송지는 `GET /api/companies/search?q=...&limit=...&offset=...`로 찾는다. HTTP 클라이언트의 params로 인코딩한다. 응답은 `{data, hasNext, total_count}`, 항목은 `organizationSeq/organizationName/membershipSeq/customerSeq/departmentSeq/departmentName/addressData`다. 부서는 null일 수 있다. `companyPinSeq/label/version`을 요구하지 않는다.
- 검색어의 공백 구분 단어는 모두 일치해야 한다. 활성 기업·활성 소속·활성 고객·주소 보유 여부는 백엔드가 판정한다. 다른 기업의 사원도 검색할 수 있으며 AI는 사원 목록에 개인 PIN의 발신번호 범위를 적용하지 않는다.
- `CompanyPlace`에 기업/부서와 소속 식별값을 보관한다. 후보 선택은 기존 확인 흐름을 거친다. 번호를 PIN 번호로 변환하지 않는다. 주문에는 선택한 주소의 이름·전화번호·주소값만 복사하며 `originPin`을 지정하지 않는다. 과거 주문 주소는 바꾸지 않는다.
- 통화 검색은 `max_pin_options + 1`개를 요청한다. `hasNext=true` 또는 전체 개수가 표시 상한을 넘으면 일부를 유일 후보로 확정하지 않고 기업/부서/이름을 더 묻는다. 전체 사원 목록을 무제한 페이지 순회하지 않는다. 클라이언트 메서드는 별도 페이지 조회를 위해 offset도 지원한다.
- 0건과 연결/시간 초과/HTTP 오류/형식 오류를 구분한다. 오류 본문·검색어를 예외에 넣지 않고 httpx2의 기업 검색 요청 INFO 로그를 제외한다. 도구 기록은 기존 인증된 관제 범위에서만 다룬다. 인프라 프록시 접근 로그에서도 q를 노출하지 않도록 백엔드와 확인해야 한다.
- 고객 기본좌표 1 또는 범위를 벗어난 좌표는 확정 좌표로 쓰지 않는다. 저장된 주소에 좌표가 없으면 선택 후 기존 주소DB/카카오 보정 경로로 채운다. 못 찾으면 기존 미완료/재질문 규칙을 따른다.
- 새 계약 출처는 사용자 제공 `company-address-directory-handoff.md`다. 원격에는 해당 백엔드 작업 브랜치가 아직 없어 실제 서버와의 통합 검증은 별도다.

## 1-1. 신규 고객 등록 — `POST /api/customers`, `POST /api/customers/{id}/pins`

신규 고객이 보내는 분 정보(성함·보내는 곳 주소·상세주소)가 다 기록되는 순간(`record_order`, 통화에 한 번) 등록하고, 이때부터 기존 고객으로 다룬다(2026-10-31 결정, `Call.register_customer`).

1. `POST /api/customers` `{name: 보내는 분 성함, phoneNumber: 발신번호}` → 201 `customerSeq`. 이미 등록된 번호면 409(그대로 진행).
2. 고객 확인을 같은 통화로 다시 불러(이전 주소는 읽지 않음) 고객 번호·결제 자격을 받는다. 백엔드는 통화 고객을 발신번호로 찾으므로 등록 직후부터 통화 번호로 조회·주소록 API를 쓸 수 있다.
3. 보내는 곳(주소 9개 항목이 다 있을 때)을 개인 주소록에 저장: `POST /api/customers/{customerSeq}/pins` `{label: "보내는 곳", addressData}`, `call_session_seq` 헤더. 같은 주소면 409(그대로).

- 통화 결과는 `customerSeq`로 보낸다. 개인 PIN 저장은 고객 기본주소 갱신과 별개다. 다음 통화의 기본 출발지는 `customer.address`로만 제안하며, 없으면 주소를 묻는다.
- 실패해도 통화는 신규 고객으로 이어 간다(결과는 `customer: {name, phoneNumber}`).

## 2. 통화 중 조회·취소(C 흐름)

- **찾기**: `GET /api/orders?limit=[backend] lookup_limit`(통화 고객의 주문, 최근 것부터) → 주문마다 `GET /api/orders/{orderSeq}`로 상세를 읽어 택배(주문 상세) 단위로 받는 분·도로명주소·상태를 만든다(`BackendAPI.find_parcels`). 목록에는 받는 분이 없다. 받는 분 성함으로 거르는 것은 `Call.find_orders`가 한다.
  - shortcut: 최근 `lookup_limit`건 안에서만 찾는다. 그보다 오래된 주문은 성함으로 찾지 못한다.
- **상태**(`{배송 상태}`, `prompts/flow.toml` `[status_names]`): 취소한 상세는 `CANCELLED`, 아니면 주문 상태(`COLLECTING`·`notPaid`·`PAID`·`SUBMITTING`·`ACCEPTED`·`SUBMISSION_FAILED`·`CANCELLED`). 수거·배송 상태는 백엔드에 없다.
- **취소**: 고객이 확인한 택배 하나를 `POST /api/orders/{orderSeq}/parcels/cancel` `{"orderParcelSeqs": [n]}`(서버만 부름, `cancel_order` 도구). 취소할 수 있는 것은 `COLLECTING`·`notPaid`뿐이다. 결제가 끝난 뒤는 취소 불가(C7_LOCKED).

| 응답 | AI 처리 |
|---|---|
| 204 | 취소됨(같은 상세를 다시 취소해도 204) |
| 409 | 상세를 다시 조회해 `CANCELLED`면 "이미 취소됨", 아니면 결제 완료·처리 중이라 취소 불가 |
| 404 | 그 통화 고객의 주문이 아님 → 취소 실패 안내(C9_FAIL) |
| 그 밖·연결 실패 | 결과 불확실. 다시 시도하기 전에 상세 조회로 이미 취소됐는지 확인한다(`operation_id` 기록) |

- 전체 취소(`POST /api/orders/{id}/cancel`)는 쓰지 않는다(고객은 택배 하나를 골라 취소한다).

## 3. 배송비와 결제 방식

- **배송비**: 백엔드는 계산하지 않고 접수 때 검사만 한다. AI가 `config/server.toml` `[fare]`(규격 하나당 요금, 방문수거는 유인 지점 요금)로 택배별 `notifiedPrice` = 규격별 개수 × 요금의 합, `totalAmount` = 합계를 만든다(`Call.parcel_fare`). 요금이 없는 규격·기타 물품이 있으면 배송비를 모르는 것으로 보고 금액을 말하지도 보내지도 않으며 결과는 미완료(INCOMPLETE)로 보낸다. `itemPrice`(물품 가액)는 배송비와 합치지 않는다.
- **결제 방식**(`app/domain/assess.auto_payment`, 2026-11-05 사용자 결정): 고객에게 묻지 않는다. `availablePaymentMethods`에 `groupBilling`이 있으면 그것, 없고 `credit`이 있으면 그것, 방식이 하나뿐이면 그것(보통 `billing`). 빈 배열(미등록·탈퇴, 통화 중 등록 실패)이면 `paymentMethodType`을 빼고 INCOMPLETE(`PAYMENT_UNKNOWN`) — 기본 billing을 넣지 않는다. 백엔드가 접수 때 자격을 다시 검사한다(403이면 실패). 자격을 켜거나 우회하는 값(`monthlyBillingEnabled` 등)은 보내지 않는다.
- **안내**: 결제 방식·결제 안내는 말하지 않는다(2026-11-05). 결제 완료·결제 요청 발송도 말하지 않는다. notPaid 결과는 "담당자가 확인 후 안내"로 마무리한다.

## 4. 통화 결과 — `POST /api/orders`

**통화 하나에 한 번.** 백엔드는 통화 한 건에 주문 한 건만 받는다(같은 통화에 다른 키 → 409). 그 통화에서 고객이 확인한 택배들은 `parcels`에 묶는다. 언제 무엇을 보내는지는 `spec/scenario.md` "통화 결과"에 있다.

- 헤더 `Idempotency-Key`: 통화마다 UUID 하나(`Call.result_key`). 재시도·재확인에도 같은 키와 **처음 만든 본문 그대로**(`Call.result_body`) 보낸다. 같은 키는 백엔드가 본문을 다시 적용하지 않고 기존 주문의 현재 결과를 돌려준다.
- `call`: `providerCallId` = OpenAI `session_id`, `callerPhoneNumber` = SIP 발신번호(숫자), `incomingAt` = 수신 웹훅 이벤트 `created_at`을 ISO 8601(UTC, `Z`)로 바꾼 값(고객 확인 때와 같은 값). 본문에 `call`이 있으므로 `call_session_seq` 헤더는 보내지 않는다. 발신번호나 수신 시각을 모르면 결과를 보내지 않는다.
- 고객: 등록이면 `customerSeq`, 미등록이면 `customer: {name, phoneNumber: 발신번호}`(둘 중 하나만). 이름은 보내는 분 성함(MVP: 고객 = 보내는 분). 미완료·취소는 모르면 생략한다.
- `paymentMethodType`(3번), `pickupRequestedAt`(고객이 말한 수거 희망 시각, 시간대 포함, 미래), `totalAmount`(배송비를 다 알 때만).
  - 수거 시각은 사용자가 전달한 S15P31D109-138 연동 규격("최초 확정 시 미래 시각 필수")을 따른다(2026-10-31 결정). 백엔드 저장소의 최신 문서는 "생략 가능, 서버가 결제 완료 + 1시간으로 결정"이라 다르다. 백엔드와 맞춰야 한다.
- `parcels[]`: `origin`·`destination`(이름·전화번호·도로명·지번·상세·동명·우편번호·위경도), `documentCount`·`smallBoxCount`·`mediumBoxCount`·`bigBoxCount`, `otherItemDescription`, `clientComment`, `itemPrice`, `notifiedPrice`. **모르는 값은 넣지 않는다**(임의 기본값 금지).
- COMPLETE 필수: 고객, 결제 방식, 미래 수거 시각, 택배 한 건 이상, 택배마다 주소 9개 항목(상세 주소만 선택), 수량 하나 이상 또는 기타 물품 설명, 물품 가액, 양의 정수 배송비, 배송비 합계 = `totalAmount`. 지번·좌표·배송비를 모르는 택배가 있으면 AI가 COMPLETE 대신 INCOMPLETE로 보낸다(`Call.complete_ready`).

### 응답과 재시도(`BackendAPI.submit_result`)

| 응답 `data.status` | 뜻 | AI 마무리 안내 |
|---|---|---|
| `ACCEPTED` | 후불 결제 완료 후 디버 접수 완료 | 접수 완료·`parcelNo`(END_ACCEPTED) |
| `notPaid` | 주문 저장, 개인 카드 결제 대기(`paymentDueAt` 24시간) | 결제가 확인되면 접수 진행(END_NOT_PAID). 결제 완료·메시지 발송은 말하지 않는다 |
| `PAID` · `SUBMITTING` · `SUBMISSION_FAILED` | 결제 완료, 디버 접수 대기·중·실패(운영자 재접수) | 확인 후 연락(END_PENDING) |
| `COLLECTING` · `CANCELLED` | 미완료·취소 저장 | (안내 없음) |

| HTTP | AI 처리 |
|---|---|
| 201 · 200(같은 키 재요청) | `data.status`로 위 표대로 |
| 연결 실패 · 504 · 202(`SUBMITTING`) · 409 `REQUEST_IN_PROGRESS` | 같은 키·같은 본문으로 `retry_interval_sec`마다 다시 확인, 총 `submit_retry_sec`까지. 끝까지 처리 중이면 마지막 상태(SUBMITTING)를 돌려준다 |
| 그 밖(400·403·404·409·422·503 등) | 다시 보내지 않고 실패(`BackendError`). 성공 안내 금지 |

- 요청 하나의 시간 제한은 `submit_timeout_sec`(백엔드가 디버를 기다리므로 그보다 길게).
- "더 없어요"에서 COMPLETE를 보낸 통화는 끊겨도 INCOMPLETE·CANCELLED를 따로 보내지 않는다. 처리 중이었으면 끊길 때 같은 키로 확인만 한다.
- HTTP 201·200만으로 성공을 판단하지 않는다. `data.status`가 `ACCEPTED`일 때만 접수 완료다.

## 쓰지 않는 것(보류)

- 미완료 주문 보완(`PATCH /api/orders/{id}` + `POST /api/orders/{id}/submit`): 통화 끝에 결과를 한 번 보내는 흐름이라 쓰지 않는다. 배송비를 몰라 INCOMPLETE로 보낸 주문은 운영자가 보완·확정한다.
- 수정 도구(`modify_order`)는 수정 보류(§5.4)로 흐름에서 쓰지 않는다. 클라이언트의 `update_order`는 옛 계약(`/internal/ai/...`)으로 남아 있다.
- 배송지 저장 API는 없다. 이전 주소는 백엔드가 접수 완료된 주문에서 만든다.
- 관제 화면의 주문 목록(`recent_orders`)은 옛 계약이다. 실제 백엔드에서는 실패하고 가짜 백엔드에서만 보인다.

## 확인할 것(백엔드와)

- 수거 시각 규칙을 백엔드 문서와 맞춘다(위 4번, AI는 연동 규격대로 고객이 말한 미래 시각을 보낸다).
- `call_session_seq` 헤더 이름에 밑줄이 있다. 중간에 nginx 같은 프록시가 있으면 기본 설정(`underscores_in_headers off`)에서 헤더가 버려진다. AI → 백엔드가 Docker 내부망으로 직접 가면 문제없다.
