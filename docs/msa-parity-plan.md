# MSA 모놀리식 동등성 구현 계획

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)

기준은 `develop-backend`의 `6a141a0512b73837905f6154c4ff84bcf33f912b`이다. 최신 모놀리식의 코드·테스트·migration 052까지를 계약으로 삼는다. 기존 MSA 설계 문서의 결제 미지원·자동 재접수 미지원 등 과거 정책은 최신 모놀리식과 다른 부분을 구현 근거로 사용하지 않는다.

추적 파일 수정은 `msa/`, `infra/`, `docs/` 내부로 한정한다. `backend/`, `frontend/`, `ai/`는 읽기 전용이다. AI·프론트가 동일한 API 요청을 보낸다고 가정하며 별도 클라이언트 변경을 요구하지 않는다. PostgreSQL·NestJS·HTTP와 기존 빌드/배포 도구를 사용하고 Redis나 메시지 브로커를 도입하지 않는다.

## 서비스 소유권과 작업 순서

| MR 단계 | 범위 | 다음 단계 전 검증 |
|---|---|---|
| 1 | 전체 API·migration·워커 기준 목록, 트랜잭션 outbox/inbox, 인증 HTTP 전달·재시도 기반 | 실제 PG에서 rollback·중복·경합·응답 유실·재시작·업그레이드·CI 회귀 |
| 2 | operations 관리자·세션·권한·감사와 공통 HTTP 계약 | 로그인·로그아웃·세션 폐기·Origin·역할·감사 정상/실패 대조 |
| 3 | customer 고객·기업·부서·구성원·개인 PIN, 상담 시작 연결 | 고객 컨텍스트·등록·기업 디렉터리·멱등성·삭제와 즉시 조회 대조 |
| 4 | consultation 통화·PBX·녹취·발화·분석·이벤트·미답변·대시보드·SSE | 순서 뒤바뀐 PBX/AI 수신·토큰·통화 소유권·중복·실시간 수치 대조 |
| 5 | order 주문·결제·청구와 delivery 배송 | 수동/AI 접수·부분 취소·최신 재시도·승인 복구·감사·상태/금액 대조 |
| 6 | operations 페르소나·FAQ, 상담 FAQ 질문 사례 연결 | 초안/HEAD/publish·다음 통화 적용·알림·최근 10건·지연 이벤트 대조 |
| 7 | 서비스 간 삭제·5년 보관·7일 정리, 기존 URL 라우팅·배포·전체 회귀 | 전체 API·DB 업무 데이터·외부 호출과 장애 복구 비교 |

순서는 실제 의존성 조사로 조정할 수 있으나 미구현/미검증 항목은 지우지 않는다. 각 단계는 계획 → 구현 → 검증 → MR 보고 순서다. 모든 MR은 위 Task에 연결하고, 사용자가 병합했다고 확인하기 전에는 다음 MR 작업을 시작하지 않는다. Task를 자동 완료시키는 문구와 자동 병합을 사용하지 않는다.

## 전체 API와 DB 대조

`msa/parity/baseline.json`에 95개 HTTP 선언의 method·기존 전체 경로·담당 서비스·소스 파일, migration 내용의 SHA-256, 워커 목록을 보존한다. 다음 명령은 기준 목록 누락/변경을 검사한다. 이 정적 검사는 업무 API의 실행 동등성을 증명하지 않는다.

```sh
node --test msa/parity/inventory.test.cjs
```

모놀리식·MSA에 동일 초기 데이터, 동일 요청 순서와 외부 AI/디버/결제/PBX/녹취 모의 결과를 주입한다. HTTP 상태·오류 코드·응답 본문·쿠키·헤더·SSE·리다이렉트·응답 직후 조회와 외부 호출 횟수를 대조한다. 실행마다 생성되는 식별자·시각은 연관관계를 검증하며 업무 값 차이를 무시하는 정규화는 하지 않는다.

