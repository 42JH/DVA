# BE API 계약 (AI 서버 관점, 현행)

작성일: 2026-11-03 · 기준: BE 원문 `docs/be-contract/backend/`(develop-backend a629c60), AI 사용 문서 `docs/be-contract/ai/`, 구현 `backend_client/api.py`
경로 약어: `B/` = `docs/be-contract/backend/`, `A/` = `docs/be-contract/ai/`, `api.py` = `backend_client/api.py`
우선순위(`docs/be-contract/README.md`): 날짜가 늦은 `backend/docs` 인계 문서 > `docs/api` 원문 > `ai/` 문서. 예외: 수거 시각(AI 팀 결정).

> **이 문서의 경로·메서드·필드·오류 코드는 변경 불가 계약이다**(AGENTS.md §2). 정보가 없으면 "확인 필요".

> **최신 규약(2026-11-03, BE `refactor/unused-backend` 7da8876): `spec/ai-integration-current.md`가 이 문서보다 우선한다.** 반영(S6): 결제 기본 billing 금지·COMPLETE는 선택 필요, `pickupRequestedAt` 호환 선택값(보내지 않음), 상태 `SUBMITTING_FAILED`(10분 자동 재시도, 새 키 금지), 503·네트워크는 같은 키·본문 재시도·409는 error.code 구분·404(삭제·만료 통화)는 전송 종료, 최종 분석 7개 값 + 필수 필드(`result` 등 제거 필드 금지), 이벤트 1~50개·eventId 고정·eventOrder 증가, 미답변 API, 전체 주문 취소 `POST /api/orders/{id}/cancel`(미사용). 하위 문서(`docs/api/call-events.md` 등) 최신본은 받지 못해 a629c60 사본 기준 — 확인 필요. 계약 테스트 픽스처 `app/tests/fixtures/be_contract/7da8876/`.

---

## 0. 공통 규약

| 항목 | 내용 | 근거 |
|---|---|---|
| 기본 경로 | `BACKEND_API_URL` + `/api/...`, JSON UTF-8, camelCase | `B/ai-order-billing-integration.md` 서두 |
| 단건 응답 | `{data, meta:{requestId}}` | `B/orders.md` |
| 목록 응답 | `{data, hasNext, total_count}` (limit·offset 적용 전 COUNT) | 각 목록 문서 말미 |
| 오류 응답 | `{error:{code,message,details}, meta:{requestId}}` | `B/call-events.md` |
| 204 | 본문 없음 | — |
| 공통 헤더 | 응답에 `X-Request-Id`, `Cache-Control: no-store` | `B/caller-context.md` |
| 서비스 인증 | 고객·주문·주소·FAQ 조회 API는 **MVP 무인증** (Jira S15P31D109-135 후속). 인사이트·페르소나·FAQ 알림만 Bearer | `A/backend-api.md` 서두 |
| `call_session_seq` 헤더 | 고객 확인 2단계 응답 `callSessionSeq`. 인증이 아니라 **고객 범위** 확인용. 밑줄 헤더라 nginx 경유 시 `underscores_in_headers on` 필요 | `B/orders.md`, `A/backend-api.md` "확인할 것" |
| 관리자 쿠키 | 보내지 않는다(잘못된 쿠키는 익명 호출로 전환되지 않고 401/403) | `B/caller-context.md` |
| 개인정보 | 전화번호·이름을 URL에 넣지 않음(본문으로). 예외: 기업 검색 `q` | `A/backend-api.md` 공통, `api.py:1-2` |
| 좌표 | `latitude`·`longitude`는 모든 주소에서 제거. **값·null 무엇이든 보내면 400 INVALID_REQUEST** | `B/address-coordinates-removal.md` |
| 주문 주소 7필드 | `name, phoneNumber, roadAddress, jibunAddress, detailAddress, dongName, postalCode` | 同上 |
| HTTP 클라이언트 | `httpx2.AsyncClient(base_url, timeout=timeout_sec)` 단일 인스턴스, 전 요청 공통 타임아웃 | `api.py:177` |
| 예외 | 예상 밖 응답 → `BackendError(str)` (상태코드·error.code를 **문자열로만** 담음) | `api.py:41-42` |

### 0.1 인증 토큰 매핑

| 토큰(env) | 대상 API | 코드 |
|---|---|---|
| 없음 | customers, pins, addresses, companies/search, orders, faqs | — |
| `AI_INSIGHTS_TOKEN` | `/api/ai/calls/{id}/events`, `/analysis`, `/api/ai/unanswered-questions` | `api.py:403` |
| `AI_PERSONA_TOKEN` | `/api/ai/config`, `/api/ai/config/apply-result` (+ AI가 노출하는 `/internal/persona/*`) | `api.py:371-372` |
| `AI_FAQ_TOKEN` | BE→AI `POST /internal/faqs/refresh` | `app/webhooks/faqs.py`(원본 RAG) |

### 0.2 타임아웃·재시도 요약 (코드 기준)

