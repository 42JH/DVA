# Operations 서비스

관리자 인증·계정 관리·감사 조회를 담당한다. `backend/`의 동일 API·DTO·권한·SQL·트랜잭션 흐름을 이식했다. 프론트·AI의 요청 형식은 변경하지 않는다. Redis나 추가 브로커는 사용하지 않는다.

관련 작업: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160). 전체 순서는 [동등성 계획](../../../docs/msa-parity-plan.md)을 따른다. customer의 세션 인증과 쓰기 감사 이벤트를 연결했으며, 나머지 서비스의 감사·5년 보존 워커는 후속 작업이다.

## 실행

Node.js 24에서 `npm ci` 후 DB_HOST·DB_PORT·DB_USER·DB_PASSWORD·DB_NAME과 CORS_ORIGINS를 설정하고 `npm run start:dev`를 실행한다. 개발 환경만 `.env.development`/`.env`를 읽으며 production/test는 프로세스 환경만 사용한다. PowerShell에서 npm.ps1이 차단되면 `npm.cmd`를 사용한다.

- 기본 포트: `3005` (`PORT`로 변경 가능)
- Health: http://localhost:3005/operations/health
- DB readiness: http://localhost:3005/operations/health/ready
- Swagger: http://localhost:3005/operations/docs
- OpenAPI: http://localhost:3005/operations/docs-json

Health는 HTTP 프로세스 상태이며 readiness는 DB 접속 상태를 확인한다. 시작 시 인증·감사 준비 스키마가 없으면 기동에 실패한다. DDL은 앱에서 실행하지 않으며 Liquibase operations `005`까지 먼저 적용한다. 이름 없는 구버전 관리자 데이터가 있으면 임의의 이름을 채우지 않고 마이그레이션을 중단한다.

## 동일한 외부 API

- `POST /api/auth/login`, `POST /api/auth/signup`, `POST /api/auth/logout`
- `GET /api/auth/me`, `PATCH /api/auth/password`
- `GET /api/admins`, `PATCH /api/admins/:id`, `DELETE /api/admins/:id`, `PATCH /api/admins/:id/password`
- `GET /api/audit-logs`, `GET /api/audit-logs/:id`

9시간 고정 세션은 SHA-256 해시만 DB에 저장한다. 쿠키는 `dva_session`, HttpOnly·SameSite=Lax·Path=/api이며 production에서는 Secure를 사용한다. 상태/권한은 매 요청 DB에서 읽는다. 상태 변경·비밀번호 변경/초기화·삭제 시 세션 폐기와 감사 기록을 같은 트랜잭션에서 처리한다. 인증·DTO·업무 실패 감사도 원본과 동일하게 기록한다.

API는 공통 `/api` 응답/에러 envelope·페이지네이션·요청 ID·Origin 검사·no-store를 유지한다. OpenAPI는 `/api/docs-json`과 기존 `/operations/docs-json` 모두 제공한다. 허용 Origin은 정확한 origin 목록으로 설정하며 와일드카드를 받지 않는다. SWAGGER_ENABLED 기본값은 기존 operations와 동일하게 true이다.

최초 SYSTEM_ADMIN 생성은 Liquibase 적용 후 `node scripts/bootstrap-admin.cjs <loginId> <name>`에 비밀번호를 stdin으로 전달한다. 원본처럼 기존 SYSTEM_ADMIN이 있으면 거절하며 비밀번호를 인자/로그에 넣지 않는다.

## 서비스 내부 인증

`POST /internal/auth/session`은 서비스 Bearer `CUSTOMER_AUTH_TOKEN` 또는 `CONSULTATION_AUTH_TOKEN`과 본문 `{ "sessionToken": "기존 64자 세션 토큰" }`을 받아 기존 AuthService로 현재 세션·권한을 확인한다. 비밀번호·세션 해시를 반환하지 않으며 공개 Swagger·Ingress에서 제외한다. 서비스 토큰만으로 기존 관리자 API에 접근할 수 없다. 두 서비스 토큰을 모두 생략하면 이 내부 경로는 거절하고 기존 공개 인증은 유지한다.

배포 스크립트는 `dva/msa-customer-auth` Secret의 `customer-token`을 최초 한 번 생성하고 기존 값은 바꾸지 않는다. customer와 operations가 이 Secret을 공유한다. customer readiness가 새 내부 경로를 요구하므로 두 서비스가 선택되면 operations를 먼저 배포한다.

consultation은 별도 `dva/msa-consultation-auth` Secret의 `consultation-token`을 공유한다. 두 토큰은 세션 확인과 각 소유 서비스의 이벤트/역방향 조회 인증에 사용하며 customer·consultation은 operations 이후 배포한다. 세션/관리자를 다른 DB에 복제하지 않는다. 서비스 토큰으로 공개 관리자 API에 접근할 수 없다.

