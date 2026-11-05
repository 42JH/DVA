# Customer 서비스

모놀리식의 고객·기업·부서·구성원 조회 7개와 쓰기 10개 API를 동일한 DTO·권한·SQL·응답 형식으로 제공한다. 프론트·AI 요청 형식은 바꾸지 않는다. 관련 작업은 [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160), 이번 쓰기의 완료 경계와 제한은 [쓰기 계획](../../../docs/msa-customer-writes-plan.md), 전체 범위는 [동등성 계획](../../../docs/msa-parity-plan.md)을 따른다.

## 공개 API

- `GET /api/customers`, `GET /api/customers/:id`
- `GET /api/companies`, `GET /api/companies/search`, `GET /api/companies/:id`
- `GET /api/companies/:id/departments`, `GET /api/companies/:id/members`
- `POST /api/customers`
- `POST /api/companies`, `PATCH /api/companies/:id`, `DELETE /api/companies/:id`
- `POST /api/companies/:id/departments`, `PATCH /api/departments/:id`, `DELETE /api/departments/:id`
- `POST /api/companies/:id/members`, `PATCH /api/members/:id`, `DELETE /api/members/:id`

필터·페이지네이션·검증 오류·soft delete·탈퇴 고객 처리·기본 주소·집계와 기존 MVP AI 접근 범위를 유지한다. 쿠키가 없을 때 원본이 허용한 요청만 AI로 처리하며, 잘못되거나 회수된 쿠키를 AI 요청으로 전환하지 않는다. 단건/일괄 직원 등록과 기존 고객 식별·중복·부서 변경·탈퇴·기업 삭제 시 연결 데이터의 처리 및 감사도 이식했다. 조회에는 원본과 동일하게 감사 쓰기가 없다.

고객 컨텍스트 POST·고객 PATCH·기업 월 청구 GET·고객 PIN GET/POST·PIN PATCH, 6개 선언은 통화/주문 의존성과 함께 후속 MR 대상이며 성공 응답을 제공하지 않는다. 월별 청구 초기화 등 원본의 자동 업무 워커도 아직 이식 전이다.

## 실행과 DB

Node.js 24에서 `npm ci` 후 아래 환경을 설정하고 `npm run start:dev`를 실행한다. production/test는 `.env`를 읽지 않는다.

- customer 전용 `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `OPERATIONS_URL`: 예시 `http://operations:3005`, 경로·자격증명 없는 정확한 origin
- `CUSTOMER_AUTH_TOKEN`: operations와 공유하는 32~256자 ASCII 서비스 비밀 값
- `CORS_ORIGINS`: 정확한 origin 목록, `PORT` 기본 3001, `SWAGGER_ENABLED` 기본 true

customer와 operations Liquibase `005`를 먼저 적용한다. 구버전 고객·기업·구성원·대기 이벤트를 보존하고, 원본이 없는 과거 기업 등록 시각·부서 배정·기본 주소는 NULL로 남긴다. customer `005`는 기업 PIN의 부서·soft delete를 추가하고 원본 043처럼 양쪽 PIN 주소의 latitude/longitude를 제거한다. PIN 버전·소유권은 보존하며 유일하게 일치하는 기존 부서만 연결한다. 좌표 제거 전 운영 백업을 별도로 준비해야 한다. 앱은 시작할 때 스키마를 확인하며 DDL을 실행하지 않는다.

세션은 operations DB에만 저장한다. customer는 매 요청 `POST /internal/auth/session`에 서비스 Bearer와 기존 세션 토큰을 전달해 현재 권한을 확인한다. 관리자·세션을 복제하거나 operations DB를 직접 조회하지 않는다. 응답 크기 8KiB·요청 2초 제한과 리다이렉트 거절을 적용하며 인증 서비스 장애는 서버 오류로 처리한다.

- `/customer/health`: 프로세스 상태
- `/customer/health/ready`: customer DB·operations DB·내부 인증/이벤트 경로와 서비스 토큰 확인
- `/customer/docs`, `/customer/docs-json`: 기존 Swagger 주소
- `/api/docs`, `/api/docs-json`: 동일 API 문서의 서비스 내 별칭