| 호출 | 타임아웃 | 재시도 | 근거 |
|---|---|---|---|
| 일반 | 생성자 `timeout_sec`(값은 호출자 설정, 원본 `[backend] timeout_sec`) | 없음 | `api.py:177` |
| `POST /api/orders` | `submit_timeout_sec`=15s/요청 | 연결 실패·202·504·409 `REQUEST_IN_PROGRESS` → 같은 키·본문으로 `retry_interval_sec`(2s)마다, 총 `submit_retry_sec`(40s) | `api.py:320-345` |
| insights | 공통 | 연결 실패·5xx 3회(`INSIGHTS_ATTEMPTS`), 간격 2s | `api.py:401-417` |
| BE 문서상 정책 | 디버 호출 최대 10s(자동 재전송 없음) → AI 타임아웃은 그보다 길게 | `B/ai-pbx-recordings.md` §2 |
| 그 외 BE 권장 타임아웃 | **확인 필요** (BE 문서에 없음) | — |

---

## 1. `POST /api/customers/context` — 고객 확인 / 통화 등록

근거: `B/caller-context.md`, `B/meaningful-call-registration-handoff.md` §1-2, `B/active-call-count.md` · 코드: `api.py:223-252` `caller_context(phone, call=None, recent_limit=5)`

**2단계 호출(필수 순서)**

| | 1단계: 수신 직후 조회 | 2단계: 업무 의도 확인 후 등록 |
|---|---|---|
| 본문 | `{"phoneNumber"}` | `{"phoneNumber", "call":{"providerCallId","incomingAt"}}` |
| 부수효과 | 없음(통화·감사·진행 통화 수 영향 없음) | call_sessions 생성/재사용, 신규 시 CALL_STARTED·진행 통화 수 +1 |
| `callSessionSeq` | 없음 | 있음 |

- 헤더: `Content-Type: application/json`만(쿠키·Bearer·`call_session_seq`·Idempotency-Key 불요).
- `phoneNumber`: 숫자 문자열, 선행 0 보존. 숫자 타입·빈 값·공백·하이픈·`+`·줄바꿈·null·추가 필드·`phone` 필드 → 400. call 있을 때 `0082`→`0`, 변환 후 3~20자리.
- `call.providerCallId`: 최초 OpenAI 수신 이벤트 `session_id`, 1~200자, 공백·NUL 불가. `call.incomingAt`: 수신 이벤트 `created_at`(Unix 초)의 시간대 포함 ISO 8601. **현재/등록 시각으로 바꾸지 않는다.** 두 필드 모두 필수, null·빈 객체·추가 필드 400.
- 멱등: 같은 ID·번호·시각 재요청은 같은 번호(동시 요청도 1건). 같은 ID에 번호·시각이 다르면 409. 종료 통화를 재시작하지 않음.
- 등록 시한: PBX 수신 후 30분 안에 등록해야 녹취 연결(`B/meaningful-call-registration-handoff.md` §3). PBX 매칭은 발신번호 + `incomingAt` vs PBX `startedAt` ±30초(§2).
- 무의미 통화: 1단계에서 끝내고 이후 쓰기 API(주문·분석·이벤트·미답변) 일절 호출 금지, NO_ORDER도 보내지 않음.

**응답 200 `data`**

| 필드 | 내용 | 코드 매핑 (`CallerContext`) |
|---|---|---|
| `callSessionSeq` | 2단계만 | `call_session_seq` |
| `lookupStatus` | `REGISTERED`/`UNREGISTERED`/`WITHDRAWN` | `status` |
| `customer` | `{customerSeq,name,phoneNumber,status,monthlyBillingEnabled,address|null}`\|null | `customer_seq`,`name`,`default_origin`(address+이름+**요청 phone**) |
| `membership`, `organization`, `department` | 소속 정보\|null | 미사용 |
| `availableUsageTypes[]` | `PERSONAL`/`COMPANY` | `usage_types` |
| `availablePaymentMethods[]` | `billing`/`credit`/`groupBilling` | `payment_methods` |
| `personalPins[]` | `{personalPinSeq,label,addressData,version}` 전체 | `places`(중복 제거, `_pin_place`) |
| `companyPins` | 항상 `[]`(폐기) | 읽지 않음 |

**오류**

| HTTP | code | 의미 | 코드 처리 |
|---|---|---|---|
| 400 | INVALID_REQUEST | 잘못된 본문 | `BackendError` |
| 409 | INVALID_STATE | 같은 providerCallId에 번호/시각 불일치 | `BackendError`(구분 안 함) |
| 401 | UNAUTHORIZED | 잘못된 관리자 쿠키 | `BackendError` |
| 403 | FORBIDDEN | 쿠키+미허용 Origin | `BackendError` |
| 503 | DEPENDENCY_UNAVAILABLE | DB 실패(UNREGISTERED 대체 반환 안 함, 새 통화 롤백) | `BackendError` |
| 연결 실패 | — | — | **httpx2.TransportError 그대로 전파**(래핑 없음) |