`POST /internal/events`는 source별 CUSTOMER_AUTH_TOKEN/CONSULTATION_AUTH_TOKEN을 검증하고 허용 action·target을 분리한다. customer는 기존 감사 범위를, consultation은 CALL_STARTED·CALL_SESSION·SUCCESS·AI/ADMIN만 사용한다. 준비 테이블도 customer/consultation별로 분리해 한 서비스의 확정/중단으로 다른 서비스 감사를 조작할 수 없다. inbox·감사 확정은 함께 COMMIT하며 공개 Swagger/Ingress에서는 제외한다. 감사 조회는 각 소유 서비스의 `/internal/audit/flush`에 결정을 확인하며 진행 중 업무 잠금을 강제로 해제하지 않는다. CUSTOMER_URL=`http://customer:3001`, CONSULTATION_URL=`http://consultation:3004`이며 자격정보·경로·query 없는 정확한 HTTP(S) origin만 허용한다. [고객 확인·통화 등록 계획](../../../docs/msa-caller-context-plan.md)에 장애 검증을 기록한다.

## 빌드와 자동 배포

저장소 루트에서 `docker build -t dva-operations:local -f msa/services/operations/Dockerfile msa`를 실행한다. Docker 빌드에서 ESLint·단위·E2E·TypeScript 검사를 실행하고, 운영 이미지는 개발 의존성 없이 node 사용자로 구동한다.

공통 Jenkins 파이프라인이 서비스 폴더를 자동 선택한다. develop-backend 병합 후 테스트·이미지 빌드·패키징·k3s 배포를 수행한다. 정상 배포된 다른 서비스와 변경 없는 DB는 생략한다. 배포 이력이 없거나 실패한 서비스는 재선택될 수 있다.

k8s.yaml은 dva 네임스페이스의 기존 `operations-db` Secret(PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE)을 사용한다. Traefik websecure/letsencrypt에서 `/operations`와 위 3개 `/api` prefix를 이 서비스로 라우팅한다. 현재 문서에 있는 프론트 주소와 MSA 주소를 CORS_ORIGINS로 허용한다. 프론트의 API base host 전환은 별도이며 이 MR에서 프론트/AI를 수정하지 않는다. 병합 후 운영 확인 주소:

- https://k15d109.p.ssafy.io/operations/health
- https://k15d109.p.ssafy.io/operations/docs
- https://k15d109.p.ssafy.io/operations/docs-json

새 Pod 준비 전 기존 Pod를 유지한다(maxUnavailable=0, maxSurge=1). readiness·종료 유예와 기존 공통 실패 복구를 사용한다. 최초 배포에는 이전 버전이 없으며, 단일 노드 장애까지 무중단을 보장하지 않는다. 두 서비스 배포는 하나의 트랜잭션이 아니므로 뒤 서비스가 실패해도 먼저 성공한 서비스는 유지하고 재실행 시 미배포 서비스만 선택한다.

## 검증

```bash
# 저장소 루트, 호스트 DB 포트를 열지 않는 임시 Docker DB
python msa/parity/verify-operations.py
# 선택 실행: 운영 kubeconfig 없이 임시 k3s + PostgreSQL로 배포/복구 검사
python msa/deploy/tests/integration_app_rollout.py --service operations --image dva-operations:local
```

검증기는 변경하지 않은 `backend/test/auth*.cjs`를 양쪽 checks 이미지에서 실행한다. operations만 실제 Liquibase 스키마를 사용한다. 이후 양쪽 production 이미지에 같은 요청을 보내 응답·쿠키 속성·관리자·세션·감사 데이터를 비교한다. 무작위 토큰·생성 시각은 형식/9시간 TTL/해시 저장을 먼저 검증하고 비교에서 정규화한다. 다른 서비스의 테이블이나 전체 업무 동등성을 검증한 결과로 확대하지 않는다.

로그/보고서는 `msa/liquibase/verification-logs/operations/`에 남는다. Jenkins는 operations가 빌드 대상으로 선택되면 이 검증을 통과한 뒤에만 앱 배포를 진행한다. 운영 Webhook 배포·외부 HTTPS·다른 서비스 연동은 별도 확인한다.

2026-11-05 customer 쓰기 연결 후 재검증: 원본 인증 40개를 양쪽에 실행해 통과했고 operations 설정 2개, 단위 1개, E2E 6개, production HTTP·DB 비교와 실제 배포 probe도 통과했다. 별도 customer 비교에서 준비·확정·중단·중복·변조·지연·SIGKILL 복구를 확인했다. 임시 k3s 최초 배포·교체·실패 복구 중 operations HTTP 450건의 실패는 0건이었다. DB 전체 228단계와 Linux 배포 회귀 54개도 통과했다. 운영 Jenkins·공개 HTTPS·자동 업무/보관 워커·전체 95개 API는 미검증이다.
