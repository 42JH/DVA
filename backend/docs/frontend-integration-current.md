# 프론트 파트 연동 명세 — 2026-11-04

코드 기준: `feature/ai-dashboard`, DB migration `050`까지. 운영 API에 적용된 상태는 별도 확인한다. 이번 문서는 실제 요청·표시·갱신에 필요한 현재 계약을 모으며, 구버전 문서의 수거 시각·콜백·좌표·통화 분류·기본 결제수단·물리 삭제 설명보다 우선한다.

AI 상담 성능 대시보드 GET 4개·고객 탭·현재/직전 활성 버전 비교·NULL/0 표시 규칙은 [프론트 전용 대시보드 명세](ai-dashboard-frontend-integration.md)를 따른다. 기존 통화 불편 유형에도 신규 5개 코드를 지원한다. 미답변 reason 표시/필터는 [049 계약](unanswered-question-reasons.md)을 따른다.

[AI 명세](ai-integration-current.md) · [이번 제거와 검증·DB 전환](unused-contract-cleanup.md)

## 1. 공통 API 호출

- 프론트는 배포된 BE의 `/api`를 base path로 사용한다. 같은 origin이면 상대 경로 `/api/...`로 호출하고, 다른 origin이면 실제 환경 설정을 사용한다.
- 관리자 인증은 HttpOnly `dva_session` 쿠키다. fetch는 `credentials: 'include'`. AI 서비스 토큰을 브라우저에 넣지 않는다.
- 고객 확인·등록·상세·수정도 관리자 화면에서는 유효한 세션을 보낸다. 익명 호출은 지원하지 않는다. [S01 업무 토큰](ai-business-auth.md)은 AI 서버 전용이며 프론트 인증 방식은 유지한다.
- 변경 요청은 허용된 Origin과 JSON Content-Type이 필요하다. 브라우저 Origin을 임의 값으로 덮어쓰지 않는다. 프론트 도메인은 서버 `CORS_ORIGINS`에 정확히 허용되어 있어야 한다. 이번 문서 작성으로 서버 CORS·nginx가 바뀌지는 않는다.
- ACTIVE인 OPERATOR·SUPERVISOR·SYSTEM_ADMIN이 일반 업무를 사용한다. 관리자 계정 관리는 SYSTEM_ADMIN, 페르소나 편집·publish·AI 옵션은 SUPERVISOR·SYSTEM_ADMIN이다. 로그인하지 않았거나 계정이 비활성이면 해당 로그인/권한 처리를 수행한다.

```javascript
const response = await fetch('/api/calls?limit=20&offset=0', {
  credentials: 'include',
});
if (!response.ok) {
  const body = await response.json();
  throw new Error(`${body.error.code}: ${body.error.message}`);
}
const { data, hasNext, total_count } = await response.json();
```

단건은 `{ data, meta: { requestId } }`, 목록은 `{ data: [], hasNext, total_count }`이며 204는 본문이 없다. 요청 ID는 `X-Request-Id`에도 제공한다. `total_count`는 같은 검색·필터의 전체 결과 수이고 페이지 크기·현재 배열 길이가 아니다. offset이 결과 수를 넘으면 data는 비어도 total_count는 유지한다.

| 응답                                    | 화면 처리                                              |
| --------------------------------------- | ------------------------------------------------------ |
| 400 INVALID_REQUEST                     | 입력·알 수 없는 필드·제거한 필터 확인                  |
| 401                                     | 로그인·세션 만료 처리                                  |
| 403                                     | 역할·Origin·접근 범위 확인                             |
| 404                                     | 삭제·만료·미존재 가능. 목록/선택 상태 재조회           |
| 409 VERSION_CONFLICT                    | 최신 상세·버전/초안을 다시 읽고 사용자 변경과 비교     |
| 409 INVALID_STATE / REQUEST_IN_PROGRESS | 업무 상태·잠금 처리 중. 중복 변경을 자동 생성하지 않음 |
| 422                                     | 상세 업무 검증 메시지 표시                             |
| 503                                     | 연결 장애 표시·재시도. 빈 목록·0건으로 대체하지 않음   |

## 2. 이번에 반드시 제거하거나 바꿀 계약