- AI 정책(`A/backend-api.md` §1): 실패(시간 초과·5xx) 시 신규 고객으로 진행, 통화 번호가 없으므로 조회·취소는 C3_FAIL. WITHDRAWN은 바로 상담원 연결.
- 코드 부가동작: REGISTERED이고 `customer_seq`·`call_session_seq`가 있으면 이어서 `address_history` ORIGIN 1건, DESTINATION `recent_limit`건을 **순차** 호출. 실패는 경고 로그 후 무시(`api.py:244-251`).

## 2. `POST /api/customers` — 신규 고객 등록

근거: `B/customers.md` · 코드: `api.py:254-261` `create_customer(name, phone)`

- 인증 없음. Idempotency-Key 무시.
- 본문: `{name, phoneNumber, monthlyBillingEnabled?, address?}`. AI는 `{name, phoneNumber}`만 보냄. name trim 후 빈 값·null 거절, phoneNumber 숫자 문자열(자동 변환 없음). `monthlyBillingEnabled:true`는 관리자만. `address`는 `{roadAddress,jibunAddress,detailAddress?,dongName,postalCode(5자리)}`. 추가 필드 400.
- 성공: 201 `{data:{customerSeq}}` → `int`.
- 오류: 400 INVALID_REQUEST / 409 DUPLICATE_RESOURCE(탈퇴 포함 기존 번호, 응답 유실 시 재생 없음) → 코드는 `None` 반환 / 그 외 `BackendError`.
- 시점(AI 결정, `A/backend-api.md` §1-1): 신규 고객의 보내는 분 성함·주소·상세가 모두 기록되는 순간, 통화당 1회 → 같은 통화로 `caller_context` 재호출 → 보내는 곳 PIN 저장. 실패해도 신규 고객으로 진행. **현 rebuild 저장소에는 이 흐름 코드가 없다.**
- 타임아웃·재시도: 확인 필요.

## 3. `POST /api/customers/{customerSeq}/pins` — 개인 주소록 저장

근거: `B/pins.md` · 코드: `api.py:263-269` `create_pin(call_session_seq, customer_seq, order, role, label)`

- 헤더: `call_session_seq`(진행 중 통화, 발신번호 = PIN 소유 고객, ACTIVE).
- 본문: `{label?: string|null, addressData}`. addressData 필수: name·phoneNumber·roadAddress·jibunAddress·dongName·postalCode(5자리). detailAddress 생략 또는 `""`(null 거절). 알 수 없는 필드 400.
- 성공: 201 `{data:{personalPinSeq, version}}`.
- 오류: 400 입력 / 401 관리자 인증 / 403 다른 고객 / 404 고객·통화·PIN 없음 / 409 중복 주소(`DUPLICATE_RESOURCE`) **또는 사용 불가 상태(종료 통화·탈퇴 고객, error.code 확인 필요)**.
- 코드 처리: 200·201·409 모두 성공 취급(**상태 오류 409를 삼킴**). geo 없으면 jibun·dong·postal 누락 → 400.
- Idempotency-Key 없음(고유 제약으로 중복 방지). 타임아웃·재시도: 확인 필요.

## 4. `GET /api/customers/{customerSeq}/addresses` — 이전 접수 주소

근거: `B/order-address-history.md` (README 표의 `/api/customers/addresses`는 오기) · 코드: `api.py:271-281` `address_history(call_session_seq, customer_seq, direction, limit)`

- 헤더: `call_session_seq`.
- 쿼리: `direction` 필수 `ORIGIN|DESTINATION`, `from`(포함)/`to`(미포함) ISO 8601(`+`는 `%2B`), `q`, `limit` 1~100(기본 20), `offset` ≥0. 미지원 쿼리 400. AI는 `direction`,`limit`만 사용.
- 응답 200: `{data:[{orderSeq,orderParcelSeq,createdAt,address{7필드}}],hasNext,total_count}` — ACCEPTED 주문만, createdAt DESC, 같은 주소도 행별로 반환.
- 오류: 400 INVALID_REQUEST(헤더 누락 포함) / 401 UNAUTHORIZED / 403 FORBIDDEN(고객 불일치·비활성) / 404 NOT_FOUND(통화 없음) / 409 INVALID_STATE(종료 통화). 코드는 전부 `BackendError`.
- 코드 동작: 이름·전화·도로명 중 하나라도 없는 행은 버리고, 같은 `Place`는 합침(BE는 합치지 않음).
- 용도: 출발지 1건은 이력으로만(기본 출발지는 `customer.address`), 도착지 N건은 "이번에도 {도착지}로"·핀 후보 앞쪽(`A/backend-api.md` §1, §1-0).

## 5. `GET /api/companies/search` — 기업·사원 배송지 검색

근거: `B/company-directory.md`, `B/company-address-directory-handoff.md` · 코드: `api.py:188-215` `search_company_places(query, limit=20, offset=0)`

