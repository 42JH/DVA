# 프론트 QA 반영 API — S15P31D109-174

공용 주문·주소·PIN·AI FAQ 12개는 [이번 인증 전환 전용 명세](shared-api-auth-handoff.md)를 따른다. 관리자는 기존 세션을 사용하고 AI만 기존 AI_BUSINESS_TOKEN의 Bearer를 추가한다.

2026-11-09 최신 페르소나·전화번호 검색·고객/주소록 삭제의 전체 검증과 운영 데이터 이관 결과는 [QA 검증 기록](persona-prompt-fields-verification.md)을 따른다. 전체 911개가 통과했고 페르소나 데이터는 삭제 없이 이관했다. 새 API 사용에는 앱 배포가 필요하다.

관리자 주소록 단건·다건 soft delete는 [DELETE /api/pins 연동 명세](personal-pin-bulk-deletion.md)를 따른다. personalPinSeqs 배열로 요청하며 고객 기본 주소·주문 주소는 보존한다.

관리자 고객 단건·다건 soft delete는 [DELETE /api/customers 연동 명세](customer-bulk-deletion.md)를 따른다. customerSeqs 배열로 요청하며 전체 성공 204, 일부 미존재·기삭제는 전체 롤백 후 404다.

2026-11-09 추가: [페르소나 6개 항목별 입력·조회와 기존 데이터 이관](persona-prompt-fields.md), [고객 전화번호 부분 검색](customer-phone-search.md)을 따른다. 기존 URL을 재사용하며 페르소나 생성·수정은 promptText 대신 개별 항목으로 전환한다.

2026-11-09 후속 작업 브랜치 `feature/complaint-draft-follow-up`에서는 [예약번호·통합 목록 명세](parcel-draft-order-reservation.md)를 적용한다. 전체에 INCOMPLETE 초안을 포함하고 draftSeq로 행을 구분한다. 아래 단계별 검증 건수는 해당 시점의 이력이며 최신 검증은 [후속 기록](complaint-draft-follow-up.md)을 따른다. 운영 반영 전 057·058 migration과 프론트의 행 분기 적용이 필요하다.

backend 모놀리식의 관리자 세션을 사용한다. 쓰기에는 기존 허용 Origin이 필요하다. 기존 삭제·5년 보관·역할 기준을 유지한다. 프론트·AI·MSA·운영 배포는 별도다.

2026-11-09 통화 중 오집계 수정: GET /api/calls/active-count와 같은 SSE는 목록처럼 PBX 또는 AI 분석에 종료 시각이 있으면 진행 통화에서 제외한다. 기존 요청·응답·SSE 형식과 프론트·AI 호출 방식은 그대로다. PBX 종료 미수신 통화도 종료 분석이 저장되면 건수 변경을 알린다. [집계·정확 시각 매칭 기준](active-call-count.md)을 따른다.

2026-11-09 추가: 통화 목록·상세·홈 recentCalls의 analysisStatus에 EXPIRED를 추가한다. 정상 분석·최종 실패 통보 없이 PBX 종료 후 10분이 지나면 ‘분석 만료’로 표시한다. 시간만으로 완료 처리하지 않는다. [프론트 변경 지점과 상태 우선순위](call-analysis-status-frontend-integration.md), [미완료·고객명 조사 결과](analysis-expiry-and-draft-findings-20261109.md)를 함께 전달한다.

수기 주문과 관리자 초안 최종 접수는 수령인을 주문 고객의 개인 PIN에 자동 등록하고 기존 활성 중복은 보존한다. 요청·응답 변경이나 프론트의 추가 PIN POST는 없다. [수기 PIN 저장 기준](manual-order-recipient-pins.md)과 [운영 미완료 상세 현황](incomplete-draft-current-state-20261109.md)을 확인한다.

최신 확정 정책: 미완료는 원본 최초 생성부터 24시간 또는 같은 고객의 더 최신 통화가 종료·결과 확정되면 유예 없이 제외한다. FAQ·조회·NO_ORDER도 포함하며 시작 중인 통화는 제외한다. 만료는 목록·건수에서 빠지고 상세·재개·보완·접수는 기존 404로 처리한다. [만료·이어가기·연동 명세](incomplete-expiry-latest-call.md)를 우선하며 전체 배포 전 057~059를 적용한다.

## 1. 주문 탭 건수

`GET /api/admin/orders`의 기존 `data`, `hasNext`, `total_count`를 유지하고 `statusCounts`를 추가한다. 검색 `q`, 생성 기간 `from`(포함)·`to`(미포함), 현재 소속 `organizationSeq`는 집계에도 적용한다. 선택한 `statusGroup`, `limit`, `offset`은 탭별 건수에 적용하지 않는다. 목록과 모든 건수는 같은 읽기 전용 DB 스냅샷에서 조회한다.

