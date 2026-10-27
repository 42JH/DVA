# 관리자 감사 로그 조회

Jira: [S15P31D109-101](https://ssafy.atlassian.net/browse/S15P31D109-101)

두 API 모두 `dva_session` 쿠키로 인증하며 활성 `SUPERVISOR`, `SYSTEM_ADMIN`만 조회할 수 있다.

## 목록: GET /api/audit-logs

선택 필터는 `actorSeq`, `action`, `targetType`, `targetSeq`, `result`, `from`, `to`다.
기간은 시작 포함·종료 미포함이며 시간대가 포함된 datetime을 사용한다.
`limit`은 기본 20, 범위 1~100이고 `offset`은 기본 0이다.
발생 시각 내림차순, 동일 시각에서는 로그 식별자 내림차순으로 정렬한다.
응답은 `{ data: Audit[], hasNext: boolean }`이다.

## 상세: GET /api/audit-logs/{id}

`id`는 `auditLogSeq`이며 1~2147483647 범위의 정수다.
응답은 `{ data: Audit, meta: { requestId: string } }`이다.
Audit에는 `auditLogSeq`, `actorType`, `actorSeq`, `action`, `targetType`,
`targetSeq`, `requestId`, `result`, `metadata`, `occurredAt`이 포함된다.
`actorSeq`, `targetSeq`는 null일 수 있다.
기록의 `requestId`는 당시 작업의 추적 ID이고 `meta.requestId`는 현재 조회 요청의 추적 ID다.

공개 필드 정책이 정해지기 전까지 목록·상세의 `metadata`는 빈 객체다.
DB에 저장된 원문 JSON이나 비밀번호·토큰 등 비밀값은 반환하지 않는다.

| HTTP | code | 조건 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 잘못된 식별자·검색 조건 |
| 401 | UNAUTHORIZED | 유효한 로그인 세션 없음 |
| 403 | FORBIDDEN | 조회 역할 없음 |
| 404 | NOT_FOUND | 상세 조회 대상 없음 |

조회 API는 원본을 수정하지 않는다. 감사 로그 수정·삭제 API는 제공하지 않는다.

## 기록 규칙

관리자 가입·로그인·권한/상태 변경·비밀번호 변경/초기화·로그아웃을 기록한다.
주소록 등록·수정은 [PIN API](pins.md)의 PERSONAL_PIN_CREATED·PERSONAL_PIN_UPDATED·COMPANY_PIN_CREATED·COMPANY_PIN_UPDATED로 기록한다.
성공 기록은 기존 업무 트랜잭션에서 저장한다. 감사 저장 실패 시 업무 변경도 롤백한다.
이미 만료되거나 삭제된 세션의 반복 로그아웃은 성공 기록을 추가하지 않는다.

감사 대상 HTTP 메서드의 `@AuditOperation`은 실패 기록의 작업 종류와 대상 해석을 선언한다.
Guard의 401/403은 `DENIED`, 이후 DTO/업무/저장 오류는 `FAILED`로 기록한다
(이후 단계의 401/403도 `DENIED`). 실패 기록은 업무 롤백이 끝난 뒤 별도 쿼리로 저장한다.
Guard 거부와 Interceptor 실패 경로는 겹치지 않으므로 같은 실패를 이중 기록하지 않는다.
요청 본문·비밀번호·세션 쿠키·SQL 오류 메시지를 감사 레코드에 복사하지 않는다.

인증된 작업자는 세션에서 가져온다. 로그인 실패·가입 등 인증 주체를 확인할 수 없는 경우
기존 스키마에 맞춰 `actorType=SYSTEM`, `actorSeq=null`로 기록한다.
이 표기는 시스템이 보낸 요청이라는 뜻이 아니라, 식별된 관리자 주체가 없다는 뜻이다.
유효한 형식의 대상 ID는 시도한 대상이며 해당 리소스가 실제 존재한다는 보장은 아니다.
`requestId`는 추적용이며 멱등키나 중복 방지 키로 사용하지 않는다.

DB 자체가 불능이면 실패 감사 저장도 실패할 수 있다. 원래 오류 응답을 유지하고,
서버 로그에 `audit_write_failed`와 requestId만 남긴다. 영속 재시도 큐는 없다.
Nginx·CORS·본문 파싱 등 Guard 이전에 차단된 요청, 읽기 API 및 내부 서비스 직접 호출은
이 HTTP 실패 감사 범위에 포함되지 않는다.

기업 등록은 `ORGANIZATION_CREATED` / `ORGANIZATION`으로 기록한다.
기업 행·성공 감사는 같은 트랜잭션에 저장한다.
기업 POST는 매번 독립 등록이며 생성된 기업마다 성공 감사를 남긴다.
본문 불일치나 저장 실패는 별도 `FAILED`, 세션 거부는 `DENIED`로 기록한다.

기업 수정은 `ORGANIZATION_UPDATED` / `ORGANIZATION`으로 기록한다.
기업명·상태 변경과 성공 감사가 같은 트랜잭션에 저장되며 감사 저장 실패 시 변경도 롤백한다.
기존 PATCH 계약에는 멱등키가 없으므로 독립된 PATCH 요청은 각각 작업으로 기록한다.

## 이벤트와 후속 연동

| 이벤트 | 대상 | 현재 연결 |
| --- | --- | --- |
| ADMIN_BOOTSTRAP | ADMIN_USER | 최초 관리자 CLI의 기존 성공 기록 |
| ADMIN_SIGNUP | ADMIN_USER | 가입 |
| ADMIN_LOGIN | ADMIN_USER | 로그인 |
| ADMIN_LOGOUT | ADMIN_USER | 유효한 세션 로그아웃 |
| ADMIN_ACCESS_CHANGED | ADMIN_USER | 역할·상태 변경 |
| ADMIN_PASSWORD_CHANGED | ADMIN_USER | 본인 변경·관리자 초기화 |
| ORGANIZATION_CREATED | ORGANIZATION | 기업 등록 |
| ORGANIZATION_UPDATED | ORGANIZATION | 기업명·상태 수정 |
| MEMBERSHIP_CREATED | MEMBERSHIP | 기업 구성원 개별 등록 |
| MEMBERSHIP_UPDATED | MEMBERSHIP | 대표자 표시·소속 상태 변경 |
| MEMBERSHIP_REMOVED | MEMBERSHIP | 기업 소속 연결 해제 |
| MEMBERS_IMPORTED | ORGANIZATION | 직원 CSV 등록·이름·전화번호 갱신 |

구성원 API는 업무 변경·성공 감사를 같은 트랜잭션에서 저장하며 별도 요청 키 기록은 사용하지 않는다.
개별 등록 중복은 고유 제약으로 거절하고, 성공한 CSV 재업로드는 각각 성공 감사를 남긴다.
CSV 원문과 이름·전화번호는 감사에 저장하지 않는다.
소속 해제 감사는 작업 기록이며 과거 소속 전체를 복구할 수 있는 이력은 아니다.
자세한 계약은 [기업 구성원 API](members.md)를 참고한다.

Jira 101의 주문 수정·취소, 배송 상태 변경, AI 설정 적용은 현재 모놀리식에 해당 API가 없어
실제 연동되지 않았다. 관련 작업(61·64·67·98)의 구현 시 이벤트 이름과 대상 계약을 확정하고,
같은 트랜잭션에서 `AuditService.recordSuccess(event, client)`를 호출해야 한다.
HTTP 실패 기록은 `@AuditOperation`을 함께 선언한다. 외부 MSA 이벤트의 중복 방지·전달 보장은
별도 수신/outbox 계약이 필요하며 이 구현으로 해결됐다고 간주하지 않는다.
따라서 이 MR 병합만으로 Jira 101의 모든 업무 연동이 완료되는 것은 아니다.

## 검증

`node backend/scripts/check.cjs`는 격리 DB에서 인증·역할·검색·페이지·기간 경계·상세 404,
민감 metadata 비노출, 실패 기록 단일 저장, 업무 롤백 후 FAILED 기록,
기업 등록·수정과 감사의 원자성을 검사한다.
기존 PBX, 세션 만료/비밀번호 변경, 기업 API, 운영 이미지와 Nginx 회귀도 함께 실행한다.