- 인증·`call_session_seq` 없음. 발신자 소속으로 한정하지 않음.
- 쿼리: `q` 필수(NFC·trim, 공백만 400, 공백 단어 AND), `limit` 1~100, `offset` ≥0. `q` 반복·미지원 필드 400.
- 응답 200: `{data:[{organizationSeq,organizationName,membershipSeq,customerSeq,departmentSeq|null,departmentName|null,addressData{...}}],hasNext,total_count}`. 정렬 기업명→기업 번호→고객 번호.
- 오류: 400 명시. 그 외 코드 **확인 필요**("DB 장애를 빈 성공으로 바꾸지 않는다"). 폐기된 기업 PIN API는 404.
- 코드 검증: 인수 사전 검사, strict pydantic, 페이지 정합성(`hasNext`·`total_count`), `(organizationSeq, membershipSeq)` 중복 → 형식 오류 `BackendError`. httpx2 INFO 로그에서 이 경로 제외(`api.py:31-38`).
- 규칙: `customerSeq`·`membershipSeq`를 PIN 번호로 쓰지 않고, 주문에 `originPin` 미지정. 통화 검색은 `max_pin_options+1`개만 요청.

## 6. `GET /api/orders`, `GET /api/orders/{orderSeq}` — 주문 조회

근거: `B/order-read.md`, `B/orders.md`, `B/ai-order-billing-integration.md` §10 · 코드: `api.py:285-307` `find_parcels`, `order_detail`, `parcel`

- 헤더: `call_session_seq`. 발신번호 일치 ACTIVE 고객의 주문만. 종료 통화는 연결 주문 1건 상세만.
- 목록 쿼리: `customerSeq`, `from`/`to`, `status`(`COLLECTING|notPaid|PAID|SUBMITTING|ACCEPTED|SUBMISSION_FAILED|CANCELLED`), `recipientName`, `limit` 1~100, `offset`. `shipmentStatus` 400. **AI는 `limit`만 사용**(이름 필터는 AI가 함, PII를 URL에 넣지 않기 위해).
- 목록 `data[]`: `orderSeq,customerSeq,status,paymentMethodType|null,pickupRequestedAt,createdAt,creationSource,totalAmount,paidAt,paymentDueAt,parcelCount`.
- 상세 `data`: `orderSeq,customerSeq,status,paymentMethodType,pickupRequestedAt,version,parcelNo,dverReceivedAt,createdAt,updatedAt,totalAmount,paidAt,paymentDueAt,paymentRequest|null,billing*`, `parcels[]{orderParcelSeq,status(ACTIVE|CANCELLED),origin,destination,originPin|null,수량 4종,otherItemDescription,clientComment,itemPrice,notifiedPrice}`.
- 오류: 400 INVALID_REQUEST / 401 / 403 FORBIDDEN / 404 NOT_FOUND / 409 INVALID_STATE(종료 통화).
- 코드 처리: `order_detail` 404 → `None`, 그 외 `BackendError`. `find_parcels`는 목록 후 상세를 `asyncio.gather`로 **병렬(N+1)** 조회, 하나라도 실패하면 전체 실패. 택배 단위 dict로 변환(`_parcels`: `order_seq, order_parcel_seq, receiver_name, receiver_address, status`).

## 7. `POST /api/orders/{orderSeq}/parcels/cancel` — 택배 취소

근거: `B/order-cancel.md`, `B/ai-order-billing-integration.md` §7 · 코드: `api.py:309-318` `cancel_parcels`

- 헤더: `call_session_seq`, Content-Type. Idempotency-Key·expectedVersion 없음.
- 본문: `{orderParcelSeqs:[int>0,...]}` 1개 이상·중복 불가. AI는 1개만.
- 성공: 204(이미 취소된 상세만 재요청도 204). 마지막 상세 취소 시 주문 CANCELLED, totalAmount 0.
- 허용 상태: `COLLECTING`, `notPaid`(결제 승인 중 제외). `PAID·SUBMITTING·ACCEPTED·SUBMISSION_FAILED` → 409.
- 오류: 400 / 401 / 403 / 404(하나라도 범위 밖이면 전체 거절) / 409(상태·승인 중). **error.code 문서에 없음 → 확인 필요.**
- 코드: `{204:"ok",404:"not_found",409:"conflict"}`, 그 외 `BackendError`. 재시도는 `cancel_order` 도구가 상세 재조회로 판단(`tool-contracts.md` §2.4).
- 미사용: 전체 취소 `POST /api/orders/{id}/cancel`.

## 8. `POST /api/orders` — 통화 결과(주문) 전송

근거: `B/orders.md`, `B/ai-order-billing-integration.md` §3-5·8, `B/order-billing.md`, `B/empty-ai-order-results.md`, `B/persona-read-payment-null-handoff.md` §2, `B/ai-pbx-recordings.md` §2, `B/ai-integration-quickstart.md` · 코드: `api.py:121-155` `parcel_body`/`result_body`, `api.py:320-345` `submit_result(body, idempotency_key)`

**원칙**: 통화 1건 = 주문 1건(다른 키로 새 주문 → 409). 재시도·재확인은 **같은 키 + 처음 만든 본문 그대로**.

**헤더**: `Idempotency-Key` = UUID(비 UUID 400). 전송 전에 보관, 재시작에도 유지. `call_session_seq` 불요(본문 `call`).

**본문**

