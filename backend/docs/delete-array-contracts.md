# 모놀리식 DELETE API 단건·다건 통합 — 프론트 전달 명세

관리자 권한은 SYSTEM_ADMIN·OPERATOR 두 개이며 계정 관리 4개만 최상위 전용입니다. DELETE와 권한의 최신 통합 계약은 [프론트 전달 명세](frontend-delete-admin-roles.md)를 우선합니다.

모든 DELETE는 리소스별로 ID 배열을 받는 API 하나로 단건·다건을 처리합니다. 기존 배열형 5개는 그대로 두고, 기업의 중복 단건 경로를 제거하며 나머지 단건 전용 9개를 교체합니다. 병행 API를 추가하지 않습니다. 최종 DELETE는 14개이며 MSA는 이번 변경에 포함하지 않습니다.

## 전체 경로와 입력

아래 경로 앞에는 모두 `/api`가 붙습니다. 성공은 **204, 응답 본문 없음**입니다.

| 구분 | 기존 DELETE | 사용할 DELETE | JSON 본문 예시 |
| --- | --- | --- | --- |
| 관리자 | `/admins/{id}` | `/admins` | `{ "adminUserSeqs": [11, 12] }` |
| 통화 | `/calls/{id}` | `/calls` | `{ "callSessionSeqs": [11, 12] }` |
| 주문 | `/orders/{id}` | `/orders` | `{ "orderSeqs": [11, 12] }` |
| 배송 초안 | `/parcel-drafts/{id}` | `/parcel-drafts` | `{ "draftSeqs": [11, 12] }` |
| 기업 소속 해제 | `/members/{id}` | `/members` | `{ "membershipSeqs": [11, 12] }` |
| 부서 | `/departments/{id}` | `/departments` | `{ "departmentSeqs": [11, 12] }` |
| 미답변 질문 | `/unanswered-questions/{id}` | `/unanswered-questions` | `{ "unansweredQuestionSeqs": [11, 12] }` |
| 개인 카드 등록 해제 | `/customers/{id}/card` | `/customers/cards` | `{ "customerSeqs": [11, 12] }` |
| 기업 카드 등록 해제 | `/companies/{id}/group-card` | `/companies/group-cards` | `{ "organizationSeqs": [11, 12] }` |
| 기업 | `/companies` 및 `/companies/{id}` | `/companies` | `{ "organizationSeqs": [11, 12] }` |
| 고객 — 변경 없음 | `/customers` | `/customers` | `{ "customerSeqs": [11, 12] }` |
| 개인 주소록 — 변경 없음 | `/pins` | `/pins` | `{ "personalPinSeqs": [11, 12] }` |
| FAQ — 변경 없음 | `/faqs` | `/faqs` | `{ "faqEntrySeqs": [11, 12] }` |
| 페르소나 분류 — 변경 없음 | `/personas` | `/personas` | `{ "aiPersonaSeqs": [11, 12] }` |

단건도 `[11]`처럼 배열로 보냅니다. 기존 단건 전용 DELETE URL은 제거되어 **404**입니다. 같은 `{id}` 경로의 GET·PATCH·PUT, 등록/수정/결제/취소 API는 유지합니다. 카드 해제의 번호는 **고객/기업 번호**이며 paymentCardSeq가 아닙니다. 초안은 draftSeq, 소속 해제는 membershipSeq입니다.

## 공통 호출·검증

- `Content-Type: application/json`으로 본문을 보냅니다. 배열은 **1~100개**, 중복 없는 양의 int32 정수(1~2147483647)입니다. 문자열 숫자·null·빈 배열·중복·101개 이상·추가 필드는 400입니다.
- 관리자 세션 쿠키와 허용 Origin 규칙은 유지합니다. 브라우저 요청은 `credentials: 'include'`를 유지하며 Origin은 브라우저가 보냅니다.
- 한 요청은 하나의 트랜잭션입니다. 대상 하나의 미존재·보호 조건·권한·감사 저장 실패도 **전체 롤백**합니다. 성공한 행마다 기존 작업 코드와 같은 requestId로 감사 이력을 남깁니다. 비밀번호·주소·전화번호·카드 원문·빌링 키를 감사에 복사하지 않습니다.
- 보통 없는/이미 삭제된 대상은 404입니다. **미답변 질문은 이미 DELETED이면 204**, 카드 해제는 **해당 소유자가 존재하고 해제할 카드가 없으면 204**인 기존 규칙을 유지합니다. 소유자가 없으면 404입니다.
- 실패는 기존 `{ error: { code, message, details }, meta: { requestId } }` 형식입니다. 400 입력 오류, 401 로그인/AI 인증 오류, 403 권한/Origin/범위 오류, 404 대상 없음, 409 진행 중·보호 상태·잠금 경합 등입니다. 감사 저장 장애는 업무 변경도 롤백하며 기존 오류를 반환합니다.
- 204에는 `response.json()`을 호출하지 않습니다. 성공 후 선택 상태를 비우고 기존 목록을 재조회합니다. 실패 후에도 오래된 화면 상태를 기준으로 항목별 부분 성공을 추정하지 않습니다.