## 빌드·배포·검증

```sh
docker build -t dva-customer:local -f msa/services/customer/Dockerfile msa
python msa/parity/verify-customer.py
python msa/deploy/tests/integration_app_rollout.py --service customer --image dva-customer:local
```

Docker 빌드는 ESLint·단위·E2E·TypeScript 검사를 실행한다. `checks` target은 실제 HTTP를 사용하는 인증 연결·설정 경계 테스트도 실행한다. 운영 이미지에는 개발 의존성을 넣지 않는다.

비교 검증은 변경하지 않은 backend 이미지와 독립 customer/operations 이미지, 실제 Liquibase 스키마를 사용한다. production의 동일한 조회/인증 77개 요청과 Secure 쿠키·7개 GET OpenAPI를 비교한다. 이어 같은 compiled 이미지를 기본 NODE_ENV=test로 실행해 자동 업무 워커를 끈 상태에서 쓰기/조회/인증 54개 요청, 추가 쓰기 10개 OpenAPI와 매 응답 직후 고객 업무 6개 테이블·감사 전체 행을 비교한다. 감사 행을 필터링하지 않는다. 원본 직원 입력 테스트 4개와 중복·변조·준비 실패·rollback·지연 확정·실제 생산자 SIGKILL 복구도 검사한다. production의 자동 청구 워커·전체 DB 동등성은 후속 검증이다. 보고서에 두 환경을 구분하며 로그는 `msa/liquibase/verification-logs/customer/`에 남는다.

Jenkins는 customer 선택 시 `Verify Customer Parity`를 실행한다. DB 적용 뒤 operations를 먼저 배포하고 customer를 배포한다. 공통 배포 스크립트가 `dva/msa-customer-auth` Secret의 `customer-token`을 최초 한 번 생성한다. 기존 값은 보존하며 잘못된 값이나 접근 실패가 있으면 교체하지 않고 배포를 중단한다. 실제 비밀 값은 Git·명령 인자·오류 메시지에 넣지 않는다. 두 앱은 각 `<service>-db` Secret의 PG* 필드를 사용한다.

Ingress는 기존 `/customer`와 `/api/customers`, `/api/companies`, `/api/members`, `/api/departments`를 customer로 라우팅한다. 내부 경로는 Ingress로 공개하지 않는다. 공개 HTTPS·운영 Jenkins 결과와 전체 MSA 동등성은 별도 검증 대상이다.

## 감사 완료와 복구

쓰기 중 operations의 `POST /internal/events`에 AuditPrepared를 보내 원본 감사 INSERT·제약·트리거로 행을 준비한다. 이때 운영 감사 조회에는 노출하지 않는다. 고객 업무와 AuditCommitted outbox를 함께 커밋한 뒤 operations의 inbox+감사 확정 COMMIT/ACK를 확인해야 성공 응답한다. 업무 실패는 AuditAborted를 남기고, COMMIT 응답 유실은 성공/실패를 임의로 단정하지 않는다. outbox는 250ms 릴레이와 기존 재시도 정책을 사용하며 확인 실패를 성공 처리하지 않는다.

기업 삭제처럼 감사가 많은 트랜잭션은 확정 ID를 1,000개씩 나눠 같은 업무 트랜잭션의 outbox에 저장한다. 같은 aggregate의 전달 순서를 유지하고 마지막 확정 ACK까지 기다린다. 감사 조회도 남은 준비가 있으면 전송을 확인하므로 중간 일부만 성공 조회로 반환하지 않는다.

operations 감사 조회는 미확정 준비가 있으면 서비스 Bearer 전용 `POST /internal/audit/flush`로 결정 확인을 요청한다. customer는 업무 트랜잭션 잠금과 확정 outbox로 진행 중·커밋·중단을 구분한다. 종료된 생산자의 업무가 rollback됐으면 준비를 중단하고 늦은 준비를 차단한다. 다른 DB를 직접 조회하거나 관리자/세션을 복제하지 않는다. 기술 상태의 장기 보관·정리와 전체 분산 장애 검증은 후속 단계다.