| 필드 | 규칙 | 코드 |
|---|---|---|
| `outcome` | `COMPLETE`/`INCOMPLETE`/`CANCELLED` 필수 | 인수 그대로 |
| `call` | `{providerCallId, callerPhoneNumber, incomingAt}` 모두 필수, 고객 확인 때와 같은 값 | 인수 dict 그대로(검증 없음) |
| `customerSeq` \| `customer{name,phoneNumber}` | 둘 중 하나. INCOMPLETE/CANCELLED는 생략 가능 | seq 우선, 없으면 name 있을 때 customer |
| `paymentMethodType` | `billing/credit/groupBilling`. 모르면 **생략**(null 400). COMPLETE에서 비면 422 | falsy면 생략 |
| `pickupRequestedAt` | 시간대 포함 ISO 8601, 생략·null 가능(§A 충돌 참고) | 있으면 포함 |
| `totalAmount` | 미취소 `notifiedPrice` 합, 1~2147483647. 불일치 422 | 모든 fare를 알 때만 합계 |
| `parcels[]` | 완료 시 1건 이상, null 400 | 비면 생략 |
| `parcels[].origin/destination` | 7필드, 완료 시 detailAddress 외 필수, 좌표 400 | `_address`: None 값 제외, geo 있을 때만 지번 3필드 |
| `parcels[].originPin` | 선택. 기업 디렉터리 선택지는 지정 금지 | 보내지 않음 |
| 수량 4종 | 0~2147483647, 기본 0 | None 아니면 포함 |
| `otherItemDescription`, `clientComment` | 기본 `""` | None 아니면 포함 |
| `itemPrice` | 완료 시 필수, 배송비와 합산 금지 | None 아니면 포함 |
| `notifiedPrice` | 1~2147483647, 완료 시 필수 | fare 있으면 포함(양수 검사 없음) |
| 금지 | `status`, `version`, 디버 결과, `monthlyBillingEnabled`·`groupBillingEnabled` | 보내지 않음 |

**빈 결과**(`B/empty-ai-order-results.md`): INCOMPLETE/CANCELLED + 결제·수거·금액 미수집 + parcels 없음/빈 값 → 201 `status:"NO_ORDER"`, `orderSeq:null`(이후 상세·수정·취소 호출 금지). 무의미 통화는 요청 자체를 보내지 않음. `itemPrice: 0`은 수집된 값.

**응답 `data`**: `{orderSeq,version,status,callSessionSeq,parcelNo,totalAmount,paymentDueAt,paymentRequest|null}`

| HTTP / status | 의미 | AI 안내(`A/backend-api.md` §4) |
|---|---|---|
| 201 `ACCEPTED` | 디버 접수 성공 | **성공 안내는 이것만**, `parcelNo` |
| 201 `notPaid` | 개인 카드 결제 대기(+24h) | 결제 확인 후 접수 진행 |
| 201 `PAID`/`SUBMISSION_FAILED` | 결제 완료/디버 실패(운영자 재접수) | 확인 후 연락 |
| 202 `SUBMITTING` | 처리 중 | 같은 키로 재확인 |
| 201 `COLLECTING`/`CANCELLED`/`NO_ORDER` | 미완료/취소/주문 없음 | 안내 없음 |
| 같은 키 재요청 | 기존 결과, 본문 재적용 없음 | HTTP 코드: BE 문서 미기재(AI 문서 200) — 확인 필요 |

**오류**

| HTTP | code | 의미 | BE 권고 | 코드 처리 |
|---|---|---|---|---|
| 400 | INVALID_REQUEST | 형식·비 UUID 키·null·좌표 | 실패 | `BackendError` |
| 403 | (미기재) | 고객·PIN·결제 자격 없음, 키 재사용 | 실패 | `BackendError` |
| 404 | (미기재) | 통화·주문·상세 없음 | 실패 | `BackendError` |
| 409 | REQUEST_IN_PROGRESS | 같은 키 처리 중/잠금 2s 초과 | 같은 키 재시도 | 재시도 |
| 409 | (미기재) | 같은 통화 다른 키, 상태 충돌 | 기존 키로 확인 | `BackendError` |
| 422 | VALIDATION_FAILED | COMPLETE 필수값·배송비·합계 | 실패 | `BackendError` |
| 503 | (미기재) | DB·디버 설정 불가 | **같은 키로 결과 확인**(`B/ai-order-billing-integration.md:220`) | **즉시 `BackendError`(불일치)** |
| 504/연결 실패 | — | 결과 불확실 | 같은 키 재확인 | 재시도 |

- 재시도 종료 시 마지막 `data`(대개 SUBMITTING) 반환, 없으면 `BackendError("결과 확인 시간 초과")`. 호출자는 `status`로 판정해야 한다(HTTP 201만으로 성공 판단 금지).
- SUBMITTING이 1분 이상 정체 후 재호출 시 SUBMISSION_FAILED로 바뀜. SUBMISSION_FAILED 자동 재접수 없음.
- COMPLETE 전송 후 끊겨도 INCOMPLETE/CANCELLED를 따로 보내지 않음.
- COMPLETE 필수: 고객, 결제 방식, 택배 ≥1, 택배마다 주소 필수 필드, 수량>0 또는 기타 물품, 물품 가액, 양의 배송비, 합계 일치. 배송비는 AI 요금표(`[fare]`)로 계산, 모르면 INCOMPLETE(`A/backend-api.md` §3) — 요금표는 원본 그대로 `config/server.toml` `[fare]`, 계산 `app/domain/fare.py`(2026-11-03 이관).