| statusCounts 필드 | 대상 |
| --- | --- |
| all | 조회 가능한 실제 주문 + INCOMPLETE 초안. 이관 원본 중복 제외 |
| incomplete | INCOMPLETE 배송 초안. 원본 주문·고객·통화 삭제와 독립적인 초안 보관 기준 적용 |
| notPaid | 결제 대기 주문 |
| paid | PAID·SUBMITTING·SUBMITTING_FAILED 주문 |
| accepted | ACCEPTED 주문 |
| submissionFailed | SUBMISSION_FAILED 주문 |
| cancelled | CANCELLED 주문 |

`all`에 `incomplete`가 이미 포함되므로 두 값을 다시 더하지 않는다. `GET /api/admin/orders?statusGroup=COLLECTING`은 INCOMPLETE 초안만 조회하며 기존 단독 초안 목록도 유지한다. 통합 목록의 초안 행은 `draftSeq`가 있고 `orderSeq`가 예약번호다. 실제 주문 행은 `draftSeq=null`이다. 초안 상세·생성·수정 응답에는 별도 `reservedOrderSeq`를 제공한다.

상태 그룹은 COLLECTING·notPaid·PAID·ACCEPTED·SUBMISSION_FAILED·CANCELLED의 6개다. 접수 완료 탭은 `statusGroup=ACCEPTED`·`statusCounts.accepted`를 사용한다. 자동 접수 재시도는 PAID 그룹으로 이동했으며 홈의 `pendingWork.submissionFailed`도 최종 실패만 집계한다. [변경 명세](order-status-groups.md)를 따른다.

초안 목록에도 같은 `from`·`to`·`organizationSeq` 필터를 추가했다. 날짜는 초안 생성 시각 기준이며 시간대가 필요하다. 검색은 NFC·앞뒤 공백 제거 후 최대 200자이며 전화번호의 하이픈을 허용한다. 기존 AI 통화/고객 범위 검사는 유지한다. 미완료 숫자에서 이동할 때 같은 검색·기간·기업 조건을 전달한다.

검색·기간·기업 범위에 실제 주문과 미완료 초안이 모두 없으면 모든 집계가 0이다. 선택 탭이 비었거나 페이지 범위를 벗어나 `data=[]`여도 다른 탭의 건수는 유지한다. 기존 PAID·SUBMISSION_FAILED 필터의 범위가 바뀌므로 프론트는 새 ACCEPTED 탭과 건수 연결을 함께 적용한다.

### 1단계 검증

2026-11-08 격리 PostgreSQL 17·전체 migration 적용 환경에서 신규 집계 5개와 기존 주문·현재 기업 소속·초안 경로를 포함한 HTTP 통합 테스트 131개가 통과했다. 상태 그룹·페이지 범위·검색·기간·기업 조건, 이관 중복·삭제·보관 만료 제외, 별도 연결의 동시 추가 시 스냅샷 일치, 관리자 역할·AI 거절·Swagger 계약을 확인했다. Docker checks의 컴파일·lint·format과 단위 테스트 194개·결제 모듈 21개도 통과했다. 운영 DB·배포·프론트 화면은 검증 대상이 아니다.

## 2. 홈 조회

`GET /api/dashboard/home`은 관리자 3개 역할에 `{data,meta}`로 제공한다. 별도 필터 없이 오늘 건수와 전체 보관 기간의 처리할 일·미리보기·AI 통계를 제공하며 `data.observedAt`은 DB 트랜잭션 시작 시각이다. 모든 영역을 하나의 읽기 전용 REPEATABLE READ 스냅샷에서 조회한다.

- `pendingWork`: `incomplete`(INCOMPLETE 초안), `notPaid`(결제 대기), `submissionFailed`(두 실패 상태), `unansweredQuestions`(OPEN 질문 발생 수). 해당 목록의 기본 조건과 같다. 서로 다른 단위이므로 합산하지 않는다.
- `todayOrderCount`: observedAt의 한국시간 날짜에 생성된 실제 주문 수. 해당 날짜의 00:00 이상·다음 날 00:00 미만이며 기존 주문 목록과 같은 삭제·보관·이관 중복 제외를 적용한다. 취소 주문도 생성 건수에 포함하며 미완료 배송 초안을 더하지 않는다.
- `todayCallCount`: 같은 한국시간 날짜에 시작된 통화 수. 기존 통화 목록처럼 PBX 시작 → AI 시작 → 수신 시각을 사용한다. 삭제·보관 만료는 제외하며 진행 중 통화도 기준 시각이 오늘이면 포함한다.
- `recentCalls`: 기존 `/api/calls?limit=11`와 같은 최신순 미리보기. `callSessionSeq`로 상세에 이동한다.
- `incompleteDrafts`: 기존 `/api/parcel-drafts?status=INCOMPLETE&limit=11`와 같은 최신순. `draftSeq`로 초안 상세에 이동한다. 원본 고객·통화 삭제와 독립적인 보관 기준을 유지하고 creationPayload는 공개하지 않는다.
- `unansweredQuestions`: 기존 `/api/unanswered-questions?status=OPEN&limit=11`와 같은 오래된 통화 우선. `callSessionSeq`로 질문이 나온 통화에 이동한다.
- `aiPerformance`: `stageDropoffs`, `registrationTime`, `complaintCalls`, `responseWait`. 기존 대시보드 4개 API의 `customerType=ALL` 응답 data와 동일하다. 미측정/null과 0, 현재·직전 활성 버전 비교 기준도 유지한다.

