# 프론트 전달 명세 — 목록 개선 1~5·수거 시간 6

작성일: 2026-11-08. 이번 요청 1~6번을 모은 **모놀리식 backend** 계약이다. 아래 예시 응답은 표시한 필드만 발췌한 경우를 명시했다. 기존 API 전체 계약을 대체하지 않는다.

백엔드와 프론트는 별도 작업 브랜치/MR이다. 백엔드 병합·배포 뒤 1~5번을 화면에 연결하고, 6번 수거 입력 변경은 프론트 MR을 배포한다. 문서 작성·MR 생성 자체가 배포를 뜻하지 않는다.

## 변경 목록

| 번호 | API/화면 | 변경 |
| --- | --- | --- |
| 1 | GET /api/calls | data[].analysisStatus, recordedAt 추가 |
| 1 | GET /api/calls/{id} | data.call.analysisStatus, recordedAt 추가 |
| 2 | GET /api/calls, GET /api/calls/{id} | 각각 data[], data.call에 organizationName 추가 |
| 2 | GET /api/admin/orders | data[].customerSeq, organizationName 추가 |
| 2 | GET /api/calls, GET /api/admin/orders | organizationSeq 조회 조건 추가 |
| 3 | GET /api/customers | data[].availablePaymentMethods 추가 |
| 4 | GET /api/companies/{id}/members | q 이름·사번·전화번호 검색 추가 |
| 5 | GET /api/admins | q 이름·로그인 아이디 검색 추가 |
| 6 | 수기 주문 추가·수정 화면 | 한국 시간 09:00~17:00 입력 검증·시각 변환. 추가 API/DB 없음 |

## 공통 호출·페이지네이션·오류

- 관리자 조회는 기존 관리자 세션 쿠키를 사용한다. 기존 프론트 API client를 재사용하고 분리된 출처에서 호출하면 기존 CORS·Origin·credentials 설정을 유지한다. AI 토큰으로 관리자 목록을 조회하지 않는다.
- 아래 목록의 limit 기본값은 20, 범위 1~100, offset 기본값은 0이다. 응답은 `{ data: [...], hasNext: boolean, total_count: number }`다. total_count는 같은 검색·필터의 페이지 적용 전 전체 건수다.
- 조회 조건을 바꾸면 offset을 0으로 초기화하고 조건을 query key에 포함한다. 목록 일부를 받은 뒤 화면에서만 검색해 전체 검색 결과로 취급하지 않는다.
- 상세는 기존 `{ data: {...}, meta: { requestId: "..." } }` 구조다. 목록에 meta를 새로 가정하지 않는다.
- 오류는 `{ error: { code, message, details: [{ field, reason }] }, meta: { requestId } }`다. 잘못된 쿼리/미허용 필드는 400, 세션 누락·만료는 401, 권한·Origin 제한은 403이다.

## 1. 통화 분석 상태·녹취 시각

목록과 상세 call에 같은 두 필드가 추가된다.

```ts
analysisStatus: 'PENDING' | 'COMPLETED' | 'FAILED'
recordedAt: string | null
```

| 상태 | 서버 판단 | 표시 예시 |
| --- | --- | --- |
| PENDING | 정상 분석도 최종 실패 통보도 없음 | 분석 대기 |
| COMPLETED | 정상 분석이 저장됨. 실패 기록보다 우선 | 분석 완료 |
| FAILED | 정상 분석 없이 AI의 최종 실패 통보 수신 | 분석 실패 |

```json
{
  "analysisStatus": "FAILED",
  "recordedAt": "2026-11-08T06:00:00.000Z"
}
```

위 JSON은 목록 한 항목 또는 상세 `data.call`의 추가 필드만 발췌했다. 기존 `analysis`와 `recordings` 등은 유지한다.