## 9. `PATCH /api/orders/{orderSeq}`, `POST /api/orders/{orderSeq}/submit` — 미사용(계약만)

근거: `B/order-update.md`, `B/order-submit.md`
- PATCH: `call_session_seq`, `{expectedVersion, ...변경}`, AI는 COLLECTING만. 200 `{data:{version}}`. 409 `VERSION_CONFLICT`/`INVALID_STATE`/`REQUEST_IN_PROGRESS`, 422 `VALIDATION_FAILED`.
- submit: `{expectedVersion}` → 200/202 `{status}`.
- 현 흐름(통화 끝 1회 전송)에서는 사용하지 않음. 코드 `update_order`는 **BE에 없는 옛 경로** `POST /internal/ai/orders/{no}/update`(`api.py:427-433`).

## 10. `POST /api/ai/calls/{callSessionSeq}/events` — 통화 이벤트

근거: `B/call-events.md`, `A/insights.md` · 코드: `api.py:419-420`(본문 생성기 **없음**)

- 헤더: `Authorization: Bearer <AI_INSIGHTS_TOKEN>`.
- 본문: `{providerCallId(≤200), events[1..50]}`, 전체 ≤100KiB. 이벤트: `eventId`(UUID, 재전송 유지), `eventOrder`(통화 전체 순번), `kind`(`UTTERANCE|AI_ACTION|BUSINESS_RESULT`), `occurredAt`, `offsetSeconds`(정수|null), `payload`.
  - UTTERANCE `{utteranceOrder, speaker CUSTOMER|AI, utteranceText≤20000, lastSentenceSeq}`
  - AI_ACTION `{action ∈ PIN_SEARCH|PREVIOUS_ORDER_SEARCH|CUSTOMER_LOOKUP|FAQ_SEARCH|FIELD_SAVED|ORDER_SUBMITTED|ORDER_CANCELLED, summaryText≤1000, orderSeq|null}`
  - BUSINESS_RESULT `{action ∈ ORDER_CREATED|ORDER_CANCELLED|QUESTION_UNANSWERED|HANDOFF_REQUESTED|INQUIRY|FAQ_ANSWERED, orderSeq|null, unansweredQuestionSeq|null, summaryText}` (FAQ_ANSWERED는 `faqEntrySeq, questionUtteranceOrder, answerUtteranceOrder` 필수)
  - 금지: offsetMs, 레이턴시, 동작 status, 원문 tool 인자, 임의 필드.
- 성공: 204(동일 재전송 204).
- 오류: 400 INVALID_REQUEST / 401 UNAUTHORIZED / 403 FORBIDDEN / 404 NOT_FOUND / 409 EVENT_PAYLOAD_CONFLICT / 413 PAYLOAD_TOO_LARGE / 422 VALIDATION_FAILED / 500 INTERNAL_ERROR / 503 DEPENDENCY_UNAVAILABLE(BE 토큰 미설정).
- 코드: 연결 실패·5xx 3회 재시도, 4xx 즉시 실패.

## 11. `POST /api/ai/calls/{callSessionSeq}/analysis` — 통화 분석

근거: `B/call-analysis.md` · 코드: `api.py:422-423`(본문 생성기 **없음**)

- 헤더: Bearer `AI_INSIGHTS_TOKEN`.
- 필수: `providerCallId, startedAt, endedAt(≥startedAt), aiPersonaVersionSeq(int|null, 통화 시작 시 고정), repeatQuestionCount(≥0|null), hasComplaint(bool|null), complaints[≤20]`.
- 선택(생략·null=미수집): `isNewCustomer, registeredParcelCount, faqAnswerCount, orderLookupCount, cancelledParcelCount, hasHandoffRequest`.
- complaint: `{type ∈ REPEATED_QUESTION|SPEAKING_TOO_FAST|RECOGNITION_FAILURE|SLOW_RESPONSE|AI_REFUSAL, evidenceText≤1000, offsetSeconds|null, utteranceOrders[]}`.
- **`result` 필드를 보내면 400**(migration 042, `B/call-analysis.md:17`). `A/insights.md`의 `result` 전송 설명은 낡음.
- 성공 204, 같은 정규화 본문 204, 다른 내용(나중에 요약 추가 포함) 409 EVENT_PAYLOAD_CONFLICT. 그 외 400/401/403/404/422/503.

## 12. `POST /api/ai/unanswered-questions` — 미답변 질문 (클라이언트 미구현)