| 이전 코드                                        | 현재 처리                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 요청·응답 주소의 latitude / longitude            | 필드 자체 제거. null도 보내지 않음. 전송 시 400                                     |
| 통화 `analysis.result`, `?result=...`            | 제거. 여러 요약 값으로 동시에 표시                                                  |
| 통화 기본 정보 `endReason`, `handoff`            | 목록 각 항목·상세 data.call에서 제거                                                |
| 통화 필터 `endReason`, `handoffStatus`           | 제거. 전달하면 400                                                                  |
| `/api/admins/{id}/role`                          | 제거. `PATCH /api/admins/{id}`에 role 전달                                          |
| `GET /api/ai/faqs/{id}`                          | 제거. AI는 목록의 faqEntrySeqs 사용. 프론트 관리자 상세는 `GET /api/faqs/{id}` 유지 |
| `GET /api/recordings/{id}/url`                   | 제공하지 않음. 통화 상세의 recordings 사용                                          |
| `PUT /api/personas/{id}/head`                    | 제공하지 않음. 초안 저장 → versions 확정 → activate                                 |
| 고객 확인 응답 `companyPins` 기반 기업 주소 검색 | 호환 배열은 빈 값. `GET /api/companies/search` 사용                                 |

확인한 `develop-fe`에는 `frontend/src/features/call/api/callDto.ts`, `callDto.test.ts`, `frontend/src/mocks/handlers/calls.ts`에 예전 result/endReason/handoff 타입·mock이 남아 있다. 상세 변환의 `d.call.handoff` 참조도 제거·전환한다. 프론트 소스는 이번 BE 작업에서 수정하지 않았다.

## 3. 통화 목록·상세·스크립트

| API                                      | 역할                                                 |
| ---------------------------------------- | ---------------------------------------------------- |
| `GET /api/calls`                         | 통화당 한 행과 analysis, 검색·필터·pagination        |
| `GET /api/calls/{id}`                    | `{ call, analysis, recordings, aiActionCount }` 상세 |
| `GET /api/calls/{id}/transcript`         | 수신된 STT 발화 목록                                 |
| `GET /api/calls/{id}/actions`            | AI 동작 목록                                         |
| `GET /api/calls/{id}/processing-results` | 업무 처리 결과 목록                                  |

목록은 `q`, `orderSeq`, `orderStatus`, `callerPhoneNumber`, `from`, `to`, `hasComplaint`, `aiPersonaVersionSeq`, `limit`, `offset`을 사용한다. q는 고객 이름·발신번호 부분 검색, 날짜는 시간대 포함으로 from 포함·to 미포함이다. 종료 사유·대표 분류 필터는 없다. `hasHandoffRequest`를 새 목록 필터로 보내지 않는다. 응답 요약 표시용 값이다.

기본 정보는 `callSessionSeq`, `providerCallId`, `callerPhoneNumber`, `customerSeq`, `customerName`, `orderSeq`, `orderStatus`, `orderTotalAmount`, `startedAt`, `endedAt`이다. 주문이 없는 통화의 주문 값은 null이다. 목록에서는 analysis가 각 항목 안에 있고, 상세에서는 data.analysis에 별도로 있다.

### 통화 요약 표시

```json
{
  "aiPersonaVersionSeq": 7,
  "personaName": "친절형",
  "personaVersion": 2,
  "isNewCustomer": false,
  "registeredParcelCount": 3,
  "faqAnswerCount": 2,
  "orderLookupCount": 1,
  "cancelledParcelCount": 1,
  "hasHandoffRequest": true,
  "hasCallbackRequest": true,
  "aiStartedAt": "2026-11-03T01:00:00.000Z",
  "aiEndedAt": "2026-11-03T01:03:40.000Z",
  "repeatQuestionCount": 0,
  "hasComplaint": false,
  "complaints": [],
  "analysedAt": "2026-11-03T01:03:41.000Z"
}
```

| 필드                       | 화면 의미                                                                       |
| -------------------------- | ------------------------------------------------------------------------------- |
| isNewCustomer              | true 신규 / false 기존 / null 미확인                                            |
| personaName·personaVersion | 실제 사용 버전의 표시 이름·번호. 현재 활성 설정으로 덮어쓰지 않음               |
| registeredParcelCount      | 접수 확정 배송 상세 수. 주문 하나에 상세 3개면 3건, 결제 대기 포함              |
| faqAnswerCount             | FAQ 답변 건수                                                                   |
| orderLookupCount           | **접수 조회** 안내 건수                                                         |
| cancelledParcelCount       | 취소 완료 배송 상세 수                                                          |
| hasHandoffRequest          | true 요청 있음 / false 요청 없음 / null 미확인. 실제 연결 성공·실패 상태가 아님 |
| hasCallbackRequest         | true 콜백 요청 / false 요청 없음 / null 미수집. 처리 완료 상태는 제공하지 않음 |