- 종료 후 5분 경과나 녹취 유무로 분석 실패를 추정하는 우회를 제거한다. 목록 상태 표시를 위해 통화마다 상세를 추가 호출하지 않는다.
- PENDING만으로 통화 중·분석 중·AI 재전송·알림 누락을 구별할 수 없다. 실패 통보가 안 오면 계속 PENDING이다.
- 실패 뒤 정상 분석이 저장되면 COMPLETED다. 정상 분석 후 늦은 실패 통보는 완료 상태를 내리지 않는다.
- `recordedAt`은 `recordings.created_at`의 최솟값, 즉 최초 녹취 참조가 **DB에 저장된 시각**이다. 실제 녹음·통화 시작 시각이 아니며 녹취가 없으면 null이다. ISO 8601 시각을 화면의 한국 시간으로 표시한다.
- `recordedAt`으로 파일 재생 가능 여부를 판단하지 않는다. 기존 recordings의 재생 URL·개별 오류 처리를 유지한다.
- 상태 필터·분석 재실행 API·신규 실시간 이벤트는 추가하지 않았다. 과거 미분석 건을 시간 경과로 일괄 FAILED 처리하지 않는다.

## 2. 통화·관리자 주문 목록의 기업/개인 구분

| API | 반환 필드 위치 |
| --- | --- |
| GET /api/calls | data[].organizationName. 기존 customerSeq 사용 |
| GET /api/calls/{id} | data.call.organizationName. 기존 customerSeq 사용 |
| GET /api/admin/orders | data[].organizationName, customerSeq |

```ts
organizationName: string | null
customerSeq: number | null
```

| 필드 값 | 화면 분류 |
| --- | --- |
| organizationName 있음 | 기업 고객 — 해당 기업명 표시 |
| organizationName null, customerSeq 있음 | 현재 기업 연결이 없는 고객 — 개인 고객 표시 |
| 둘 다 null | 고객 미확인 |

기업/개인 enum이나 boolean을 따로 추가하지 않는다. 결제 방식으로 기업 고객 여부를 판정하지 않는다.

기업명은 **현재 소속·현재 기업명**이다. 통화·주문 당시 기업이나 결제 기업 스냅샷이 아니다. 소속을 옮기거나 기업명을 바꾸면 과거 통화·주문 목록 표시도 바뀐다. 비활성 소속·기업은 표시하지만, 삭제되거나 연결이 없으면 null이다. 삭제된 고객은 customerSeq를 null로 반환하고 DB의 기존 논리 참조는 유지한다.

통화는 연결 주문의 고객 번호를 우선 사용하고 그 번호가 없으면 통화에 저장된 고객 번호를 사용한다. 관리자 주문 목록은 주문 고객 기준이다. 주문 수령인 이름을 고객 소속으로 해석하지 않는다.

### 기업 필터

```http
GET /api/calls?organizationSeq=12&limit=20&offset=0
GET /api/admin/orders?organizationSeq=12&limit=20&offset=0
```

- organizationSeq는 선택이며 1~2147483647 정수다. 다른 검색·상태·기간 조건과 AND로 적용한다.
- 없는/삭제된 기업 번호는 200과 빈 목록이다. 비활성 기업·소속은 기존 가시성대로 포함한다.
- 이 조건은 위 두 목록에만 추가됐다. 고객 목록이나 일반 `GET /api/orders`에 보내지 않는다.
- 관리자 주문 상세의 기존 응답을 새 목록 필드와 동일하다고 가정하지 않는다. 이번 신규 customerSeq·organizationName 추가 대상은 관리자 **목록**이다.

## 3. 고객 목록의 결제 가능 수단

```http
GET /api/customers?limit=20&offset=0
```

고객 목록 항목에 아래 배열이 추가된다. 기존 address·customerSeq·monthlyBillingEnabled·name·phoneNumber·status는 유지한다.

```json
{
  "customerSeq": 123,
  "availablePaymentMethods": ["billing", "credit", "groupBilling"]
}
```

위 JSON은 항목의 일부만 발췌했다. 배열은 null이 아니며 순서는 billing → credit → groupBilling이다. 가능한 항목만 포함한다.

