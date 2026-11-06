# Customer 서비스

[주문 조회 이식](../../../docs/msa-order-reads-plan.md)은 기존 공개 customer API를 유지하고 내부 주문 조회 범위 확인만 추가한다. `ORDER_URL`은 미설정 시 기존 API의 시작을 막지 않으며, k3s에는 `http://order:3002`를 주입한다. 관리자 이전 주소는 삭제되지 않은 고객, AI는 현재 발신번호의 ACTIVE 고객을 공유 잠금으로 확인한 동안 order의 조회 callback을 기다린다. 내부 요청은 기존 토큰·source/type/payload 검증을 거치며 개인정보 응답을 저장하지 않는다. 공개 `/api/customers/:id/addresses`는 order Ingress로 전달한다.

모놀리식의 고객·기업·부서·구성원과 고객 확인/통화 등록·개인 PIN·기업 청구 조회 24개 API를 제공한다. 프론트·AI 요청 형식은 바꾸지 않는다. 관련 작업은 [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160), [쓰기 계획](../../../docs/msa-customer-writes-plan.md), [고객 확인·통화 등록 계획](../../../docs/msa-caller-context-plan.md), [전체 동등성 계획](../../../docs/msa-parity-plan.md)을 따른다.

## 공개 API

- `GET /api/customers`, `GET /api/customers/:id`
- `GET /api/companies`, `GET /api/companies/search`, `GET /api/companies/members/search`, `GET /api/companies/:id`
- `GET /api/companies/:id/billing`
- `GET /api/companies/:id/departments`, `GET /api/companies/:id/members`
- `POST /api/customers`
- `POST /api/customers/context`, `PATCH /api/customers/:id`
- `GET /api/customers/:id/pins`, `POST /api/customers/:id/pins`, `PATCH /api/pins/:id`
- `POST /api/companies`, `PATCH /api/companies/:id`, `DELETE /api/companies/:id`
- `POST /api/companies/:id/departments`, `PATCH /api/departments/:id`, `DELETE /api/departments/:id`
- `POST /api/companies/:id/members`, `PATCH /api/members/:id`, `DELETE /api/members/:id`

필터·페이지네이션·검증 오류·soft delete·탈퇴 고객 처리·기본 주소·집계와 기존 MVP AI 접근 범위를 유지한다. 고객 확인·생성·상세·수정은 관리자 쿠키가 없으면 원본과 동일한 AI_BUSINESS_TOKEN Bearer를 요구하며, 잘못되거나 회수된 쿠키를 AI 요청으로 전환하지 않는다. 단건/일괄 직원 등록과 기존 고객 식별·중복·부서 변경·탈퇴·기업 삭제 시 연결 데이터의 처리 및 감사도 이식했다. 조회에는 원본과 동일하게 감사 쓰기가 없다.

고객 확인은 call 없이 현재 고객·소속·결제 자격·개인 PIN 전체를 조회하며 통화·감사를 저장하지 않는다. call이 있으면 consultation에 등록 이벤트를 보내 같은 통화를 생성·재사용하고 CALL_STARTED 감사 확정까지 기다린다. 공개 경로·Origin/쿠키·오류·메타·후행 슬래시는 기존 customer가 처리한다. 최신 `04b7346`처럼 고객 생성·전화번호 검색·구성원 등록·고객 확인의 전화번호는 숫자 문자열 11자리다.

현재 공개 선언은 24/24개다. [기업 청구 조회·월 전환](../../../docs/msa-billing-months-plan.md)은 기존 ORDER_URL과 CUSTOMER_AUTH_TOKEN으로 order 원장을 연결한다. 조회는 월 원장을 만들지 않으며 삭제 기업의 과거 스냅샷도 반환한다. order의 월 초기화 callback 동안 customer의 비삭제 기업 공유 잠금을 유지한다. 결제 완료 사용액 적립과 다른 자동 업무 워커는 후속이다. [고객 수정·개인 PIN 계획](../../../docs/msa-customer-pins-plan.md)을 따른다.

## 최신 기업 검색·AI 인증

`GET /api/companies/search`는 관리자 쿠키와 독립적으로 AI_BUSINESS_TOKEN Bearer를 요구한다. `GET /api/companies/members/search`는 모든 ACTIVE 관리자 세션을 요구하며 서비스 토큰으로 대체할 수 없다. 사원 검색은 이름·전화번호·사번·부서명으로 모든 단어를 검색하고 주소 없는 사원을 포함한다. 기업명·주소는 사원 검색에서 제외한다. 두 검색의 q는 NFC/공백 정규화 후 1~100자이고 NUL을 거절한다.