분석 미수신은 `analysis=null`, 과거 분석의 새 요약 미수집은 개별 필드 null이다. 건수 0·false를 빈 값으로 숨기거나 null을 0·false로 바꾸지 않는다. 한 통화가 접수·FAQ·조회·취소·연결 요구를 동시에 가질 수 있어 한 개 result 뱃지로 합치지 않는다. BE가 저장된 최종 AI 값을 보내므로 프론트에서 DB 쿼리·주문 상태로 다시 계산하지 않는다.

콜백은 기존 `GET /api/calls`의 `data[].analysis.hasCallbackRequest`, `GET /api/calls/{id}`의 `data.analysis.hasCallbackRequest`로 표시한다. 이름·번호는 기존 `customerName`·`callerPhoneNumber`를 사용하며 이름은 미등록/삭제 고객이면 null일 수 있다. 새 목록 필터나 콜백 완료 처리 API는 추가하지 않는다.

표시 시작 시각은 PBX 시작 → AI 시작 → 최초 수신 시각 순, 종료는 PBX 종료 → AI 종료 순이다. 모든 시각이 없으면 null이며 null만으로 진행 중이라고 판단하지 않는다. 불만 offsetSeconds는 정수 초 위치이며 지연 시간 값이 아니다. utteranceOrders에 해당하는 **실제 수신된 같은 통화 발화**만 강조한다.

### 녹취·이력 갱신

- 녹취 업로드를 기다리지 않고 통화·분석·이벤트를 먼저 보여준다. `recordings=[]`는 아직 녹취가 없다는 뜻이며 빈 통화/실패 판정이 아니다.
- 각 recordings 항목은 `recordingSeq`, `createdAt`, `url`, `expiresAt`, `playbackError`. URL은 최대 5분 유효하고 실패 항목만 url=null·NOT_FOUND/DEPENDENCY_UNAVAILABLE일 수 있다.
- 만료되면 통화 상세를 다시 조회한다. 정상 재생 중인 URL을 무조건 교체해 재생 위치를 초기화하지 않는다.
- 실시간 통화 수 SSE는 **숫자 전용**이다. 분석·발화·녹취 도착 알림으로 사용하지 않는다. 상세 열기/수동 갱신 및 진행·수집 중 화면의 기존 갱신 정책으로 해당 GET들을 다시 호출한다.

[통화 조회 상세](../../docs/api/calls.md) · [스크립트·이력 화면 갱신](../../docs/api/call-history-refresh-frontend.md) · [이벤트 조회](../../docs/api/call-events-read-spec.md)

## 4. 진행 통화 수 — GET + SSE

`GET /api/calls/active-count`는 `{ data: { activeCallCount, observedAt }, meta }`를 한 번 반환한다. `GET /api/calls/active-count/stream`은 관리자 쿠키로 연결하는 `text/event-stream`이다. 최초 연결·재연결에 현재값을 보내므로 stream 하나로 시작할 수 있다.

```javascript
const source = new EventSource('/api/calls/active-count/stream', {
  withCredentials: true,
});
source.addEventListener('active-call-count', (event) => {
  const snapshot = JSON.parse(event.data);
  // snapshot.activeCallCount, snapshot.observedAt을 화면 상태에 반영한다.
  // 이전 숫자에 +1/-1을 더하지 않는다.
});
source.addEventListener('session-expired', () => {
  source.close();
  // 로그인 화면/세션 만료 처리
});
source.addEventListener('stream-error', () => {
  // 연결 장애 표시. 기존 숫자를 0으로 바꾸지 않는다.
});
source.onerror = () => {
  // 브라우저 자동 재연결 상태 표시. 새 연결을 중복 생성하지 않는다.
};
// 화면 해제·로그아웃 시 source.close().
```

| 이벤트            | data·처리                                                                            |
| ----------------- | ------------------------------------------------------------------------------------ |
| active-call-count | `{ activeCallCount, observedAt }` 직접 객체. data/meta로 다시 감싸지 않음            |
| heartbeat         | `{ observedAt }` 마지막 DB 관측 시각. 통화 수 증감이나 목록 refresh 근거로 쓰지 않음 |
| session-expired   | `{ code: "UNAUTHORIZED" }` 후 연결 종료. 클라이언트도 close                          |
| stream-error      | `{ code: "DEPENDENCY_UNAVAILABLE" }` 후 종료. 장애 표시 후 재연결에서 현재값 수신    |