| 코드 | 의미 |
| --- | --- |
| billing | 개인 카드 결제 |
| credit | 월결제 |
| groupBilling | 부서 그룹결제 |

판정은 기존 `POST /api/customers/context`와 같은 SQL 규칙이다.

- ACTIVE 고객은 billing을 포함한다.
- 삭제되지 않은 소속이 없고 개인 월결제 사용 가능이면 credit을 추가한다.
- 활성 소속·활성 기업이고 기업 월결제가 가능하면 credit을 추가한다.
- 활성 소속·활성 기업이고 같은 기업의 삭제되지 않은 부서에서 그룹결제가 가능하면 groupBilling을 추가한다. 기업 월결제 가능 여부와는 별개다.
- 비활성 소속·기업은 개인 월결제로 우회하지 않는다. 소속 행은 남았지만 기업만 삭제된 경우도 기존 context 규칙대로 기업 결제·개인 월결제 우회를 허용하지 않는다. 삭제된 소속은 소속 없음으로 취급한다.
- WITHDRAWN 고객은 빈 배열, 삭제된 고객은 목록에서 제외한다.

화면은 배열을 그대로 사용하고 고객별 context 추가 호출을 제거한다. monthlyBillingEnabled 하나만 보고 다시 계산하지 않는다. 이 값은 **조회 시점의 자격**이며 실제 과거 사용 수단이나 결제 보장이 아니다. 실제 주문·결제 시 서버가 다시 검증한다.

이번 필드 추가는 고객 **목록 전용**이다. 고객 상세·사원 목록의 중첩 customer·context.customer에도 같은 필드가 생겼다고 가정하지 않는다. context 최상위의 기존 availablePaymentMethods는 유지한다.

## 4. 기업 사원 목록 검색

```http
GET /api/companies/12/members?q=010-1234&status=ACTIVE&limit=20&offset=0
```

| 쿼리 | 규칙 |
| --- | --- |
| q | 선택, 이름 OR 사번 OR 전화번호 부분 검색 |
| status | 기존 ACTIVE / INACTIVE. 생략하면 둘 다 |
| limit / offset | 공통 페이지네이션 |

- q는 NFC 정규화·앞뒤 공백 제거 후 최대 100자다. 생략·빈 값·공백만 있으면 검색하지 않는다.
- 이름·사번은 대소문자 구분 없는 **검색어 전체의 연속 부분 일치**다. 초성 검색이나 단어별 분해 검색은 아니다. 사번의 선행 0을 유지한다.
- 숫자·하이픈으로 된 q는 전화번호의 하이픈을 무시하고 부분 검색한다. 예: 010-1234, 5678. 하이픈만 보내서 모든 전화번호를 조회하지 않는다.
- %, _, 따옴표는 일반 문자다. URLSearchParams로 인코딩한다. q 배열·중복 파라미터·객체·NUL·길이 초과는 400이다.
- 경로 기업 AND status AND q로 전체 데이터에서 검색한 후 페이지를 자른다. 소속 번호 내림차순이고 total_count도 같은 조건이다.
- 응답은 기존 data[].membership/customer 구조를 유지한다. 삭제된 소속·고객은 제외하고, 없는/삭제된 기업은 404다. 기존 비활성 기업·탈퇴 고객의 관리자 조회 규칙은 유지한다.
- 모든 ACTIVE 관리자 역할로 조회 가능하다. 기존 전체 사원 검색 `GET /api/companies/members/search`는 변경하지 않았다.

## 5. 관리자 목록 검색

```http
GET /api/admins?q=operator&role=OPERATOR&status=ACTIVE&limit=20&offset=0
```

