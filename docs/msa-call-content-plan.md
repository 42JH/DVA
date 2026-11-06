# 미답변 수집·삭제와 통화 콘텐츠 조회·삭제 이식

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)

## 기준과 범위

MR !337 병합을 확인하고 `origin/develop-backend`의 `1597c6238cc1c33fa1e76d685eb5460c014aed86`에서 `feature/msa-call-content`를 분리했다. backend tree `46377df301afd942d27f2cbd9d24694c46a3aae6`, migration 054까지를 읽기 전용 계약으로 삼는다. 기존 worktree는 보존한다. 추적 수정은 msa/infra/docs 내부만 허용하며 원본·프론트·AI·의존성과 이미 적용된 SQL은 수정하지 않는다.

이번 공개 선언은 6개다.

| method | 기존 경로 | 동등성 범위 |
|---|---|---|
| POST | /api/ai/unanswered-questions | AI 전용 토큰, 최초 201/동일 재전송 200, 발생 UUID/정규화 해시, 사유·원문·상태·감사 원자성 |
| DELETE | /api/unanswered-questions/:id | 관리자/Origin, OPEN soft delete, 재삭제 204, REGISTERED 409, 본문 검증·원문/해시 보존 |
| GET | /api/calls/:id/transcript | 현재 통화 확인, 발화 순서/위치·페이지/전체 건수 |
| GET | /api/calls/:id/actions | AI 동작·정수 초·순서/페이지/전체 건수 |
| GET | /api/calls/:id/processing-results | FAQ 질문/답변 발화와 미답변 상태/사유·삭제 시 숨김 |
| DELETE | /api/calls/:id | 통화 종료·녹취 완료/claim 확인, 2초 잠금, soft delete·감사·SSE 숨김 |

주문 소유권·FAQ 생성과 원자성을 함께 보장해야 하는 통화 이벤트 수집, 미답변 목록/FAQ 전환과 통화 목록/상세·녹취 재생은 다음 단계다. 이번 조회는 기존의 정상 업무 행을 주입해 검증하며 이벤트 수집을 구현했다고 보고하지 않는다. 물리 보관 폐기 워커와 전체 동등성은 남아 있다.

## 계획 → 구현 → 검증

1. 기존 consultation 인증·감사 이벤트/DB 트랜잭션을 사용한다. 원본의 DTO·Controller·Service·Repository에서 해당 기능을 이식하며 고객/주문/FAQ 데이터를 복제하거나 교차 DB SQL을 만들지 않는다. DB 구조는 기존 consultation 006/007로 충분한지 확인한다.
2. 모듈/이미지/공개 Ingress/배포 probe·OpenAPI·기존 E2E와 관련 테스트를 함께 갱신한다. AI_INSIGHTS_TOKEN과 서비스 인증/감사 준비·확정/중단의 기존 설정을 그대로 사용한다. Redis·브로커·별도 외부 API·새 의존성은 추가하지 않는다.
3. 원본 미답변 DTO 테스트와 이 범위에 해당하는 원본 통합 테스트를 가능한 그대로 실행한다. production 양 앱에 같은 요청을 보내 상태·본문·헤더·권한·부작용/감사를 비교한다. 신규/동일/변조 재전송·두 인스턴스 경합·삭제 뒤 재전송·현재/삭제/5년 만료·빈 페이지·FAQ 복수 참조·미답변 상태/사유·잘못된 본문/토큰/쿠키/Origin·감사 장애 rollback과 실제 강제 종료 후 복구를 포함한다.
4. consultation 전체 비교 검증, operations/customer 기존 회귀와 이벤트/배포 검사 중 영향을 받는 범위를 검증한다. 실행 중 실패는 원인을 재현해 수정하고 검사를 완화하지 않는다. 단계별 커밋 후 develop-backend 대상 MR을 생성해 링크·검증/한계를 보고하고 사용자 병합을 기다린다.

## 영향과 위험

HTTP/AI 입력은 기존 전역 guard와 전용 CallInsightsGuard 경계를 통과해야 한다. 서비스간 감사 이벤트는 기존 outbox/inbox를 사용하며 성공 응답 전 감사 확정을 기다린다. 삭제는 원본 045 이후 정책대로 원문·발생 해시·업무 연결을 보존하고 일반 조회에서 숨긴다. 다른 호출자가 사용하는 통화 등록/PBX/분석/SSE 경로와 기존 프로세스 종료 복구를 회귀 검증한다. 원본 테스트 중 아직 이식하지 않은 수집/주문/목록/전환 경로는 제외 이유와 함께 별도 기록한다.

실제 운영 Jenkins/k3s·공개 HTTPS·실제 AI/PBX/S3는 로컬 임시 PostgreSQL/HTTP 검증과 구분한다.