집계는 기능 도입 후 등록된 통화 중 PBX 종료 미확인 건이다. 전화번호 조회만 한 통화·미등록 무의미 통화·과거 미확인 통화는 제외한다. AI의 유효 통화 등록 → BE 저장·커밋 → DB 알림 → 서버 공유 COUNT → SSE 순서이며 PBX 종료 때 반대로 집계에서 빠진다. 프론트가 POST로 수를 올리거나 내리지 않는다.

일반적으로 약 100~200ms 변경을 묶고 100건 초과 또는 힌트 10건 이상이면 약 1초 간격으로 최신값을 보낸다. 모든 중간 숫자의 전달을 보장하지 않는다. 5초 재확인·heartbeat가 있으며 세션 만료/로그아웃 반영에는 약 5초와 처리 시간이 걸릴 수 있다. 웹훅 누락·모호한 매칭을 임의 통화 종료로 처리하지 않는다.

양쪽 nginx의 SSE 버퍼링·타임아웃·쿠키 전달 설정이 실제 서버에 반영되어 있어야 한다. 코드 반영·로컬 HTTPS 검증과 운영 reload 여부는 다르다. [전체 SSE 계약](active-call-count.md)

## 5. 주문 목록·결제·접수 실패

`pickupRequestedAt`은 AI/관리자가 정한 요청 시각을 결제 대기 중에도 반환한다. 요청 시각까지 결제하면 유지하고, 이후 결제 또는 미전송이면 결제 완료 + 1시간을 한국시간 09:00~17:00으로 조정한다(09시 이전은 당일 09시, 17시 초과는 다음날 09시). 프론트는 저장된 응답을 표시하며 별도로 시각을 재계산하지 않는다. 관리자 고객 기본 주소/PIN 수정은 기존 세션·Origin을 사용하고 통화 헤더가 필요 없다.

화면용 목록은 `GET /api/admin/orders`, 일반 상세는 `GET /api/orders/{id}`다. 관리자 수기는 `POST /api/admin/orders`, 수정은 `PATCH /api/orders/{id}`이며 경로별 DTO·expectedVersion을 따른다. 결제 알림 재발송·결제 진행은 [결제 API](../../docs/api/order-payment-integration.md)를 사용한다. 클라이언트의 결제 성공 화면만으로 주문을 완료 처리하지 않는다.

| 실제 status       | 표시                          |
| ----------------- | ----------------------------- |
| COLLECTING        | 정보 수집/미완료              |
| notPaid           | 카드 결제 대기                |
| PAID              | 결제·정산 완료, 디버 접수 전  |
| SUBMITTING        | 디버 접수 요청 중             |
| SUBMITTING_FAILED | 자동 재시도 중 실패           |
| ACCEPTED          | 디버 접수 완료                |
| SUBMISSION_FAILED | 자동 재시도 종료, 담당자 확인 |
| CANCELLED         | 취소                          |

화면 목록의 query는 `statusGroup`이다. `PAID` 탭은 PAID·SUBMITTING·ACCEPTED, `SUBMISSION_FAILED` 탭은 SUBMITTING_FAILED·SUBMISSION_FAILED를 포함한다. 그룹명과 각 행의 실제 status를 구분한다. 일반 주문 조회의 `status` 필터와도 섞지 않는다.

디버 요청은 최대 10초, 첫 전송부터 10분 동안 최소 1분 간격으로 BE가 자동 재시도한다. 프론트의 refresh·재호출은 이 기한을 연장하지 않는다. 자동 재시도 중 매분 수동 API를 반복 호출하지 않는다. 명시적 재시도 버튼은 `POST /api/admin/orders/{id}/retry`이며 현재 상태를 재조회하고 409·처리 중을 구분한다. 수동 재시도도 자동 기한을 새로 열지 않는다. ACCEPTED만 접수 성공이다.

미선택 결제수단은 null로 표시하고 카드로 미리 선택하지 않는다. 최종 접수에는 billing/credit/groupBilling 선택이 필요하다. 수거 시각은 결제 완료 + 1시간으로 BE가 결정한다. AI의 NO_ORDER는 통화는 있지만 주문이 없는 상태여서 주문 목록에 가짜 행을 추가하지 않는다.