DB는 테이블의 물리 배치보다 업무 필드·연결·스냅샷·상태·버전·보관 시점·중복 수를 비교한다. 결제/청구는 order, 인증/감사/페르소나/FAQ는 operations, 통화 분석/이벤트/미답변/대시보드는 consultation, 기업·부서·구성원은 customer가 소유한다. 다른 서비스의 데이터는 인증 API/이벤트로 연결하며 교차 DB 직접 쿼리를 하지 않는다. 미답변→FAQ 전환, FAQ 고객 질문 사례, 고객 컨텍스트→통화 등록, 통화 결과→주문, 주문→배송/감사는 별도 교차 서비스 검증 대상이다.

## 이벤트 기반 완료 기준

업무 변경과 outbox INSERT를 같은 트랜잭션으로 저장한다. 수신 inbox와 업무 변경을 같은 트랜잭션으로 커밋한 후에만 ACK한다. 같은 이벤트의 재수신은 재반영하지 않으며 동일 ID의 source/type/payload 변조는 거절한다. 실패한 이벤트는 DB에 남기고 재시도하며 같은 수신처·업무 식별자 뒤의 이벤트가 추월하지 않도록 한다.

전달 보장은 at-least-once이며 외부 결제·디버 응답 유실은 기존 모놀리식의 미확정·조회 복구 정책을 이식한다. 분리 DB의 비동기 처리와 단일 DB 원자성은 동일하지 않다. 기존 API가 성공 응답 전에 보장한 업무 완료와 직후 조회는 따로 검증하고, 잔여 차이가 있으면 완료로 보고하지 않는다.

## 진행 상태

- 첫 MR은 공통 기반이다. 기존 5개 업무 앱에 이벤트 핸들러를 등록하거나 외부 업무 API를 제공하는 단계가 아니다.
- 두 번째 MR에서 operations 인증·관리자·감사 11개 API와 전용 DB 연결을 구현하고 아래 범위로 비교 검증했다. 나머지 서비스·교차 서비스 연동·전체 동등성·운영 배포는 후속 단계다.
- 세 번째 MR은 customer 조회 7개와 operations 세션 인증 위임, Jenkins #23 이벤트 테스트 실패 수정을 포함한다. customer 쓰기·통화 컨텍스트·PIN·청구 16개와 다른 업무 API는 아래 후속 범위로 남는다.
- 네 번째 MR은 customer 쓰기 10개와 operations 감사 준비·확정·중단 및 생산자 강제 종료 복구를 연결한다. customer 공개 선언은 17/23개이며 나머지 6개·자동 업무 워커·전체 MSA 동등성은 남아 있다. 범위와 검증 환경은 [customer 쓰기 계획](msa-customer-writes-plan.md)에 명시한다.
- 기존 적용된 Liquibase changeset은 수정하지 않고 후속 changeset을 사용한다.
- 다섯 번째 MR은 consultation PBX 수신·녹취 워커와 진행 통화 수 조회/SSE 3개를 연결한다. 범위와 복구/검증은 [consultation PBX 계획](msa-consultation-pbx-plan.md)을 따른다. 고객 컨텍스트/PIN·통화 생성과 나머지 상담/주문/운영 기능 및 전체 보관 워커는 후속 단계다.
- 여섯 번째 MR은 customer 고객 확인/통화 등록과 consultation의 통화·PBX·감사 확정을 연결한다. 최신 `04b7346`의 11자리 휴대전화 입력을 반영하며 customer는 18/23개다. [고객 확인·통화 등록 계획](msa-caller-context-plan.md)에 원본 비교·장애 복구와 후속 범위를 기록한다.

## 두 번째 MR 계획 — operations 인증·감사

첫 MR !271은 `3f3894f`로 병합됐다. 이번 작업은 그 커밋에서 분리한 `feature/msa-operations-auth`이며 동일한 Jira Task 160에 연결한다.