배포는 선택 Secret `dva/msa-ai-business`의 `AI_BUSINESS_TOKEN` 키를 참조한다. 최신 backend와 같은 기존 AI 토큰을 설정하며 값을 임의 생성·교체하지 않는다. 없으면 해당 AI 요청은 503이고 관리자 세션과 내부 서비스 인증은 독립적으로 동작한다. PIN의 별도 MVP 접근 계약은 원본 그대로다.

원본 053에서 퇴역한 기업 PIN은 더 이상 읽기·부서 이름 갱신·기업/부서 삭제·감사에 사용하지 않는다. customer 007은 기존 `company_pins`를 같은 물리 이름의 보관 테이블로 유지한다. DB 선적용 중 구버전 앱의 SQL과 기존 데이터를 보존하기 위해 DROP/rename하지 않는다. 이 테이블은 현재 업무 데이터 비교 대상에서 제외하고 실제 행 보존을 별도로 검증한다. 개인 PIN·주문 주소 스냅샷은 이 퇴역의 대상이 아니다.

## 고객 수정·개인 PIN

고객 이름 단독 AI 수정은 통화 헤더가 불필요하며, 내 주소 수정/삭제는 진행 중인 본인 통화를 확인한다. 상태·월결제 자격은 현재 관리자 세션과 허용 Origin이 필요하고 탈퇴 복구는 거절한다. PIN 조회는 진행 중 통화만 허용하지만 쓰기는 종료 후에도 가능하다. 삭제·보관 만료·다른 고객/재사용 번호의 통화는 거절한다. PIN은 삭제 데이터 숨김·리터럴 검색/페이지/total_count·DB 주소 중복·부분 수정·오래된 expectedVersion 허용·실제 변경 시 버전 증가를 원본처럼 처리한다.

AI 요청은 consultation에 인증한 통화 범위 이벤트를 보내고, consultation은 쓰기 통화의 FOR SHARE 잠금을 유지한 채 고정된 customer 내부 경로에서 원본 업무를 실행한다. customer의 업무·수신 기록·감사 결정 커밋과 감사 ACK까지 완료한 뒤 응답한다. 같은 내부 쓰기 이벤트는 다시 반영하지 않으며 주소/전화번호 대신 입력 해시와 결과 식별자/버전만 inbox에 보관한다. 조회 이벤트는 현재 페이지를 다시 읽고 응답을 저장하지 않는다. 교차 DB 직접 조회나 새 외부 API는 없다.

## 실행과 DB

Node.js 24에서 `npm ci` 후 아래 환경을 설정하고 `npm run start:dev`를 실행한다. production/test는 `.env`를 읽지 않는다.

- customer 전용 `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `OPERATIONS_URL`: 예시 `http://operations:3005`, 경로·자격증명 없는 정확한 origin
- `CUSTOMER_AUTH_TOKEN`: operations·consultation과 공유하는 32~256자 ASCII 서비스 비밀 값
- `CONSULTATION_URL`: 통화 등록·AI 고객 주소/PIN 통화 범위용 정확한 HTTP(S) origin. k8s는 `http://consultation:3004`; 미설정 시 해당 의존 요청은 503이다.
- `CONSULTATION_AUTH_TOKEN`: consultation에서 오는 내부 고객 조회·통화 범위 실행의 서비스 비밀 값. 공개 API 인증을 대신하지 않는다.
- `CORS_ORIGINS`: 정확한 origin 목록, `PORT` 기본 3001, `SWAGGER_ENABLED` 기본 true

customer·operations `007`과 consultation `004`까지 먼저 적용한다. 구버전 고객·기업·구성원·대기 이벤트를 보존하고, 원본이 없는 과거 기업 등록 시각·부서 배정·기본 주소는 NULL로 남긴다. customer `005`의 좌표 제거는 운영 백업을 먼저 준비해야 한다. `006`은 개인 PIN의 soft delete·활성 주소 유일성을 추가하고 기존 소유권·주소·버전을 보존한다. 앱은 스키마를 확인하며 DDL을 실행하지 않는다.

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