- q로 이름 OR loginId를 대소문자 구분 없이 부분 검색한다. NFC·trim·최대 100자·빈 값·특수문자·400 기준은 위 기업 사원 검색과 같다. 전화번호 검색은 없다.
- role은 OPERATOR / SUPERVISOR / SYSTEM_ADMIN, status는 ACTIVE / PENDING / INACTIVE다. 생략한 조건은 제한하지 않고 서로 AND로 적용한다.
- 검색·권한·상태 조건을 전체 데이터에 적용한 후 페이지를 자른다. 관리자 번호 내림차순이며 삭제된 관리자는 제외한다.
- **ACTIVE SYSTEM_ADMIN 세션만** 조회 가능하다. OPERATOR·SUPERVISOR는 403이다.
- 기존 응답 필드 adminUserSeq·loginId·name·role·status·createdAt·lastLoginAt을 유지한다. 비밀번호 관련 필드를 반환하지 않는다.
- 이 검색의 대소문자 무시는 실제 로그인 아이디 비교 규칙을 바꾸지 않는다.

## 6. 수거 시간 — 프론트 별도 MR

수기 주문의 신규 입력·수거 시각 변경은 아래 조건을 **동시에** 만족해야 한다.

1. 한국 시간(Asia/Seoul) **09:00~17:00**, 양 끝 포함.
2. 현재 시각+1시간 이상, 현재 시각+72시간 이하.

분 단위 입력의 최소 시각은 올림·최대는 내림한다. 예: 현재 10:00:30이면 11:01부터, 3일 뒤 10:00까지 선택 가능하다. 여러 날에 걸친 HTML min/max만으로 매일의 야간 시간을 막을 수 없으므로 별도 시간 검사도 적용한다.

- 선택값은 기존처럼 비워둘 수 있다.
- 수정 화면에서 원래 수거 값을 그대로 두면 과거 시각·시간 범위 밖이어도 다른 항목을 저장할 수 있다. 기존 서버 원문 시각의 초도 유지한다.
- 창을 오래 열어 둔 경우 제출 버튼과 고객정보 추가 확인 응답 순간에 현재 시각으로 다시 검사한다.
- 주문의 표시·전송 변환을 KST로 맞춘다. 브라우저 시간대가 UTC여도 09:00 선택은 `00:00:00Z`로 전송한다. 다른 화면의 공통 날짜 함수는 변경하지 않는다.
- 별도 pickup API·새 DB 컬럼은 없다. 기존 주문 요청의 시간대 포함 pickupRequestedAt을 사용한다.

백엔드의 기존 결제 보정은 유지한다. 요청 시각이 결제 시각과 같거나 나중이면 그대로 유지한다. 요청이 이미 지났거나 없을 때 결제+1시간으로 보정하고 09:00 전은 당일 09:00, 17:00 초과는 다음 달력 날짜 09:00으로 맞춘다. 정확히 17:00은 허용한다. **AI가 보낸 시각을 새 프론트 제한으로 서버에서 일괄 거절하지 않는다.**

## 배포·확인 순서

1. 기존 백업·DB runner 절차로 migration **056** 적용 및 infra DB 검증. 신규 테이블 없이 call_sessions.analysis_failed_at nullable timestamptz 한 컬럼만 추가한다.
2. backend MR 배포. 기업명·결제수단·검색에는 추가 migration이나 새 환경변수가 없다.
3. AI가 분석 최종 실패 통보를 연결한다. AI 미구현/미전송 건은 PENDING으로 남는다.
4. 프론트 타입·API query·페이지네이션·화면을 1~5번에 연결하고, 6번 프론트 MR을 배포한다.
5. PENDING → FAILED → COMPLETED와 늦은 실패, 녹취 없는 통화, 기업/개인/고객 미확인, 소속 변경, 결제수단 빈 배열, 검색 후 다음 페이지, 09:00/17:00 및 늦은 결제 보정을 확인한다.

기존 soft delete·보관 만료 필터와 관리자 인증은 유지한다. 이번 backend는 모놀리식 대상이며 별도 MSA API/DB 동기화는 포함하지 않는다. AI 전달본: [AI 분석 실패·수거 시간 명세](list-improvements-ai-integration.md). 상세 DB 배포 절차: [056 배포 명세](call-analysis-status-rollout.md).