2026-11-09 최종 화면 반영에서 오늘 건수 두 필드를 추가하고 미리보기 상한을 5개에서 11개로 늘렸다. 오늘 건수만 날짜 범위를 적용하며 처리할 일·미리보기·AI 통계는 기존 전체 보관 기간 기준을 유지한다. 빈 영역은 빈 배열·0건, 측정이 없는 비율·평균은 기존 통계처럼 null이다. UI는 반환된 배열에서 필요한 줄만 표시할 수 있다. 녹취 URL 발급이나 외부 AI 호출은 하지 않으며 추가 migration·환경변수는 없다. 아래 2단계 검증은 최초 5개 구현 시점의 기록이고 이번 검증은 [후속 기록](final-wireframe-follow-up.md)을 따른다.

### 2단계 검증

2026-11-08 격리 PostgreSQL·HTTP에서 신규 홈 4개와 기존 대시보드·통화·미답변·주문 집계를 포함한 통합 테스트 58개가 통과했다. 기존 API와 전체 값·정렬·최대 5개·전체 건수 일치, 빈/미측정 기준, 삭제·만료·상태 제외, 권한·Swagger와 동시 추가 시 건수/미리보기 스냅샷 일치를 확인했다. DB의 read_only=on·repeatable read도 실제 조회했다. 컴파일·lint·format·단위 194개·결제 21개가 통과했다. 운영 부하·실제 UI 호출은 미검증이다.

## 3. 기업 단건·다건 삭제

`DELETE /api/companies`에 JSON `{ "organizationSeqs": [123, 124] }`를 보낸다. 1개도 배열로 전달하며 1~100개의 중복 없는 양의 32비트 정수만 받는다. 문자열 숫자·빈 배열·추가 필드는 400이다. 기존 `DELETE /api/companies/{id}`도 유지하며 같은 삭제 로직을 사용한다.

성공은 204·빈 본문이다. 모든 대상이 조회 가능한 기업이어야 하며 미존재·이미 삭제된 항목이 하나라도 있으면 404와 전체 롤백이다. 감사 기록 실패도 전체 롤백, 잠금 충돌·시간 초과는 기존 409 `REQUEST_IN_PROGRESS`이므로 이후 재시도한다. 회원 변경 공통 잠금 후 대상 전체의 고객 번호순, 기업 번호순으로 잠근다.

기존 기업·부서·소속 soft delete와 기업별 성공 감사 기록을 유지한다. 개인 고객·개인 PIN·주문·통화·녹취·과거 청구와 5년 보관 기준을 유지한다. 모든 활성 관리자 역할에 허용하고 관리자 세션·허용 Origin이 필요하다. 추가 migration·환경변수는 없다.

### 3단계 검증

2026-11-08 격리 PostgreSQL·HTTP에서 신규 배열 삭제 8개와 기존 기업·부서 삭제·사원·기업 청구 요약을 포함한 통합 테스트 57개가 통과했다. 단건 배열·다건·상한 100개, 입력 검증·역할·세션·Origin, 미존재/기삭제·두 번째 기업 감사 실패 시 전체 롤백, 이후 대상 고객의 잠금 충돌·해제 후 재시도, 겹치는 역순 배열의 동시 삭제를 확인했다. 개인 고객·주문·통화 원본과 성공 감사의 대상·담당자도 대조했다. 컴파일·lint·format·단위 194개·결제 21개가 통과했다.

## 최종 전체 검증

2026-11-08 최종 코드에서 공식 `node backend/scripts/check.cjs`가 종료 코드 0으로 통과했다.

- 컴파일·ESLint·Prettier, 단위 194개·결제 모듈 21개 통과.
- PostgreSQL 17의 전체 migration·HTTP 통합 855개 통과.
- 운영 이미지와 실제 Nginx·개발 프록시·HTTPS·PBX·인증·SSE 런타임 23개 통과. 새 주문 집계 계약, 홈 조회와 배열 삭제도 실제 프록시를 거쳐 확인했다.
- 합계 1,093개, 실패·건너뜀 0개. 임시 DB·컨테이너·네트워크는 검증 스크립트가 정리했다.