근거: `B/unanswered-questions.md`
- Bearer `AI_INSIGHTS_TOKEN`. 본문 6필드 필수: `eventId(UUID), callSessionSeq, providerCallId≤200, questionText≤1000, occurredAt, offsetSeconds(정수|null, 생략 불가)`.
- 최초 201 / 재전송 200, `{data:{unansweredQuestionSeq}}` → events BUSINESS_RESULT `QUESTION_UNANSWERED`에 사용.
- 오류: 400/401/403/404/409 EVENT_PAYLOAD_CONFLICT/413/422/500/503.
- **`api.py`에 메서드 없음**(원본 AI에도 없음, `docs/be-contract/README.md`).

## 13. 페르소나 — `GET /api/ai/config`, `POST /api/ai/config/apply-result`

근거: `B/ai-persona-next-call.md`, `B/persona-head-management.md` · 코드: `api.py:371-393`

- 헤더: Bearer `AI_PERSONA_TOKEN`(32자 이상).
- `GET /api/ai/config?status=ACTIVE|PENDING` → 200 버전 객체(`version, aiPersonaVersionSeq, name, promptText, voiceId, speakingRate, turnWaitLevel, applicationId, ...` — AI용 정확한 필드 목록 확인 필요) / 404 없음(코드 `None`).
- `POST /api/ai/config/apply-result` `{aiPersonaVersionSeq, applicationId, result: APPLIED|FAILED, errorCode?}` — FAILED면 `errorCode ∈ INVALID_CONFIG|UNSUPPORTED_OPTIONS|APPLY_FAILED` 필수. `activeCallCount` deprecated(보내지 않음).
  - 200 `data.status=ACTIVE`(FAILED도 200, PENDING 유지). APPLIED 반복 멱등. 409 VERSION_CONFLICT(교체됨·applicationId 다름, 코드 `None`) → ACTIVE/PENDING 재조회.
  - 응답 유실·타임아웃은 실패로 단정하지 않고 같은 회신 재시도 또는 ACTIVE 확인.
  - 401·503 등 그 외: 확인 필요.
- **AI가 노출해야 하는 API**: `GET /internal/persona/options`(200, `{voices[{id,label}], speakingRate{min,max}, turnWaitLevels[]}`, `data` 래핑 없음), `POST /internal/persona/refresh`(`{aiPersonaVersionSeq, applicationId}` → 202, 힌트로만). 둘 다 Bearer `AI_PERSONA_TOKEN`. BE는 5초 주기 확인·최소 30초 간격 재전송. **rebuild 저장소에 구현 없음.**
- 코드 위험: `persona_token=None`이면 `Authorization: Bearer None` 전송.

## 14. FAQ — `GET /api/ai/faqs` / BE→AI `POST /internal/faqs/refresh`

근거: `B/faqs.md`, `B/ai-faq-integration.md`, `A/faq-sync.md` · 코드: `api.py` `faq_entries(ids)`·`initial_faq_entries()`(원본 인터페이스), `app/webhooks/faqs.py`(원본 RAG)

**AI → BE `GET /api/ai/faqs`**
- 인증·통화 헤더 없음. 코드는 별도 `httpx2.Request`로 쿠키·토큰·통화 헤더 상속 차단, 리다이렉트 비추종.
- 쿼리: `faqEntrySeqs=1,2`(중복 없는 양의 정수 1~100), `q`≤200(알림 처리엔 안 씀), `limit` 1~100, `offset`. 코드는 항상 `limit=100, offset=0`.
- 200 `{data:[{faqEntrySeq,question,answer,updatedAt}],hasNext,total_count}` — 없는/삭제 번호는 빠짐(전부 없으면 빈 목록 200).
- 오류: 400 INVALID_REQUEST / 404(단건) / 500 INTERNAL_ERROR. 코드: `FAQ_FETCH_FAILED`/`FAQ_HTTP_ERROR:{n}`/`FAQ_INVALID_RESPONSE`.
- 한계: 전체 이전에서 `hasNext=true`면 RAG가 실패 처리(`A/faq-sync.md`).

**BE → AI `POST {AI_AGENT_URL}/internal/faqs/refresh`** (AI가 노출)
- Bearer `AI_FAQ_TOKEN`(32자 이상, 페르소나 토큰과 별개).
- 본문: `{eventId: UUID, operation: INSERT|UPDATE|DELETE, faqEntrySeqs:[...]}` (INSERT/DELETE 1~100, UPDATE 정확히 1).
- **검증 후 영속 저장하고 202**. 같은 eventId 재수신도 202. 200·204는 BE가 성공으로 보지 않음.
- AI 오류 응답(AI 결정): 401 토큰 / 400 본문 / 413 크기 / 409 같은 eventId 다른 내용 / 503 비활성·설정·용량·잠금·시간 초과.
- BE 동작: 제한 2초, 202 외 전부 5·10·20·40·80·160·300초 간격 무한 재시도, 순서 보장, at-least-once.
- AI 처리: INSERT/UPDATE는 번호로 재조회(없으면 삭제), DELETE는 조회 없이 제거, 직렬 FIFO.

## 15. 진행 통화 수·녹취