취소는 기존 POST cancel/parcels/cancel을 사용하며 일부 취소는 `{ "orderParcelSeqs": [34] }` 배열이다. DELETE와 구분한다. [화면 목록](../../docs/api/admin-order-list.md) · [수기](../../docs/api/manual-orders.md) · [재시도](order-submission-retry.md)

## 6. Soft delete와 보관

BE가 삭제·만료 조건을 적용하므로 프론트는 DB에 직접 쿼리하거나 deletedAt 조건을 작성하지 않는다. 삭제 후 목록·total_count·상세를 재조회한다. 삭제 상태나 만료된 데이터를 프론트 캐시로 다시 노출하지 않는다.

| API                                     | 조건·영향                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `DELETE /api/orders/{id}`               | 관리자, 본문 없음. COLLECTING/CANCELLED/ACCEPTED 중 진행 통화·승인·안내 발송 등 차단 조건이 없을 때 숨김. 결제 취소·청구 금액 변경 아님 |
| `DELETE /api/calls/{id}`                | 관리자, 본문 없음. PBX 종료 확인 + 연결 녹취 저장 완료 후 숨김. 주문은 보존                                                             |
| `DELETE /api/admins/{id}`               | SYSTEM_ADMIN만 OPERATOR/SUPERVISOR 삭제, 대상 세션 즉시 폐기. SYSTEM_ADMIN 삭제 금지                                                    |
| `DELETE /api/companies/{id}`            | 기업·부서·소속·기업 PIN을 함께 숨김                                                                                                     |
| `DELETE /api/departments/{id}`          | 부서·그 소속·해당 기업 PIN을 숨김                                                                                                       |
| `DELETE /api/members/{id}`              | 소속만 숨김. 고객 보존                                                                                                                  |
| `DELETE /api/faqs`                      | `{ faqEntrySeqs: [...] }`. 원문 보관, AI DELETE 알림                                                                                    |
| `DELETE /api/unanswered-questions/{id}` | OPEN 삭제, DELETED 재호출 204, REGISTERED 409                                                                                           |

신규 주문·통화 DELETE는 성공 204, 이미 삭제/미존재/만료면 404, 진행 상태 409 INVALID_STATE, 잠금 경합 409 REQUEST_IN_PROGRESS다. notPaid는 취소를 먼저 처리하고 PAID·SUBMITTING·중간/최종 접수 실패는 결제·접수 결과부터 확인한다. 녹취 RECEIVED/FAILED/업로드 중에는 통화 DELETE가 409다. 발급된 URL은 기존 최대 5분 만료까지 유효할 수 있다.

통화·녹취·STT·AI 이벤트·분석은 최초 수신부터 5년, 주문은 최초 완료/취소(미완료 생성)부터 5년이다. 삭제 시점부터 5년을 다시 세지 않는다. 삭제한 기준 정보는 삭제일부터 5년, 감사 로그·전송 완료 FAQ 알림은 7일 보관한다. AI 이벤트는 로그 7일 삭제 대상이 아니다. 복원·고객/PIN 삭제 API는 새로 제공하지 않는다. [정책·오류 상세](data-retention-handoff.md)

## 7. 관리자·FAQ·페르소나 변경

### 관리자

`PATCH /api/admins/{id}`에 `{ "role": "SUPERVISOR" }`를 보내 권한을 바꾼다. role 생략 시 기존 권한, status 생략 시 기존 상태를 유지한다. role/status 중 하나 이상 필요하며 SYSTEM_ADMIN 승격·SYSTEM_ADMIN 대상 변경은 허용하지 않는다. 비활성화·삭제·비밀번호 변경의 세션 종료 동작을 유지한다.

### FAQ·미답변

관리자 목록·상세는 `GET /api/faqs`, `GET /api/faqs/{id}`. 생성은 `POST /api/faqs`의 `{ items: [{ category, question, answer }] }`, 수정은 `PATCH /api/faqs/{id}`에 category·question·answer 모두 전달한다. 생성·수정·삭제 성공은 204라서 JSON을 파싱하지 않는다. 단건 생성의 Location으로 상세를 조회할 수 있다. 분류의 ‘전체’는 필터 생략이며 저장값이 아니다.

052의 [FAQ 고객 질문 사례](faq-question-examples-frontend-integration.md)는 관리자 상세의 `recentQuestions` 배열로 최대 10개를 제공한다. 동일 문장도 별도 표시하고 사례 번호를 렌더링 key로 사용한다. 통화 삭제와 독립적으로 응대 발생부터 5년까지 보관하며 FAQ 실제 수정·삭제 시 비운다. 목록 응답은 유지한다. 통화 `/processing-results`에는 사용 FAQ 번호 전체인 `faqEntrySeqs`도 추가되며 복수 FAQ일 때 기존 `faqEntrySeq`는 null이다.