공통 프론트 클라이언트는 body 옵션을 지원합니다.

```ts
// 단건과 다건이 같은 함수입니다. api의 base URL에 /api가 포함됩니다.
export const deleteCompanies = (organizationSeqs: number[]): Promise<void> =>
  api.delete('/companies', { body: { organizationSeqs } })

// 기존 단건 함수 이름과 화면 호출을 유지하려면 이처럼 내부 요청만 전환합니다.
export const deleteCompany = (id: number): Promise<void> =>
  api.delete('/companies', { body: { organizationSeqs: [id] } })
```

## 권한·보호 조건 — 기존 유지

| 대상 | 권한·보호 조건 |
| --- | --- |
| 관리자 | SYSTEM_ADMIN 전용. OPERATOR만 삭제하며 SYSTEM_ADMIN이 한 명이라도 포함되면 전체 403. 삭제 대상의 세션도 함께 종료 |
| 페르소나 | OPERATOR·SYSTEM_ADMIN 전용. HEAD와 관계없이 실제 ACTIVE 버전이 있는 분류는 삭제 불가. 분류·전체 버전·초안을 함께 soft delete |
| 나머지 일반 업무 DELETE | 기존 활성 관리자 세션 권한 유지. AI 토큰만으로 사용할 수 없음 |
| 개인·기업 카드 해제 | 기존 활성 관리자 세션 또는 AI_BUSINESS_TOKEN Bearer 유지. AI는 기존 `call_session_seq` 헤더와 진행 중 본인 통화 범위가 필요하며 배열의 **모든 소유자**를 검사. 다른 고객/기업이 섞이면 전체 403. 관리자 권한을 AI 권한으로 교체하지 않음 |
| 통화 | 진행 통화·녹취 저장/대기·주문 확정 진행 중에는 삭제 불가 |
| 주문 | 기존 삭제 가능 상태만 허용. 진행 중 통화·결제·디버 접수가 있으면 삭제 불가. 삭제는 결제/주문 취소를 대신하지 않음 |
| 배송 초안 | 통화 주문 확정 전 READY/EDITING 삭제 불가. 원본·재개·실제 주문으로 연쇄 삭제하지 않음 |
| 미답변 질문 | OPEN만 새로 삭제. FAQ로 전환한 REGISTERED가 포함되면 전체 409. 발생 식별자·해시·통화 이력 보존 |
| 기업·부서·소속·고객·주소록 | 기존 연관 정리·개인 고객/주소·과거 주문·청구 보존 범위 유지 |

일반 삭제는 기존 soft delete/상태 전환 정책을 유지합니다. 보관 기간·실제 폐기 정책과 현재 AI 대표 페르소나 보호는 바꾸지 않습니다. 카드 해제 뒤 PG 키 해제도 기존 워커가 담당합니다.

## 최신 프론트에서 확인한 호출 위치

원격 develop-fe `511ac245` 기준 다음 단건 호출이 구형 URL을 사용합니다. 이번 MR은 백엔드 변경이며 프론트 코드를 수정하지 않습니다.

| 파일 | 바꿀 함수 |
| --- | --- |
| `frontend/src/features/admin/api/adminApi.ts` | `deleteAdmin` |
| `frontend/src/features/company/api/companyApi.ts` | `deleteCompany`, `deleteDepartment`, `removeMember` |
| `frontend/src/features/faq/api/unansweredApi.ts` | `deleteUnanswered` |
| `frontend/src/features/order/api/draftApi.ts` | `deleteDraft` |

각 함수의 요청 URL·JSON body를 위 표대로 바꾸면 기존 단건 버튼의 인수/반환값을 유지할 수 있습니다. 다건 UI는 같은 요청에 여러 번호를 넣습니다. MSW·프론트 테스트도 컬렉션 경로와 배열 body로 맞추며, 구형 단건 mock은 제거합니다. FAQ·페르소나 등 이미 배열로 보내는 호출은 변경하지 않습니다. 다른 호출자가 직접 DELETE를 구성한다면 전체 경로 표를 기준으로 함께 전환합니다.

**배포 전에 프론트 호출을 전환해야 합니다. 백엔드만 먼저 배포하면 아직 구형 URL을 쓰는 삭제 버튼이 404로 실패합니다.** AI가 카드 해제를 사용한다면 위 두 카드 DELETE의 URL·body만 함께 전환하고 기존 Bearer·통화 헤더는 유지합니다. 새 환경변수·DB migration은 없습니다. 현재 배포된 프론트와 실제 PG 실행은 이 명세의 소스 대조 범위에 포함하지 않습니다.