최초 전체 실행의 런타임 실패 2개는 추가된 statusCounts 기대값 누락과 신규 집계 fixture의 미래 시각 부분 주문을 기존 주소 이력 검사가 선택한 문제였다. 기대값을 정확한 새 계약으로 갱신하고 신규 집계·홈 fixture를 종료 후 조회 대상에서 정리했다. 업무 코드를 바꾸거나 검사를 완화하지 않았고 위 최종 전체 실행에서 두 경로를 포함해 다시 통과했다.

운영 DB·실제 프론트 화면·외부 AI/결제/디버 실서비스·운영 부하·배포·원격 CI는 미검증이다. 추가 migration·환경변수·데이터 보정은 없다. MR 대상은 develop-backend이며 생성 전 사용자 보고 단계에서 멈춘다.

후속 조회 성능 개선은 [기존 결과 비교·계획·측정·검증 기록](api-performance-optimization.md)을 따른다. 위 1,093개는 최초 기능 3건 시점의 기록이며, 후속 최적화와 최신 CI 병합 검증은 별도 기록을 확인한다. 공개 응답·페이지·건수·권한·오류·보관 기준과 위 프론트 연동 계약은 유지한다.

## 4. 최종 화면의 주문·미답변 연결 기준 — 2026-11-09

최신 develop-backend `5d3bd189`와 최종 화면을 다시 대조하고 다음 기준을 확정했다. 이 절은 기존 API의 사용 방법을 명확히 하며 주문 생성·집계·미답변 수집 계약을 변경하지 않는다.

### 주문 전체와 미완료

055 이후 실제 주문과 미완료 배송 단건은 별도 리소스다. 한 통화에서 배송 3개 중 2개를 완성하면 실제 주문 1건(배송상세 2개)과 미완료 초안 1건이 남는다. 후속 통합 목록의 all은 두 행을 포함한 2건이고 incomplete는 그중 1건이다. `statusCounts.all + statusCounts.incomplete`로 다시 더하지 않는다.

- 전체·결제·접수 실패·취소 탭은 `GET /api/admin/orders`를 사용한다. 전체의 draftSeq가 있는 행은 초안 상세로 분기한다.
- 미완료 탭은 같은 API의 `statusGroup=COLLECTING` 또는 단독 초안 목록을 사용한다. 검색·기간·기업 조건은 같은 값으로 전달한다.
- 미완료 번호는 reservedOrderSeq로 표시한다. 통합 행의 orderSeq도 이 예약번호이므로 draftSeq가 있으면 실제 주문 상세 API로 이동하지 않는다. 단독 초안 응답의 orderSeq는 변환된 실제 주문 참조이며 그전에는 null이다.
- 미완료 보완은 [055 프론트 명세](parcel-draft-frontend-integration.md)의 원본 재개 → 새 초안 보완 → 관리자 접수 흐름을 따른다. 이관 원본 주문을 다시 접수하지 않는다.

### 미답변 질문에서 통화 열기

1. AI는 기존 `POST /api/ai/unanswered-questions`에 질문 원문·통화 번호·발생 시각·`offsetSeconds`를 전송한다. 위치를 모르면 명시적으로 null을 전송한다.
2. 프론트는 `GET /api/unanswered-questions`에서 `unansweredQuestionSeq`, `callSessionSeq`, `questionText`, `offsetSeconds`를 받는다.
3. `callSessionSeq`로 기존 `GET /api/calls/{id}`와 `GET /api/calls/{id}/transcript`를 조회한다. AI 동작·처리 결과는 기존 `/actions`, `/processing-results`를 조회한다. 긴 대화는 기존 limit·offset 페이지를 이어 읽는다.
4. 시간·원문 대조는 해당 발화의 후보를 찾는 데 사용할 수 있지만, 미답변 질문과 특정 발화의 직접 연결을 보장하지 않는다. 같은 질문 반복·위치 null·발화 미수집으로 특정할 수 없으면 통화는 열고 정확한 줄 강조는 생략한다. 위치 null을 00:00으로 대체하지 않는다.

미답변 응답에는 `utteranceOrder`나 `callUtteranceSeq`가 없다. 처리 결과의 `questionUtteranceOrder`·`answerUtteranceOrder`는 FAQ_ANSWERED 전용이며 QUESTION_UNANSWERED의 발화 연결로 사용하지 않는다. 이번 확정에서는 현행 API를 유지한다. 정확한 미답변 발화 연결·주변 발화 전용 조회는 별도 후속 범위로 남긴다. AI에 새로운 필드나 전송 변경은 요구하지 않는다.

후속 홈 화면·CI 변경과 단계별 검증은 [최종 화면 후속 작업 기록](final-wireframe-follow-up.md)을 따른다.