미답변 목록은 `GET /api/unanswered-questions`, FAQ 전환은 `POST /api/unanswered-questions/{id}/faqs`에 category·question·answer. 성공 204 후 Location의 FAQ와 미답변 목록을 재조회한다. 변경은 FAQ·감사·AI 알림과 같은 트랜잭션이다. [관리 상세](../../docs/api/unanswered-questions-management.md)

각 미답변의 `reason`은 `KB_NO_ANSWER`(근거 부족), `KB_UNAVAILABLE`(검색 장애), null(미분류)다. reason 생략은 전체 사유, 두 코드로 필터, `reason=UNCLASSIFIED`는 null만 조회한다. 기본 `status=OPEN`은 유지하고 전체 발생 집계는 `status=ALL&reason=...`의 `total_count`를 사용한다. ALL은 OPEN·REGISTERED만 포함하며 DELETED·삭제/보관 만료 통화는 제외한다. 기간은 기존 통화 시작 기준이고 같은 질문도 다른 eventId면 별도 건수다. 통화 처리 결과의 `unansweredReason`도 표시할 수 있으며 삭제한 미답변은 null이다. 기존 앱의 사유 없는 데이터도 정상으로 표시한다. [사유 계약](unanswered-question-reasons.md)

### 페르소나

| 동작           | API·화면 처리                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 목록·상세·이력 | `GET /api/personas`, `GET /api/personas/{id}`, `GET /api/personas/{id}/versions`. 세 활성 역할 조회 허용                                          |
| 초안 저장      | `PATCH /api/personas/{id}`에 expectedVersion, expectedDraftRevision, 변경 설정. 초안 없으면 revision=null, 있으면 조회한 UUID. 200의 draft를 저장 |
| HEAD 확정      | `POST /api/personas/{id}/versions`에 최신 expectedVersion·expectedDraftRevision. 200. 같은 내용이면 버전 증가 없이 초안 삭제 가능                 |
| publish        | `POST /api/personas/{id}/activate`에 확인한 HEAD의 aiPersonaVersionSeq·expectedVersion 둘 다 전달. 보통 202 PENDING, 이미 같은 버전 ACTIVE면 200  |
| 옵션           | `GET /api/ai/options`의 실제 voices·속도 범위·말끝 대기 옵션 사용. 의존성 장애는 503                                                              |

예를 들어 상세에서 확인한 `headVersion.aiPersonaVersionSeq=7`, `headVersion.version=2`를 publish할 때의 본문이다. 유형 ID인 경로 `{id}`와 버전 ID 7을 혼동하지 않는다.

```json
{ "aiPersonaVersionSeq": 7, "expectedVersion": 2 }
```

저장·HEAD 확정·실제 통화 적용을 버튼·상태에서 구분한다. 초안 저장·HEAD 확정은 진행 통화나 ACTIVE를 바꾸지 않는다. AI가 확인해야 ACTIVE이며 HTTP 202·refresh 전송만으로 적용 성공을 표시하지 않는다. 진행 통화는 기존 버전, 다음 통화는 새 기본 버전이다. [필수 입력·응답 예시](persona-head-management.md)

## 8. 전달·화면 검증 항목

1. call DTO·mock·변환에서 result/endReason/handoff 제거, 요약 null/0/false 표시 확인.
2. 좌표 제거, 신규/기존 T/F, ‘접수 조회’, 결제 대기 포함 배송 상세 건수 표시 확인.
3. SSE 최초값·0건·재연결·로그아웃·장애 상태, 화면 해제 시 연결 정리 확인.
4. 미완료·결제 대기·접수 중간 실패·최종 실패·완료·NO_ORDER 구분 확인.
5. DELETE와 결제 취소 분리, 204 본문 처리, 삭제 후 목록·총건수·상세 갱신 확인.
6. 녹취 없는 통화 표시·늦은 녹취/발화 갱신·유효 재생 URL 보존 확인.
7. 관리자 role API 통합, FAQ 필수 3필드·204, 페르소나 초안/HEAD/publish 분리 확인.
8. BE 로컬 회귀 결과와 실제 프론트 화면·도메인 CORS·운영 nginx 적용 확인을 구분.