비교 검증은 변경하지 않은 backend 이미지와 독립 customer/operations 이미지, 실제 Liquibase 스키마를 사용한다. production의 동일한 조회/인증 100개 요청과 Secure 쿠키·8개 GET OpenAPI를 비교한다. 이어 같은 compiled 이미지를 기본 NODE_ENV=test로 실행해 자동 업무 워커를 끈 상태에서 쓰기/조회/인증 54개 요청, 추가 쓰기 10개 OpenAPI와 매 응답 직후 고객 업무 5개 테이블·감사 전체 행을 비교한다. 감사 행을 필터링하지 않는다. 원본 직원 입력 테스트 4개와 중복·변조·준비 실패·rollback·지연 확정·실제 생산자 SIGKILL 복구도 검사한다. production의 자동 청구 워커·전체 DB 동등성은 후속 검증이다. 보고서에 두 환경을 구분하며 로그는 `msa/liquibase/verification-logs/customer/`에 남는다.

Jenkins는 customer 선택 시 `Verify Customer Parity`를 실행한다. DB 적용 뒤 operations를 먼저 배포하고 customer를 배포한다. 공통 배포 스크립트가 `dva/msa-customer-auth` Secret의 `customer-token`을 최초 한 번 생성한다. 기존 값은 보존하며 잘못된 값이나 접근 실패가 있으면 교체하지 않고 배포를 중단한다. 실제 비밀 값은 Git·명령 인자·오류 메시지에 넣지 않는다. 두 앱은 각 `<service>-db` Secret의 PG* 필드를 사용한다.

Ingress는 기존 `/customer`와 `/api/customers`, `/api/companies`, `/api/members`, `/api/departments`, `/api/pins`를 customer로 라우팅한다. 내부 경로는 Ingress로 공개하지 않는다. 공개 HTTPS·운영 Jenkins 결과와 전체 MSA 동등성은 별도 검증 대상이다.

## 감사 완료와 복구

쓰기 중 operations의 `POST /internal/events`에 AuditPrepared를 보내 원본 감사 INSERT·제약·트리거로 행을 준비한다. 이때 운영 감사 조회에는 노출하지 않는다. 고객 업무와 AuditCommitted outbox를 함께 커밋한 뒤 operations의 inbox+감사 확정 COMMIT/ACK를 확인해야 성공 응답한다. 업무 실패는 AuditAborted를 남기고, COMMIT 응답 유실은 성공/실패를 임의로 단정하지 않는다. outbox는 250ms 릴레이와 기존 재시도 정책을 사용하며 확인 실패를 성공 처리하지 않는다.

기업 삭제처럼 감사가 많은 트랜잭션은 확정 ID를 1,000개씩 나눠 같은 업무 트랜잭션의 outbox에 저장한다. 같은 aggregate의 전달 순서를 유지하고 마지막 확정 ACK까지 기다린다. 감사 조회도 남은 준비가 있으면 전송을 확인하므로 중간 일부만 성공 조회로 반환하지 않는다.

operations 감사 조회는 미확정 준비가 있으면 서비스 Bearer 전용 `POST /internal/audit/flush`로 결정 확인을 요청한다. customer는 업무 트랜잭션 잠금과 확정 outbox로 진행 중·커밋·중단을 구분한다. 종료된 생산자의 업무가 rollback됐으면 준비를 중단하고 늦은 준비를 차단한다. 다른 DB를 직접 조회하거나 관리자/세션을 복제하지 않는다. 기술 상태의 장기 보관·정리와 전체 분산 장애 검증은 후속 단계다.

## 원본 인증 보안 기록

production은 SECURITY_LOG_HMAC_KEY(64자리 hex)를 필수로 검증한다. 배포기가 공유 `msa-security-logs` Secret의 hmac-key를 최초 생성하고 기존 값은 그대로 사용한다. 잘못된 기존 키는 출력·교체하지 않고 거절한다. 원본처럼 인증 실패/로그인 성공의 안전한 사유와 HMAC 키만 출력하며 계정명·IP·비밀번호·토큰을 기록하지 않는다. 업무 API·감사와 내부 오류 응답은 유지한다. [최신 기준 및 검증](../../../docs/msa-faqs-plan.md)을 따른다.


최신 develop-backend `ad40526`의 고객 등록은 이름·전화번호·주소가 필수다. 도로명·지번·동·우편번호를 검증하며 상세주소는 생략/빈 문자열을 허용한다. 누락/null/불완전 주소는 원본처럼 400이고 PATCH의 주소 생략·null 삭제·전체 교체는 유지한다. [통화 콘텐츠 단계의 기준 갱신 및 검증](../../../docs/msa-call-content-plan.md)에 함께 기록한다. 주문 내부의 이름/전화번호 고객 연결은 별도 계약이며 아직 이식하지 않은 주문 단계에서 연결한다.
