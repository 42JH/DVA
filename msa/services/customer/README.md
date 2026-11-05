# Customer 서비스

모놀리식의 고객·기업·부서·구성원 조회 7개 API를 동일한 DTO·권한·SQL·응답 형식으로 제공한다. 프론트·AI 요청 형식은 바꾸지 않는다. 관련 작업은 [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160), 전체 범위와 후속 작업은 [동등성 계획](../../../docs/msa-parity-plan.md)을 따른다.

## 공개 API

- `GET /api/customers`, `GET /api/customers/:id`
- `GET /api/companies`, `GET /api/companies/search`, `GET /api/companies/:id`
- `GET /api/companies/:id/departments`, `GET /api/companies/:id/members`

필터·페이지네이션·검증 오류·soft delete·탈퇴 고객 처리·기본 주소·집계와 기존 MVP AI 조회 범위를 유지한다. 쿠키가 없을 때 허용되던 조회만 세션 없이 허용하며, 잘못되거나 회수된 쿠키를 AI 요청으로 전환하지 않는다. 쓰기·통화 컨텍스트·PIN·월 청구 16개 선언은 후속 MR 대상이며 성공 응답을 제공하지 않는다. 조회에는 원본과 동일하게 감사 쓰기가 없다.

## 실행과 DB

Node.js 24에서 `npm ci` 후 아래 환경을 설정하고 `npm run start:dev`를 실행한다. production/test는 `.env`를 읽지 않는다.

- customer 전용 `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `OPERATIONS_URL`: 예시 `http://operations:3005`, 경로·자격증명 없는 정확한 origin
- `CUSTOMER_AUTH_TOKEN`: operations와 공유하는 32~256자 ASCII 서비스 비밀 값
- `CORS_ORIGINS`: 정확한 origin 목록, `PORT` 기본 3001, `SWAGGER_ENABLED` 기본 true

customer Liquibase `004`를 먼저 적용한다. 구버전 고객·기업·구성원·PIN·대기 이벤트를 보존하고, 원본이 없는 과거 기업 등록 시각·부서 배정·기본 주소는 NULL로 남긴다. 기존 PIN 주소 규칙과 버전은 이번 단계에서 바꾸지 않는다. 앱은 시작할 때 스키마를 확인하며 DDL을 실행하지 않는다.

세션은 operations DB에만 저장한다. customer는 매 요청 `POST /internal/auth/session`에 서비스 Bearer와 기존 세션 토큰을 전달해 현재 권한을 확인한다. 관리자·세션을 복제하거나 operations DB를 직접 조회하지 않는다. 응답 크기 8KiB·요청 2초 제한과 리다이렉트 거절을 적용하며 인증 서비스 장애는 서버 오류로 처리한다.

- `/customer/health`: 프로세스 상태
- `/customer/health/ready`: customer DB·operations DB·내부 인증 경로/서비스 토큰 확인
- `/customer/docs`, `/customer/docs-json`: 기존 Swagger 주소
- `/api/docs`, `/api/docs-json`: 동일 API 문서의 서비스 내 별칭

## 빌드·배포·검증

```sh
docker build -t dva-customer:local msa/services/customer
python msa/parity/verify-customer.py
python msa/deploy/tests/integration_app_rollout.py --service customer --image dva-customer:local
```

Docker 빌드는 ESLint·단위·E2E·TypeScript 검사를 실행한다. `checks` target은 실제 HTTP를 사용하는 인증 연결·설정 경계 테스트도 실행한다. 운영 이미지에는 개발 의존성을 넣지 않는다.

비교 검증은 변경하지 않은 backend 이미지와 독립 customer/operations 이미지, 실제 Liquibase 스키마를 사용한다. 동일한 77개 요청의 상태·본문·요청 ID·CORS·쿠키 속성·7개 GET OpenAPI 및 매 요청 후 customer DB 업무 값을 비교한다. 세션 회수·비활성화/재활성화·삭제와 유효하지 않은 입력·숨겨진 데이터·검색 특수문자도 포함한다. 로그는 `msa/liquibase/verification-logs/customer/`에 남는다.

Jenkins는 customer 선택 시 `Verify Customer Parity`를 실행한다. DB 적용 뒤 operations를 먼저 배포하고 customer를 배포한다. 공통 배포 스크립트가 `dva/msa-customer-auth` Secret의 `customer-token`을 최초 한 번 생성한다. 기존 값은 보존하며 잘못된 값이나 접근 실패가 있으면 교체하지 않고 배포를 중단한다. 실제 비밀 값은 Git·명령 인자·오류 메시지에 넣지 않는다. 두 앱은 각 `<service>-db` Secret의 PG* 필드를 사용한다.

Ingress는 기존 `/customer`와 `/api/customers`, `/api/companies`를 customer로 라우팅한다. 내부 인증 경로는 Ingress로 공개하지 않는다. 공개 HTTPS·운영 Jenkins 결과와 전체 MSA 동등성은 별도 검증 대상이다.