- `B/active-call-count.md`: AI가 노출·호출할 API 없음. 2단계 등록만 건수에 반영되므로 최초 `providerCallId`·`incomingAt` 유지가 의무. 종료 웹훅 누락 시 진행 수에 남음(자동 종료 없음).
- `B/ai-pbx-recordings.md`: AI가 녹취 API를 호출할 필요 없음. BE가 발신번호 + `incomingAt` vs PBX `startedAt` ±30초(`RECORDING_MATCH_WINDOW_SECONDS` 1~300)로 매칭 → `incomingAt`은 반드시 OpenAI `created_at`.

---

## A. 문서 간 충돌

| 주제 | 내용 | 결론 |
|---|---|---|
| `pickupRequestedAt` | `A/backend-api.md` §4: COMPLETE에 미래 시각 필수(AI 결정) ↔ `B/orders.md`·`B/ai-order-billing-integration.md` §4·`B/order-billing.md`: 생략 가능, 서버가 결제 완료 + 1시간 ↔ `B/ai-pbx-recordings.md`·quickstart: "미래 수거 시각 필요". BE 소스도 고객 시각을 덮어씀(`docs/call-flow/README.md`) | README 예외로 AI 결정 유지 중. **BE 담당자 확인 필요** |
| 좌표 | 다수 원문 예시에 위경도 ↔ `B/address-coordinates-removal.md` 400 | 제거 문서 우선 |
| 결제수단 null/기본값 | 원문 "billing 기본값" ↔ `B/persona-read-payment-null-handoff.md`: 생략=null, 명시 null 400, COMPLETE 비면 422 | 후자 우선 |
| 미완료 `totalAmount` null | `B/ai-order-billing-integration.md` §3 "생략 또는 null" ↔ `B/empty-ai-order-results.md` | 확인 필요(코드는 생략) |
| 고객 확인 시점 | 원문 1회 호출 ↔ meaningful handoff 2단계 | 2단계 우선 |
| analysis `result` | `A/insights.md` 전송 ↔ `B/call-analysis.md` 400 | BE 우선 |
| 기업 PIN | `B/caller-context.md` 서두 ↔ 폐기(404, `companyPins=[]`) | 폐기 우선 |
| 목록 응답 | `A/backend-api.md` `{data,hasNext}` ↔ BE `total_count` 포함 | BE 우선 |
| 503 처리 | `A/backend-api.md` §4: 재전송 없이 실패 ↔ `B/ai-order-billing-integration.md:220`: 같은 키 확인 | BE 우선 → 코드 불일치 |

## B. 구현(`api.py`)과 계약의 불일치

> S1(2026-11-03) 반영: 1 해결(503을 같은 키 재확인에 포함). 2·4·6 — `BackendError`에 `status`·`code`를 담고 `app/integrations/backend/gateway.py`가 `BackendFailure(kind, code, …)`로 분류(연결 실패·타임아웃·응답 필드 누락 포함). 5 해결(409 중 `DUPLICATE_RESOURCE`만 성공). 7 해결(토큰 없으면 요청하지 않음). 남음: 2의 Idempotency-Key UUID 검사(BE가 400으로 거절 → `BE_CONTRACT_VIOLATION`), 3, 4의 phone 형식·순차 호출, 8, 9, 10.

1. `submit_result`가 503을 즉시 실패 처리(BE는 같은 키 확인 권고). `api.py:26,337`
2. `submit_result`가 403/404/422/일반 409를 구분하지 않고 문자열 `BackendError`로만 반환 → 업무 오류/시스템 오류 분기 불가. Idempotency-Key UUID 검사 없음.
3. `result_body`: `call` 3필드·고객 존재·`notifiedPrice` 양수 검증 없음(COMPLETE 422 위험).
4. `caller_context`: TransportError 미래핑, 409 INVALID_STATE 미구분, `phone` 형식 검사 없음, `resp.json()["data"]` KeyError 가능. 이전 주소 2회 순차 호출.
5. `create_pin`: 409 "사용 불가 상태"를 성공으로 삼킴.
6. `address_history`·`find_parcels`·`order_detail`·`cancel_parcels`: 400/403/409 미구분, TransportError 미래핑.
7. `persona_token=None` → `Bearer None`.
8. 미구현: `POST /api/ai/unanswered-questions`, analysis/events 본문 생성, `GET /internal/persona/options`·`POST /internal/persona/refresh` 수신.
9. BE에 없는 옛 경로: `update_order`(`/internal/ai/orders/{no}/update`), `recent_orders`(`/internal/ai/orders`). `api.py:24,427-440`
10. `faq_page`는 1페이지(100건)만.

## C. BE 문서상 미정·후속

- 서비스 인증·통화 결속(S15P31D109-135) 미적용.
- PBX 매칭 ±30초는 초기 보수값(실측 미확정).
- FAQ 다중 페이지 일관 스냅샷·색인 완료 회신 API 없음. 페르소나 다중 인스턴스 동기화 "별도 계약 필요".
- error.code 미기재: pins 409(상태), order-cancel 전체, companies/search, orders 403·404·409(다른 키)·503, ai/config 401·503, 같은 키 재요청 HTTP 코드.
- 기업 검색 `q`의 프록시 접근 로그 노출 여부.