- 이식 범위는 `/api/auth` 5개, `/api/admins` 4개, `/api/audit-logs` 2개이다. Controller·DTO·Service·Repository와 공통 입력 검증·오류·응답·페이지네이션·요청 ID·로그 보호는 최신 backend의 기존 구현을 사용한다.
- operations 전용 DB 연결·설정, 첫 관리자 CLI, 기존 `/operations/health`·Swagger 보존 및 DB readiness, 기존 공개 API URL의 Ingress 라우팅을 함께 연결한다. 프론트·AI·backend는 수정하지 않는다.
- 후속 changeset 004에서 관리자 이름·세션·soft delete·로그인 ID 재사용·감사 이름 스냅샷·AI 주체·INACTIVE 상태를 모놀리식에 맞춘다. 기존 MSA 계정에는 이름 원본이 없어 임의로 채우지 않는다. 구버전 계정이 존재하면 변경 전체를 차단하고 데이터를 보존하며 검증된 이름 이관을 별도 준비해야 한다.
- backend의 인증 단위·실제 PostgreSQL HTTP 테스트를 복사본 변형 없이 양쪽 앱에 실행한다. 동일 초기 데이터·요청을 양쪽 운영 이미지에 보내 응답·쿠키·헤더와 관리자·세션·감사 DB 상태도 직접 비교한다. 새 MSA 연결 설정·마이그레이션 실패·기존 배포 회귀를 따로 검사한다.
- 이번 MR은 operations 내부 감사의 원자성을 구현한다. 다른 서비스의 인증 위임·감사 이벤트 수신과 서비스 전체 보관 워커는 해당 서비스 이식 및 전체 정합성 단계에서 연결한다.

## 첫 MR 검증 기록 (2026-11-05)

- Node.js 24 이벤트 단위 3개, 실제 PostgreSQL 17.11·HTTP 통합 14개, 기준 목록 1개 통과. 수신 COMMIT 후 실제 SIGKILL·새 프로세스 재시작 시 업무 중복 없음, 10개 동시 재수신·source/type/payload 충돌·인증·과대 입력·재시도·잘못된 ACK·리다이렉트·타임아웃·동일 업무 순서 보호 포함.
- Liquibase 5.0.4 + PostgreSQL 17.11 검증 보고서 `passed=true`, 185단계 완료. 5개 신규 설치·재적용·기존 업무 함수·기존 DB 업그레이드·기존 changeset 이력과 대기 메시지 보존, customer/order 신규 changeset 실패 롤백 포함.
- Linux Python 기존 배포·선택·복구 회귀 49개 통과. npm의 잠금 파일 기반 설치와 audit에서 취약점 0건.
- 추적 변경은 msa/docs 안에만 있으며 backend/frontend/ai 변경 없음. 업무 앱 전체 빌드·전체 API 동등성·운영 Jenkins/k3s 실행은 이번 단계에서 검증하지 않았다.

## 두 번째 MR 검증 기록 (2026-11-05)

