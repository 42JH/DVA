# 모놀리식 백엔드 공통 기반

Jira: [S15P31D109-134](https://ssafy.atlassian.net/browse/S15P31D109-134). Node.js 24, NestJS 11, PostgreSQL 17, `pg`를 사용한다.
업무 API의 초기 계약은 팀이 제공한 API 명세 초안을 따른다. MSA 애플리케이션과 독립적으로 관리한다.

NestJS 11 호환성을 유지하면서 전이 의존성의 알려진 DoS 취약점을 수정하기 위해 overrides로
multer 2.5.0, body-parser 2.4.0, js-yaml 5.5.0을 지정한다. 상위 패키지가 수정 버전을 포함하면 override 제거 여부를 검토한다.
Swagger 12는 NestJS 12를 요구하므로 이번 기반에서 프레임워크 major를 올리지 않는다.

## 로컬 실행

```sh
cd backend
npm ci
# Windows PowerShell: Copy-Item .env.example .env.development
cp .env.example .env.development
# .env.development의 개발 DB 접속 정보와 AI_AGENT_URL을 설정한다.
npm run start:dev
```

개발 전용 PostgreSQL을 사용한다. DB 포트가 로컬에 없으면 `compose.yaml`로 전체 서비스를 실행하거나
팀 개발 DB/SSH 터널의 주소를 사용한다. 운영 DB를 테스트 대상으로 지정하지 않는다.
업무 스키마는 기존 `infra/database/migrate.sh`와 `backend/migrations/`로 별도 적용한다.
현재 앱 시작 시의 기존 PBX 수신 테이블 생성(001)은 유지하며, 업무 migration 자동 적용이나 ORM schema sync는 추가하지 않는다.

`NODE_ENV`를 실행 환경에 지정하면 development는 `.env.development` → `.env`, test/production은 주입한 환경변수만 읽는다.
실행 환경변수는 파일보다 우선한다. `NODE_ENV` 기본값은 development다.
파일에서 `NODE_ENV`를 바꾸어 환경 선택에 의존하지 않고 실행 시 지정한다.

| 설정 | 규칙 |
|---|---|
| `NODE_ENV` | development / test / production |
| `PORT`, `DB_PORT` | 정수 1~65535, 기본 3000 / 5432 |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | 필수, 누락/빈 값이면 시작 중단 |
| `AI_AGENT_URL` | 필수 HTTP(S) URL. 기존 readiness가 AI 연결까지 확인한다. 자격정보·query·fragment 금지 |
| `CORS_ORIGINS` | 정확한 origin을 쉼표로 구분. 예: `http://localhost:5173,https://13.209.59.180`. 경로·와일드카드 금지 |
| `SWAGGER_ENABLED` | true / false. 개발 기본 true, 테스트·운영 기본 false |
| `PBX_WEBHOOK_TOKEN` | 선택, 설정하면 공백 없는 32바이트 이상 토큰. 미설정 시 PBX 수신은 기존대로 503 |

설정 검증 오류에는 변수 이름만 출력하고 값은 출력하지 않는다. 실제 `.env*`는 Git에서 제외하고 `.env.example`만 관리한다.
인증 관련 JWT 설정·관리자 비밀번호는 이번 기반에서 요구하지 않는다.

## 구조와 역할

```text
src/
  config/                  # 실행 환경 검증
  database/                # Pool 수명주기, 트랜잭션, DatabaseModule
  common/
    dto/                   # 공통 요청·응답 DTO
    errors/                # ApiException 및 오류 코드
    http/                  # 전역 검증·응답·예외·요청 추적
    pagination.ts
  health/                  # 기존 liveness/readiness
  webhooks/pbx/            # 기존 PBX controller/service/repository
  configure-application.ts # HTTP 공통 설정, 테스트도 같은 함수 사용
```

신규 업무는 `src/<업무>/`에 Module·Controller·Service·Repository·dto를 배치한다.
Controller는 HTTP/DTO, Service는 업무 규칙과 트랜잭션 경계, Repository는 매개변수화 SQL을 담당한다.
HTTP 계층에서 SQL을 실행하거나 범용 BaseRepository에 모든 업무를 넣지 않는다.

DatabaseModule을 가져오면 DatabaseService를 주입할 수 있다. 단순 쿼리는 `database.pool.query(sql, values)`를 사용한다.
여러 저장을 묶을 때는 다음처럼 같은 PoolClient를 모든 Repository에 전달한다.

```ts
await database.transaction(async (client) => {
  await repository.save(input, client);
  await auditRepository.record(event, client);
});
```

Repository의 `client` 인수는 PoolClient로 선언하고 전달받은 client에서 쿼리한다.
트랜잭션 내부에서 `pool.query`를 호출하면 다른 연결을 사용할 수 있으므로 사용하지 않는다.
성공하면 COMMIT, 예외면 ROLLBACK하며 연결을 반환한다. 롤백 자체가 실패하면 연결을 폐기하고 최초 예외를 유지한다.
외부 HTTP 응답을 기다리는 동안 DB 트랜잭션을 유지하지 않는다.

## API 계약

신규 Controller에는 `/api`가 자동으로 붙는다. Controller에 접두사를 중복 작성하지 않는다.
기존 `/health`, `/health/ready`, `/webhooks/pbx/call-ended`는 경로와 응답을 유지한다.
컨테이너 Nginx는 신규 `/api/...`를 그대로 전달한다. 기존 `/api/health`, `/api/health/ready`,
`/api/webhooks/pbx/call-ended`에만 `/api`를 제거하여 기존 백엔드 경로로 전달한다.
공개 호스트 Nginx는 현재 PBX·Jenkins만 허용한다. 신규 업무 API를 외부에 공개하는 변경은 인증 구현 이후 별도로 적용한다.

| 응답 | 형식 |
|---|---|
| 단건 | Controller가 반환한 값을 `{ data, meta: { requestId } }`로 감싼다 |
| 목록 | `new ListResponse(rows, limit)`를 반환하면 `{ data: [], hasNext }`만 반환한다 |
| 오류 | `{ error: { code, message, details: [] }, meta: { requestId } }` |
| 204 | `@HttpCode(204)`, 본문 없음 |

성공 값에 result/code/message/timestamp를 추가하지 않는다. ListResponse는 같은 조건과 고정 정렬로 `limit + 1`개를 조회한 결과를 받는다.
SQL의 limit/offset은 검증된 PaginationQueryDto를 사용하고 정렬에 고유 ID를 포함한다.
기본 limit=20, 1~100, offset=0 이상 안전한 정수다. 빈 값·소수·지수 표기·반복 query·추가 속성은 400이다.
총건수·총페이지수·page 객체를 반환하지 않는다.

DTO는 런타임 class로 선언하고 class-validator 데코레이터를 지정한다. 전역 ValidationPipe는
명시적 변환만 사용하고 등록하지 않은 필드를 거절한다. 식별자·전화번호 등 문자열을 임의로 숫자로 바꾸지 않는다.
중첩 DTO는 `@ValidateNested`와 `@Type`을 지정한다. nullable과 생략 가능 여부는 업무 계약대로 개별 DTO에서 선언한다.
PATCH의 변경값 유무·업무 규칙·expectedVersion 검사는 각 업무에서 구현한다.

형식 오류는 400 INVALID_REQUEST, 업무 의미 검증은 `ApiException(422, 'BUSINESS_RULE_VIOLATION', safeMessage, details)` 등으로 구분한다.
검증 details는 필드 경로와 검증 규칙 이름만 담으며 원본 입력값을 담지 않는다.
DB UNIQUE/FK/CHECK 위반은 SQLSTATE로 분류하고 SQL·테이블명·파라미터·스택을 응답에 넣지 않는다.
ApiException에는 사용자에게 공개할 수 있는 메시지/상세만 전달한다.

X-Request-Id가 유효한 UUID면 유지하고 없거나 잘못된 값이면 새 UUID를 만든다. 모든 응답 헤더에 반환하며
API 단건/오류 meta에도 넣는다. Idempotency-Key는 업무 중복 방지용으로 별개이며 이번 작업에서는 저장소나 처리기를 구현하지 않는다.
요청 로그에는 method·route template·상태·소요시간·requestId만 남기고 실제 경로 ID·query·headers·body는 기록하지 않는다.
신규 API 응답은 no-store다. 인프라 로그 수집·모니터링 설정은 112번 작업 범위다.

CORS_ORIGINS는 브라우저의 정확한 scheme/host/port를 지정한다. 빈 목록은 외부 origin을 허용하지 않으며
Origin 없는 서버 간 요청은 처리한다. 관리자 Bearer·통화 헤더·멱등키 헤더를 허용하고 request ID·Location·Retry-After를 노출한다.
쿠키 인증은 사용하지 않는다. CORS는 인증/권한 검사의 대체 수단이 아니다.

## Swagger와 자동 검증

개발 문서는 `http://localhost:3000/api/docs`, OpenAPI JSON은 `/api/docs-json`이다.
공통 ErrorResponseDto와 RequestMetaDto 및 Bearer 인증 정의를 제공한다. 실제 Bearer 인증 구현은 포함하지 않는다.
업무 Controller의 Swagger 응답에는 전역 envelope를 포함한 최종 응답 스키마를 명시한다.

```sh
npm run lint
npm run format:check
npm test
# Docker Desktop Linux 모드 또는 Linux Docker가 필요하다.
npm run check:docker
```

Docker 검증은 checks stage에서 lint·format·설정/HTTP 테스트·컴파일을 실행하고, 이어서 임시 PostgreSQL에서
트랜잭션 커밋/롤백과 기존 PBX 중복·동시성·입력·오류·재시작 테스트를 실행한다.
운영 이미지도 실제 기동하여 개발 도구·테스트·환경 파일 제외를 검사하고, 실제 Nginx를 경유한
신규 /api 경로 보존·기존 /api 경로 변환·readiness 비공개·PBX 수신 및 운영 Swagger 기본 비활성화를 확인한다.
임시 네트워크는 internal이고 DB 호스트 포트·호스트 볼륨을 만들지 않는다. DB 데이터는 tmpfs이며 운영 DB에 접속하지 않는다.
이번 실행에서 만든 랜덤 이름의 컨테이너·네트워크·검증 이미지 태그만 정리한다. Docker build cache는 유지한다.
운영 이미지는 test·개발 도구·환경 파일을 포함하지 않는다.

Jenkins의 Backend checks 단계가 성공한 뒤에만 이미지 패키징과 배포 접근 검증으로 진행한다.
실제 Jenkins 실행 결과는 MR 반영 후 확인해야 한다. 기존 `DEPLOY_LIGHTSAIL=false` 기본값을 유지한다.

## 후속 기능

관리자 로그인·권한·JWT 8시간·auth_version·최초 관리자 생성은 83번 작업에서 구현한다.
고객·주문 등 업무 API, 프론트 배포/로그인 연동, 업무 스키마 변경 및 MSA 구성은 포함하지 않는다.
