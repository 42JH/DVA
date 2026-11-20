# Jenkins #29 실패 복구 계획

관련 Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)

## 확인한 실패

[Jenkins #29](https://192.0.2.10/jenkins/job/dva-msa/29/console)는 `ce8de447bea0a0976be9d710708d614c53e91d99`를 checkout했다. Linux 배포 회귀 59개와 실제 PostgreSQL 이벤트 통합 15개를 통과하고 `Verify Event Transport` 안의 원본 기준 목록 비교에서 실패했다. 새 `GET /api/companies/members/search`와 migration `053-drop-company-pins.sql`이 이전 MSA 기준 목록에 없다. 앱 빌드·DB 검증·배포 단계는 도달하지 않았다. 동일 실패를 최신 원격 기준의 로컬 검사에서도 재현했다.

MR !311은 아직 Open이며 이 빌드의 checkout에 포함되지 않았다. 사용자 요청에 따라 해당 페르소나 작업 5개 커밋을 보존해 새 수정 MR에 함께 포함한다. 원본 `backend/`, 프론트·AI는 수정하지 않는다. 추적 수정은 `msa/`, `infra/`, `docs/`로 제한한다.

## 계획과 범위

1. 최신 develop-backend `ce8de44`에서 `fix/msa-build`를 분리한다. backend tree는 `c19c5594540415c579b00eee1917df1cbd954a93`다. 기존 페르소나 브랜치를 이력 재작성 없이 통합한다.
2. 기준 목록만 갱신해 후속 업무 차이를 숨기지 않는다. 이미 이식한 기능에 영향을 주는 최신 관리자 인증 제한/입력 상한/429·Retry-After·감사 제외와 고객 AI 업무 Bearer/기업 디렉터리 인증, 관리자 사원 검색·기업 PIN 퇴역을 MSA 소유 서비스에 연결한다. 원본 코드·상수·검증과 기존 내부 서비스 토큰 경계를 유지하며 Redis/신규 앱·의존성을 추가하지 않는다.
3. 적용된 changeset은 수정하지 않는다. 필요한 후속 changeset을 추가하고 구 MSA 기업 PIN 데이터는 새 업무에서 참조하지 않는 보관 테이블로 보존한다. 원본에서 퇴역한 API·업무 참조를 되살리지 않는다.
4. 현재 원본 선언·migration·워커 목록을 빠짐없이 검증한다. 변경하지 않은 원본 테스트와 실제 분리 DB/HTTP 비교를 최신 계약으로 실행한다. 서비스별 소유권이 다른 테스트 의존성은 실제 이식한 런타임 fixture로 공급하고 assertions를 완화하지 않는다.
5. Jenkins 실패 단계부터 전체 로컬 CI 명령을 순서대로 검증한다. 필요한 Linux 빌드/단위/E2E·DB 신규/업그레이드/실패 롤백과 기존 고객/PIN·PBX/SSE·페르소나/감사 복구를 확인한다. 운영 Jenkins 재실행·실제 외부 AI·공개 HTTPS·전체 MSA 이식 완료와 구분해 보고한다.
6. 검증 근거와 새 MR의 범위/대상/제목/설명을 준비한 뒤 커밋·push·MR을 생성하고 같은 Task에 보고한다. 기존 MR을 임의 병합/삭제하거나 브랜치·커밋을 강제 변경하지 않는다. 새 MR 생성 후 사용자 병합 확인을 기다린다.

## 구현과 검증 범위

- 기준 목록은 ce8de44의 96개 공개 선언·SQL 52개 파일(마지막 번호 053)·워커 6개를 그대로 비교한다. 기존 전체 deep equality·중복 경로 검사와 migration 해시를 유지하고 새 사원 검색을 필수 경로에 추가했다.
- operations는 원본 AuthLimitsService/Guard·인증 서비스/DTO·429 Retry-After·감사 제외를 연결한다. 내부 customer/consultation 세션 인증은 유지한다. 원본 인증 테스트는 수정하지 않으며 새 테스트가 참조하는 customer 컨트롤러는 실제 customer checks 이미지의 compiled runtime으로 제공한다. 매 실행의 고유 디렉터리에 추출해 이전 빌드 파일이 남지 않게 한다. 운영 이미지에 고객 모듈을 합치지 않는다.
- 원본 auth-limits 통합 테스트 5개는 FAQ 접근 확인도 포함하므로 모놀리식에서 그대로 실행한다. operations에는 수정하지 않은 원본 인증 단위/통합 테스트와 별도 production HTTP 비교를 실행한다. 후자는 ID/IP 제한·잘못된 가입 입력의 집계·프록시 거절 표시·429 헤더·DB 감사 제외를 확인하고, 실제 계정 행 잠금으로 비밀번호 작업 2개를 대기시켜 세 번째 요청 거절과 일반 세션 조회를 검증한다.
- customer는 최신 AI 업무 Bearer와 관리자 세션의 분리, AI 전용 기업 배송지 검색, 관리자 전용 사원 검색을 제공한다. 인증·DTO·SQL·페이지/total_count·주소 없는 사원·비활성 필터·오류·OpenAPI를 원본과 비교한다. 고객 선언은 기존 22/23에서 23/24로 늘며 기업 청구 조회는 후속이다.
- 원본 053은 호환되지 않는 앱 중단·백업 후 company_pins를 DROP한다. MSA customer 007은 DB 선적용 중 구버전 앱 SQL과 기존 데이터를 보존하기 위해 같은 이름의 보관 테이블을 남기고 주석만 추가한다. 새 업무의 조회·부서 갱신·기업/부서 삭제·감사에서는 참조를 제거한다. 현재 업무 DB 5개 테이블을 비교하고 보관 테이블의 기존 행은 별도로 전후 동일성을 검증한다. 이전 outbox의 기업 PIN 감사 수신은 복구를 위해 유지한다. 기존 changeset은 수정하지 않는다.

## 운영 적용 조건과 제한

customer는 선택 Secret `dva/msa-ai-business`의 `AI_BUSINESS_TOKEN`을 읽는다. 실제 기존 AI와 같은 값을 설정해야 하며 값이 없으면 AI 업무 요청은 원본처럼 503이다. 내부 서비스 토큰·페르소나 토큰을 재사용하거나 새 값을 임의 생성하지 않는다. 프론트·AI·backend 변경과 신규 앱/패키지는 없다.

관리자 인증 카운터는 원본처럼 프로세스 메모리이며 기존 1 replica 배포를 전제로 한다. AUTH_PROXY_HOPS는 기본 0, 명시 설정은 0/1/2만 허용한다. 신뢰 프록시의 X-Forwarded-For 덮어쓰기·직접 접근 차단을 확인한 환경에서만 1/2를 사용한다. 원본 Nginx의 로그인 IP 정책·다중 replica 공유 카운터·재시작 후 제한 유지·실제 외부 AI·공개 HTTPS/Ingress·운영 배포·전체 MSA 이식 완료는 이번 로컬 검증 결과로 단정하지 않는다.

## 2026-11-06 로컬 검증 결과

모든 비교의 원본 backend tree는 `c19c5594540415c579b00eee1917df1cbd954a93`다. 원격을 다시 fetch해 develop-backend가 여전히 ce8de44임을 확인했다. frontend·AI·backend와 기존 적용 changeset 변경은 없다. 아래 확인 항목 수는 보고서의 명령/검증 기록 수이며 개별 테스트 개수와 구분한다.

| 검증 | 결과와 근거 |
| --- | --- |
| Linux 배포 회귀 | WSL Ubuntu에서 `python3 -m unittest discover -s msa/deploy/tests -p 'test_*.py'`: 59개 통과. 의도적인 readiness 실패·이전 앱 복구 검사가 포함된다. |
| Jenkins 실패 단계 | `python msa/shared/events/verify.py`: 실제 PostgreSQL 이벤트 통합 15개와 최신 목록 비교 1개 통과. 해시·워커·96개 선언의 전체 비교를 유지했다. |
| DB | `python msa/liquibase/verify.py`: `passed=true`, 323개 확인 항목. 5개 DB 신규 설치·재적용·이력·업그레이드·고의 실패 롤백, 기업 PIN 보관 행과 기존 개인 PIN/통화/페르소나·대기 이벤트 보존을 확인했다. |
| Operations | 최종 실행 `dva-operations-check-abcacbf1f668`: `passed=true`, 101개 확인 항목. 원본 인증 53개 양쪽 통과, operations 환경 4개를 합쳐 57개 통과. 원본 제한 통합 5개는 monolith에서 통과했다. 페르소나 원본 suite는 각각 60개 통과했다. production 인증/관리자/감사 데이터 비교와 추가 제한/슬롯 비교, 페르소나 77개 요청·10개 선언·21개 DTO, 실제 SIGKILL 후 같은 publish UUID 복구·배포 probe가 통과했다. |
| Customer | 실행 `dva-customer-check-c9e72466d184`: `passed=true`, 71개 확인 항목. production 조회/인증 100개 요청과 원본 직원 DTO 4개, test 환경 쓰기/조회/인증 54개 요청, 매 응답 후 현재 업무 DB·감사 전체 행 및 보관 PIN 불변성, 감사 확정·강제 종료 복구를 확인했다. |
| Consultation | 실행 `dva-consultation-check-1e54aa86797f`: `passed=true`, 111개 확인 항목. 원본 통합 62개·분리 PBX/워커 13개, production PBX/SSE 19개 요청과 test 환경 고객 확인 59개/PIN 115개 요청·통화 잠금·재수신·강제 종료 복구가 통과했다. |
| 앱 빌드 | Node.js 24 Linux Docker의 customer/operations/consultation 및 order/delivery 이미지 빌드 통과. 해당 Dockerfile의 lint·단위·E2E·TypeScript 검사를 유지했다. order/delivery는 기존 서비스 디렉터리 context, 이벤트 공유 3개 서비스는 msa context를 사용했다. |
| 정적/범위 확인 | Python 4개 구문 검사·추가 CJS 구문 검사·전체 목록 검사와 CRLF를 줄 끝으로 인식한 `git diff --check` 통과. 추적 변경은 msa/docs뿐이며 기존 페르소나 커밋 5개를 merge 이력으로 보존한다. |

DB 검증 중 Docker 명령이 240초를 초과한 실행이 한 번 있었다. 그 실행은 실패로 기록했으며 원인은 확정하지 않았다. 제한 시간·검사·기대 업무 결과를 완화하지 않고 새 격리 DB에서 같은 전체 명령을 다시 실행해 323개 확인 항목을 통과했다. 원본 목록 누락 실패와 이 로컬 명령 시간 초과를 구분한다. 운영 Jenkins 재실행과 배포 결과는 아직 확인하지 않았다. 검증 로그·보고서는 git에 포함하지 않고 `msa/liquibase/verification-logs/`와 `msa/build29-*.log`에 보관한다.