- `python msa/parity/verify-operations.py`: unchanged backend 인증 테스트 40개가 모놀리식과 operations에서 각각 통과했다. operations 설정 경계 테스트 2개도 통과했다. 새 DB용 migrate helper만 실제 operations Liquibase 이력을 확인하며 원본 인증 테스트의 검증 조건은 변경하지 않는다.
- 양쪽 production 이미지에서 동일 요청의 HTTP 상태·본문·요청 ID·CORS·쿠키 속성과 매 요청 후 관리자·세션·감사 DB 업무 값을 비교한 시나리오가 통과했다. 11개 API, 승인·권한 즉시 반영·비활성화·재활성화·비밀번호 초기화/변경·세션 회수·로그아웃·soft delete·ID 재사용·감사 스냅샷/권한/필터/검증 실패를 포함한다. 토큰은 형식·SHA-256 저장, 시각은 유효 범위·세션 9시간 TTL을 확인한 후 정규화한다.
- Linux Node.js 24 operations 이미지의 ESLint·TypeScript 빌드·단위 1개·E2E 5개 통과. 실제 배포용 공통 probe도 production 이미지의 `/operations/health/ready`와 OpenAPI를 통과했다.
- PostgreSQL 17.11 + Liquibase 5.0.4 전체 검증 `passed=true`, 201단계 통과. 새 004의 기존 이름 없는 계정 거절/데이터 보존과 중간 SQL 실패 시 컬럼·세션 테이블·이력 롤백을 확인했다.
- Linux Python 배포·변경 선택·실패 복구 회귀 50개와 95개 라우트 기준 목록 1개 통과. operations 운영 의존성 audit은 0건이다. 개발 도구 의존성의 low 5/moderate 23은 기준 브랜치 잠금 파일과 동일하며 이번 MR에서 major 교체하지 않았다.
- 임시 k3s v1.35.5+k3s1에 실제 operations 이미지와 별도 PostgreSQL/Secret/Liquibase를 연결해 최초 배포·정상 교체·의도적 readiness 실패 후 이전 이미지/배포 이력 복구를 확인했다. 교체/복구 중 HTTP 442건, 실패 0건이다. 기존 운영 kubeconfig는 사용하지 않았다.
- 운영 Jenkins 실행·공개 Ingress/HTTPS·다른 서비스와의 인증/감사 연동·전체 95개 API 동등성은 미검증이다. 이 MR이 전체 MSA 이식 완료를 의미하지 않는다. 이름 없는 기존 MSA 관리자 행이 있으면 실제 이름 이관을 준비하기 전 004와 후속 앱 배포를 중단한다.

## 다음 MR 계획 — customer 조회·인증 연결과 CI 실패 수정

!276 병합 커밋 `1ec031e`에서 `feature/msa-customer`를 분리했다. 같은 Task 160을 유지한다. customer의 23개 선언 중 조회 7개부터 제공하고, 쓰기·컨텍스트·PIN·청구 16개는 원자적 감사/통화/주문 의존성과 함께 후속 MR에 남긴다. 미구현 요청을 임시 성공으로 반환하지 않는다.

- 이번 공개 경로는 GET `/api/customers`, `/api/customers/:id`, `/api/companies`, `/api/companies/search`, `/api/companies/:id`, `/api/companies/:id/departments`, `/api/companies/:id/members`다. 원본 필터·페이지네이션·권한/MVP AI 범위·상태/soft delete·현재 주소 및 집계 규칙을 유지한다.
- customer 독립 스키마에 부서·선택 소속·월결제 자격·기본 주소·soft delete와 필요한 제약을 후속 changeset으로 추가한다. 기존 부서 배정·기본 주소·등록 시각은 근거 없이 만들지 않는다. 원본 없는 과거 등록 시각은 NULL, 기존 구성원 부서는 NULL로 보존한다.
- 세션은 operations에 보관한다. 서비스 인증을 사용하는 내부 조회로 매 요청 현재 세션/권한을 확인하며 customer DB에 관리자·세션을 복제하거나 operations DB를 직접 조회하지 않는다. 프론트/AI 요청은 변경하지 않는다.
- 동일 데이터와 요청으로 모놀리식/독립 customer+operations의 조회·오류·권한 갱신/세션 회수·HTTP/DB 결과를 대조한다. 기존 operations 인증·전체 DB·배포 회귀도 수행한다.

### Jenkins #23 실패 원인과 재현

