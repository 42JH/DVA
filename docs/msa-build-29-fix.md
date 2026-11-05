# Jenkins #29 실패 복구 계획

관련 Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)

## 확인한 실패

[Jenkins #29](https://13.209.59.180/jenkins/job/dva-msa/29/console)는 `ce8de447bea0a0976be9d710708d614c53e91d99`를 checkout했다. Linux 배포 회귀 59개와 실제 PostgreSQL 이벤트 통합 15개를 통과하고 `Verify Event Transport` 안의 원본 기준 목록 비교에서 실패했다. 새 `GET /api/companies/members/search`와 migration `053-drop-company-pins.sql`이 이전 MSA 기준 목록에 없다. 앱 빌드·DB 검증·배포 단계는 도달하지 않았다. 동일 실패를 최신 원격 기준의 로컬 검사에서도 재현했다.

MR !311은 아직 Open이며 이 빌드의 checkout에 포함되지 않았다. 사용자 요청에 따라 해당 페르소나 작업 5개 커밋을 보존해 새 수정 MR에 함께 포함한다. 원본 `backend/`, 프론트·AI는 수정하지 않는다. 추적 수정은 `msa/`, `infra/`, `docs/`로 제한한다.

## 계획과 범위

1. 최신 develop-backend `ce8de44`에서 `fix/msa-build`를 분리한다. backend tree는 `c19c5594540415c579b00eee1917df1cbd954a93`다. 기존 페르소나 브랜치를 이력 재작성 없이 통합한다.
2. 기준 목록만 갱신해 후속 업무 차이를 숨기지 않는다. 이미 이식한 기능에 영향을 주는 최신 관리자 인증 제한/입력 상한/429·Retry-After·감사 제외와 고객 AI 업무 Bearer/기업 디렉터리 인증, 관리자 사원 검색·기업 PIN 퇴역을 MSA 소유 서비스에 연결한다. 원본 코드·상수·검증과 기존 내부 서비스 토큰 경계를 유지하며 Redis/신규 앱·의존성을 추가하지 않는다.
3. 적용된 changeset은 수정하지 않는다. 필요한 후속 changeset을 추가하고 구 MSA 기업 PIN 데이터는 새 업무에서 참조하지 않는 보관 테이블로 보존한다. 원본에서 퇴역한 API·업무 참조를 되살리지 않는다.
4. 현재 원본 선언·migration·워커 목록을 빠짐없이 검증한다. 변경하지 않은 원본 테스트와 실제 분리 DB/HTTP 비교를 최신 계약으로 실행한다. 서비스별 소유권이 다른 테스트 의존성은 실제 이식한 런타임 fixture로 공급하고 assertions를 완화하지 않는다.
5. Jenkins 실패 단계부터 전체 로컬 CI 명령을 순서대로 검증한다. 필요한 Linux 빌드/단위/E2E·DB 신규/업그레이드/실패 롤백과 기존 고객/PIN·PBX/SSE·페르소나/감사 복구를 확인한다. 운영 Jenkins 재실행·실제 외부 AI·공개 HTTPS·전체 MSA 이식 완료와 구분해 보고한다.
6. 검증 근거와 새 MR의 범위/대상/제목/설명을 준비한 뒤 커밋·push·MR을 생성하고 같은 Task에 보고한다. 기존 MR을 임의 병합/삭제하거나 브랜치·커밋을 강제 변경하지 않는다. 새 MR 생성 후 사용자 병합 확인을 기다린다.
