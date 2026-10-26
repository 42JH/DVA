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
주문·배송·AI 작업의 감사 연동과 FAILED/DENIED 기록 확장은 이 조회 구현과 별도 작업이다.