[dva-msa #23](https://13.209.59.180/jenkins/job/dva-msa/23/console)은 `1ec031e`를 검사하며 스크립트 회귀 50개를 통과한 뒤 `Verify Event Transport`에서 실패했다. 앱 빌드·DB 적용·배포는 도달하지 않았다. 수신 업무는 커밋됐지만 `delivered_at`은 NULL이었다.

정상 전송 fixture도 timeout 검사용 100ms를 공유했다. 실제 정상 전송 테스트가 약 150ms 걸리면서 ACK를 받기 전에 중단됐고, 릴레이는 설계대로 미확정 메시지를 재시도 대상으로 보존했다. 운영 기본값은 5초다.

ACK를 수신 COMMIT 후 250ms 지연시키는 회귀를 추가해 수정 전 동일한 `delivered_at=NULL` 실패를 재현했다. 정상 fixture는 운영 기본값을 쓰고 의도적인 오류/timeout 검사만 100ms로 분리했다. 기존 완료/중복/실패/재시도 assertion은 유지한다. 수정 후 Node 단위 3개·실제 PostgreSQL/HTTP 통합 15개·기준 목록 1개가 통과했다. 실제 Jenkins 재실행 결과는 별도 확인 대상이다.

### 세 번째 MR 검증 기록 (2026-11-05)

- `python msa/parity/verify-customer.py`: 변경하지 않은 모놀리식 production 이미지와 독립 customer/operations production 이미지에 동일 요청 77건을 보내 HTTP 상태·본문·요청 ID·CORS·쿠키 속성·7개 GET OpenAPI 및 참조 DTO 스키마가 일치했다. 매 요청 후 고객·기업·부서·구성원 DB 업무 값이 같고 조회로 변경되지 않음을 확인했다. 권한별 조회·MVP AI·세션 회수/재로그인·삭제·잘못된 쿠키·숨겨진 데이터·입력 오류·리터럴 검색·빈 페이지도 포함한다.
- customer Linux Node.js 24 이미지에서 ESLint·TypeScript·단위 1개·E2E 4개·실제 HTTP 인증 연결/환경 경계 6개가 통과했다. 잘못된 서비스 응답·리다이렉트·과대 응답·2초 timeout·현재 권한 갱신·민감 필드 제외와 인증 장애 시 readiness 실패/독립 liveness를 확인했다.
- operations의 기존 원본 인증 테스트 40개가 양쪽에서 각각 통과했고 production HTTP·DB 비교와 배포 probe도 통과했다. 새 이미지의 ESLint·TypeScript·단위 1개·E2E 6개와 설정 경계 2개가 통과했다. 내부 경로는 서비스 인증을 요구하고 공개 Swagger에 노출되지 않으며 서비스 토큰만으로 공개 관리자 API에 접근하지 못한다.
- PostgreSQL 17.11 + Liquibase 5.0.4 전체 검증 `passed=true`, 216단계 통과. 기존 customer 003의 고객·소속·PIN 본문/버전·대기 이벤트·이력을 보존했으며, 004 중간 실패 시 DDL/데이터/이력 전체 롤백을 확인했다. 전체 테이블은 업무 20개+이벤트 10개+Liquibase 관리 10개다.
- Linux Python 배포·선택·복구 회귀 53개와 변경 Bash/Python 구문 검사가 통과했다. 서비스 비밀 값의 최초 생성·기존 값 보존·잘못된 값 거절/로그 보호를 검사했다. customer 운영 의존성 audit은 0건이며 개발 도구에는 low 5/moderate 23이 남아 있다.
- 임시 k3s v1.35.5+k3s1에서 실제 스키마·서비스 토큰·DB Secret·operations 내부 인증을 사용했다. 두 서비스 manifest 전체의 서버 dry-run, 최초 배포·정상 교체·의도적 readiness 실패 후 이미지/배포 이력 복구를 확인했다. customer HTTP 429건, operations 432건의 실패는 0건이다. 운영 kubeconfig는 사용하지 않았다.
- 최신 원격 기준은 `1ec031e`이며 backend/frontend/AI 추적 파일은 변경하지 않았다. 실제 Jenkins 재실행·운영 배포·공개 Ingress/HTTPS·남은 16개 customer 선언·다른 서비스·전체 API/이벤트 동등성은 미검증이다. customer 인증은 operations 가용성에 의존하며 두 서비스 선택 시 operations부터 배포한다. 기존 이름 없는 MSA 관리자 데이터가 있으면 operations 004의 기존 차단 정책이 유지된다.
