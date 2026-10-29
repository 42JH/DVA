# 감사 로그

관련 Jira: [S15P31D109-101](https://ssafy.atlassian.net/browse/S15P31D109-101).
조회는 `dva_session`으로 인증한 ACTIVE 상태의 SUPERVISOR·SYSTEM_ADMIN만 가능하다.

## 조회 API

| API | 입력 | 응답 |
| --- | --- | --- |
| GET /api/audit-logs | 선택: actorSeq, action, targetType, targetSeq, result, from, to, limit, offset | `{ data: Audit[], hasNext }` |
| GET /api/audit-logs/{id} | auditLogSeq, 1~2147483647 정수 | `{ data: Audit, meta: { requestId } }` |

최신 발생 시각부터, 같은 시각이면 로그 번호 내림차순으로 정렬한다.
limit은 기본 20·최대 100, offset은 기본 0이다. 기간은 시작 포함·종료 미포함이며 시간대를 명시한다.
잘못된 입력은 400, 세션 없음은 401, 권한 없음은 403, 없는 상세는 404다.

| Audit 필드 | 의미 |
| --- | --- |
| auditLogSeq | 로그 번호 |
| actorType | ADMIN / AI / SYSTEM |
| actorSeq | 작업한 관리자 번호. AI·SYSTEM은 null |
| actorName | 작업 당시 관리자 이름, AI는 `AI`. 서버 작업·과거 미식별 기록은 null |
| action | 작업 코드 |
| targetType, targetSeq | 대상 종류·번호. 대상 번호가 확인되지 않으면 null |
| targetAdminName | ADMIN_USER 대상의 당시 이름. 다른 대상·미식별 대상은 null |
| requestId | 당시 업무 요청 ID. 조회 응답의 meta.requestId와 별개 |
| result | SUCCESS / DENIED / FAILED |
| metadata | 현재 공개 응답은 항상 빈 객체 |
| occurredAt | 발생 시각 |

관리자 이름은 로그 자체에 저장하므로 계정을 삭제하거나 이름이 바뀌어도 기존 기록은 유지된다.
작업자와 대상은 다를 수 있다. 최상위 관리자가 다른 관리자를 삭제하면
actorName에는 삭제한 사람, targetAdminName에는 삭제된 사람의 이름이 남는다.
감사 로그 수정·삭제 API는 제공하지 않는다.

## 작업 주체와 저장 규칙

- ADMIN: 서버가 확인한 관리자 번호와 이름을 기록한다. 클라이언트가 보낸 작업자 이름은 받지 않는다.
- AI: 주문·개인 주소록·고객의 기존 AI 호출 경로와 페르소나 적용 회신. actorSeq=null, actorName=AI다.
- SYSTEM: 초기 관리자 생성, 로그인 실패·가입 등 관리자 주체가 확인되지 않은 요청.
  관리자 번호가 없다는 이유만으로 모든 서버 작업을 AI로 분류하지 않는다.

기존 MVP AI API의 서비스 인증 정책은 바꾸지 않는다. AI 표기는 해당 호출 경로를 나타내며
새 인증 기능을 뜻하지 않는다. 페르소나 회신은 기존 서비스 토큰 검증에 성공한 뒤 AI로 식별한다.
잘못된 관리자 쿠키는 AI 호출로 바뀌지 않는다.

성공 로그는 업무 변경과 같은 트랜잭션으로 저장한다. 감사 저장 실패 시 DB 업무 변경도 롤백한다.
외부 디버 호출은 트랜잭션 밖에서 실행하고, 이미 전송된 주문의 결과 저장에 실패하면 기존대로 SUBMITTING을 유지한다.
API 반환 성공이 외부 요청 취소·롤백을 뜻하지 않는다.

`@AuditOperation`이 선언된 API의 실패는 업무 롤백 후 별도로 기록한다.
401·403은 DENIED, 나머지 오류는 FAILED다. Guard와 Interceptor는 같은 실패를 중복 기록하지 않는다.
페르소나 서비스 토큰 거부도 별도 Guard에서 기록한다.
실패 로그의 targetSeq는 시도한 대상 번호이며 실제 존재를 보장하지 않는다.

비밀번호·쿠키·토큰·주소·전화번호·프롬프트·CSV 원문을 감사 로그에 복사하지 않는다.
requestId는 추적용으로만 사용하며 별도 중복 방지 테이블은 추가하지 않는다.
DB 자체가 불능이면 실패 로그도 저장하지 못할 수 있다. 원래 오류 응답을 유지하고 서버에 audit_write_failed를 남긴다.

## 현재 기록하는 업무

| 업무/API | 작업 코드 | 대상 |
| --- | --- | --- |
| 최초 관리자 CLI, POST /auth/signup | ADMIN_BOOTSTRAP, ADMIN_SIGNUP | ADMIN_USER |
| POST /auth/login, /auth/logout | ADMIN_LOGIN, ADMIN_LOGOUT | ADMIN_USER |
| PATCH /admins/{id}, /admins/{id}/role | ADMIN_ACCESS_CHANGED | ADMIN_USER |
| PATCH /auth/password, /admins/{id}/password | ADMIN_PASSWORD_CHANGED | ADMIN_USER |
| DELETE /admins/{id} | ADMIN_DELETED | ADMIN_USER |
| 기업 등록·수정 | ORGANIZATION_CREATED, ORGANIZATION_UPDATED | ORGANIZATION |
| 구성원 등록·수정·소속 해제 | MEMBERSHIP_CREATED, MEMBERSHIP_UPDATED, MEMBERSHIP_REMOVED | MEMBERSHIP |
| 구성원 CSV 등록·갱신 | MEMBERS_IMPORTED | ORGANIZATION |
| POST /customers, 주문 중 신규 고객 생성 | CUSTOMER_CREATED | CUSTOMER |
| PATCH /customers/{id}: 이름·상태·탈퇴 | CUSTOMER_UPDATED | CUSTOMER |
| POST /customers/context 또는 /orders에서 새 통화 생성 | CALL_STARTED | CALL_SESSION |
| 개인·기업 주소록 등록·수정 | PERSONAL_PIN_CREATED/UPDATED, COMPANY_PIN_CREATED/UPDATED | PERSONAL_PIN / COMPANY_PIN |
| POST /orders, /admin/orders | ORDER_CREATED | ORDER |
| PATCH /orders/{id} | ORDER_UPDATED | ORDER |
| 주문 전체·선택 상세 취소 | ORDER_CANCELLED, ORDER_PARCEL_CANCELLED | ORDER / ORDER_PARCEL |
| 디버 접수 시작·결과 확정 | ORDER_SUBMISSION_STARTED, ORDER_SUBMISSION_ACCEPTED/AUTH_FAILED/REVIEW_REQUIRED | ORDER |
| FAQ 등록·수정·초기 등록 | FAQ_CREATED, FAQ_UPDATED, FAQ_BOOTSTRAPPED | FAQ_ENTRY |
| 페르소나 등록·설정 수정 | PERSONA_CREATED, PERSONA_UPDATED | AI_PERSONA_VERSION |
| 페르소나 적용 요청·대기 교체·대기 취소 | PERSONA_APPLY_REQUESTED, PERSONA_PENDING_REPLACED, PERSONA_PENDING_CANCELLED | AI_PERSONA_VERSION |
| POST /ai/config/apply-result: 적용 성공·실패 회신 | PERSONA_APPLIED, PERSONA_APPLY_FAILED | AI_PERSONA_VERSION |

경로는 모두 /api 아래다. 주문 submit의 HTTP 거부·실패 코드는 ORDER_SUBMITTED,
페르소나 회신 자체의 인증·입력·처리 오류 코드는 PERSONA_APPLY_RESULT다.
AI가 정상적으로 보낸 적용 실패는 PERSONA_APPLY_FAILED / FAILED로 별도 기록한다.

같은 통화 재요청은 CALL_STARTED를 추가하지 않는다. 고객 확인의 조회만 수행하면 성공 감사를 만들지 않는다.
이미 처리한 주문 요청 키, 이미 적용한 페르소나 성공 회신, 유효 세션 없는 반복 로그아웃도 성공 로그를 늘리지 않는다.
CSV는 업로드 한 번에 집계 로그 한 건을 남기며 개별 고객 전체 변경 이력을 저장하지 않는다.
기록은 누가 어떤 대상을 처리했는지 확인하기 위한 것이며 원문·변경 전후 데이터를 복구하는 저장소는 아니다.

일반 조회·Nginx/본문 파싱 단계의 오류·주석이 없는 내부 호출은 HTTP 실패 감사 대상이 아니다.
PBX 수신·S3 재처리는 기존 웹훅 수신함과 recordings에서 추적한다.
별도 배송 상태 변경·상담원 배정 변경 API는 현재 구현되지 않아 새 감사 이벤트도 만들지 않는다.

## 관리자 실제 삭제와 DB 적용

새 앱과 초기 등록 CLI를 실행하기 전에 `015-admin-deletion-audit.sql`을 적용한다.
새 테이블 없이 감사 로그에 actor_name·target_admin_name을 추가하고 기존 계정으로 확인 가능한 이름을 보완한다.
이전 이름을 복원하는 것은 아니며, 기존 SYSTEM 기록을 근거 없이 AI로 바꾸지 않는다.

관리자 참조 5곳(상담원 배정·배송 상태 이력·페르소나 작성자/적용 요청자·FAQ 수정자)은 번호를 보존하는 논리 참조다.
admin_sessions는 ON DELETE CASCADE를 유지한다. 삭제 API는 먼저 이름을 감사에 기록하고 계정을 삭제하며 둘 다 함께 커밋한다.
삭제 전에 인증을 마친 실행 중 작업은 계속될 수 있다. 뒤늦은 감사 저장 시에는 삭제 로그에서 이름을 찾을 수 있다.
삭제 후 loginId를 다시 가입에 사용해도 새 adminUserSeq를 발급하므로 이전 감사와 혼동하지 않는다.

## 검증

`node backend/scripts/check.cjs`: 권한·이름 보존·물리 삭제·세션 종료·동시 로그인·감사 실패 롤백,
AI/관리자/SYSTEM 구분, 기존 업무 API와 운영 이미지·Nginx 경로를 임시 DB와 모의 외부 서비스로 검증한다.
`infra/database/test-monolith.ps1`: 신규 적용·기존 이름 보완·업무 이력 보존·세션 cascade·업그레이드 롤백·백업 복원을 검증한다.
