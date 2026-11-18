# 주문 삭제 API 이식 계획

- Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)
- 기준: MR !355 병합 `256d8157c68cc8a252253484ab3ab8086cd4d95e`, backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799` (원본 054까지).
- 브랜치: `feature/msa-order-deletion` → `develop-backend`.
- 수정 범위: `msa/`, `docs/` (필요한 경우에만 `infra/`). backend·프론트·AI는 읽기만 한다.

## 이번 MR의 완료 조건

기존 `DELETE /api/orders/:id` 하나를 원본과 같은 입력·HTTP·업무 데이터·감사 결과로 제공한다. 생성·수정·취소·접수·결제·청구·배송 이벤트·보관 워커는 후속 MR이다. API를 일부 상태에서만 성공하도록 축소하지 않는다.

1. 관리자 세션과 기존 허용 Origin, OPERATOR/SUPERVISOR/SYSTEM_ADMIN 역할, ID 검증, 204/400/401/403/404/409·실패 감사와 OpenAPI를 유지한다. AI 읽기 예외를 DELETE에 적용하지 않는다.
2. 주문 행을 잠그고 삭제·5년 만료 행을 숨긴다. COLLECTING/CANCELLED/ACCEPTED만 허용하고 결제 승인 중·안내 SENDING·진행 통화가 있으면 거절한다. 결제 요청의 PENDING 안내와 WAITING/PENDING 완료 안내를 FAILED로 바꾸고 주문의 deleted_at만 기록한다. 하위 행·스냅샷·최초 보관 기산일과 원본 trigger의 버전 규칙을 보존한다.
3. 진행 통화 여부는 consultation 소유 DB에 인증된 고정 조회 이벤트로 확인한다. 원본 SQL처럼 deleted_at/ended_at만 검사하고 과거 통화의 보관 시각으로 차단 조건을 완화하지 않는다. 이 조회는 캐시·inbox/outbox·업무 쓰기를 만들지 않는다. order의 잠금/결제 확인 뒤 호출하며 의존 장애를 성공으로 처리하지 않는다.
4. 기존 customer/consultation의 AuditPrepared → 로컬 업무+AuditCommitted outbox → operations 확정/ACK 패턴을 재사용한다. order 전용 감사 준비 테이블을 후속 operations changeset으로 추가하고 기존 이력·준비 행을 보존한다. 실패 rollback·중복 전달·COMMIT 응답 불확실·생산자 종료 후 복구도 확인한다. 새 토큰/브로커/런타임 의존성은 추가하지 않는다.
5. operations의 order 복구 주소는 선택 설정으로 추가하고 배포·fixture에 연결한다. 기존 조회·인증·감사 호출자와 배포 검증을 함께 확인한다. 비공개 경로는 Ingress와 OpenAPI에서 제외한다.

## 검증 순서

1. Linux Docker lint·TypeScript 빌드·기존 단위/E2E·작은 프로토콜/트랜잭션 검사.
2. 원본 migration과 MSA Liquibase를 별도 임시 PostgreSQL DB에 적용한다. 원본을 수정하지 않은 삭제 관련 회귀와 동일 fixture의 DELETE/후속 GET 요청·OpenAPI·업무/감사 행을 대조한다. 현재 시각/독립 identity는 의미와 범위를 검증하고 그 외 필드는 그대로 비교한다.
3. 전체 상태·결제 안내/승인·통화 삭제/종료/보관 경계, 반복/동시 삭제, 잠금 timeout, 감사 준비 실패 rollback·ACK 유실·강제 종료 복구, 위조 이벤트·비공개 경로를 확인한다. 기존 주문 읽기·customer/consultation/operations 감사 회귀를 실행한다.
4. operations changeset 초기 설치·채워진 009 업그레이드·후반 실패 rollback·재적용/기존 checksum 보존과 배포 회귀를 검증한다. 운영 Jenkins·k3s·HTTPS·외부 서비스 확인은 로컬 증거와 구분한다.
5. 검증 결과를 기록하고 작업 단위로 커밋·push·MR 생성, 같은 Jira Task에 연결한 뒤 사용자 병합을 기다린다.

## 범위와 한계

분리 DB의 전역 원자 트랜잭션을 주장하지 않는다. 성공 응답은 업무 커밋과 감사 확정 ACK 뒤에만 반환하고, 확정 응답 유실은 기존 영속 릴레이/생산자 잠금 증명으로 복구한다. 향후 통화-주문 연결 쓰기도 order 잠금·삭제 상태 검사와 연결해야 한다. 원본의 진행 통화 조회 자체는 행 잠금을 요구하지 않는다.

## 실행 결과

실행일은 2026-11-06이다. 구현 커밋은 `706b9d68c1f15848f8b4c28dddc1539942cd1b5a`이며 원격 기준을 다시 확인한 결과 develop-backend는 `256d8157c68cc8a252253484ab3ab8086cd4d95e`, backend tree는 처음과 같다. Windows Python 3.14에서 검증기를 실행하고 실제 앱/DB/빌드 검사는 Linux Docker의 Node.js 24·PostgreSQL 17.11·Liquibase 5.0.4를 사용했다.

| 실행 | 확인한 결과 |
| --- | --- |
| `docker build --target checks -f msa/services/order/Dockerfile msa` | lint·단위 1개·E2E 4개·TypeScript 빌드·보안 기록 5개·조회/삭제 프로토콜·감사 트랜잭션 8개 통과 |
| `python3 msa/parity/verify-order.py` | 최종 RUN `dva-order-check-dd7aa5862c14`, passed=true, 99개 실행/정리 label. 원본 조회 회귀 9개·삭제 관련 회귀 4개와 아래 분리 DB 비교/복구 통과 |
| `python3 msa/liquibase/verify.py` | passed=true, 565개 실행/검사 label. 5개 DB 신규/기존 변경·원본 전체 migration·주문/배송 catalog·함수·DDL/이력/데이터 rollback과 010 업그레이드 통과 |
| `python3 msa/parity/verify-customer.py` | RUN `447eeed28cb8`, passed=true, 71 label. 기존 production 조회 100쌍·test 쓰기/조회/인증 68쌍 및 즉시 업무/감사 비교 통과 |
| `python3 msa/parity/verify-consultation.py` | RUN `86ea4d5ca840`, passed=true, 143 label. PBX/녹취/SSE·분석/통화 콘텐츠·고객 확인/개인 PIN·기존 감사/강제 종료 복구 통과 |
| `python3 msa/parity/verify-operations.py` | RUN `00d1ae162f79`, passed=true, 164 label. 원본/MSA 인증·관리자·감사·인증 제한·페르소나·FAQ 회귀, 실제 워커 SIGKILL/재시작 복구와 deployment probe 통과 |
| Linux Python 3.13 `python3 -m unittest discover -s msa/deploy/tests -v` | Docker RUN `dva-order-deploy-d023186e06`, 배포·선택·이미지/Secret 보존·롤백·Bash 구문 62개 통과 |
| `node --test msa/parity/inventory.test.cjs` | 원본 96개 공개 API 선언·migration/worker 기준 목록 1개 통과 |
| 최종 런타임 이미지의 `npm audit --omit=dev` | 알려진 운영 의존성 취약점 0개. 기존 개발 의존성 low 8개는 갱신하지 않음 |

label 수는 테스트 수가 아니다. 검사·컨테이너 생성/실행·정리 단계를 포함한다. 결과 JSON과 원본 로그는 ignore 경로 `msa/liquibase/verification-logs/` 및 `msa/liquibase/verification.json`에 보존했다. 최종 주문 런타임 검토 이미지는 `dva-order-deletion:local`, config ID `sha256:10c71c068e6eaed447f3520fb5e548c0df07ccb95f2851fb8aef7b3b2d13c393`다. Liquibase 검증 이미지 ID는 `sha256:c3eb9068eda13c27ca7645565d33e57208ee70de9f7962722916a52d629c4137`이다.

### 주문의 동일 요청과 즉시 저장 결과

- 원본/MSA production 앱과 분리 소유 DB 5개를 사용했다. 기존 조회 136쌍(13 Node test), DELETE 69쌍(9 Node test), 삭제 후 목록·상세·이전 주소 숨김과 반복 DELETE, 원본 DELETE OpenAPI operation 및 참조 schema가 일치한다.
- 모든 주문 상태, 삭제·5년 보관 기산일, 진행/종료/삭제/과거 진행 통화, 결제 안내 5×6 상태 조합, 승인 진행/완료/무효를 비교했다. 각 DELETE 직후 주문 소유 6개 테이블의 전체 행·버전·스냅샷·시각·결제 필드를 대조하고 성공/실패/거절 감사의 작업자·이름·대상·결과·metadata를 대조했다. 접수 완료 주문의 저장 주소가 실제 조회되다가 삭제 후 숨겨지는 경로와 기존 월별 청구/청구 행 보존도 확인했다.
- 실행마다 생성되는 deleted_at/updated_at·감사 occurred_at은 요청 전후 시간 범위를 검사했다. 독립 감사 identity는 양수/유일성과 대상 연계를 확인한다. 다른 업무 필드 차이는 필터하지 않는다. 순서가 정해지지 않는 동시 DELETE 두 건은 양쪽 모두 204/404 한 건씩과 SUCCESS/FAILED 감사 한 건씩을 확인했다. 2초 잠금 대기는 원본 REQUEST_IN_PROGRESS와 전체 업무 rollback을 확인했다.
- order 성공 감사 INSERT를 원본과 operations에서 실제 SQL trigger로 실패시켜 주문/결제 안내 rollback과 FAILED 감사, 이후 정상 재시도를 확인했다. 통화 전체 물리 행의 요청 전후 불변과 customer 불변도 검사했다. 기존 조회 검증의 상담 물리 schema 차이에 대한 범위는 [조회 검증 문서](msa-order-reads-plan.md)를 유지하며 이를 전체 상담 schema 동등성으로 확대하지 않는다.

### 감사 전달과 실제 프로세스 종료

- 삭제 복구 5 Node test: 감사 준비 뒤(업무 COMMIT 전) SIGKILL은 주문 rollback·성공 감사 미노출·operations 자동 abort·정상 재시도, 업무 COMMIT 뒤 SIGKILL은 영속 릴레이 복구·성공 감사 한 건·중복 ACK·커밋된 결과에 abort 미발행을 확인했다.
- 실제 HTTP 프록시에서 AuditPrepared/AuditCommitted의 ACK를 버렸다. 준비 ACK 유실은 rollback/abort, 커밋 ACK 유실은 미전달 outbox를 남긴 뒤 같은 이벤트 ID 재전달로 단일 감사를 확정했다. 단위 검사도 COMMIT 응답 불명 시 abort를 보내지 않고 업무 연결 해제 후에만 확정 ACK를 기다림을 확인했다.
- 위조 token/source/action/target·AI 성공·추가 metadata를 거절한다. consultation의 같은 조회 이벤트 재수신은 바뀐 현재 통화 상태를 읽고 inbox를 만들지 않는다. 응답 source/shape/ID·UTF-8·리다이렉트·오류/유실을 검사한다. 상담 컨테이너를 실제 중단한 별도 Node test에서 AI 조회/삭제 503·관리자 로컬 조회 200·order 행 불변을 확인했다.
- operations의 백그라운드 복구는 consultation과 order를 독립 실행한다. 한 소유자 장애가 다른 소유자의 복구를 막지 않고 종료 시 두 작업 모두 기다리는 작은 검사도 Docker 빌드에 포함했다.

### 검증 중 확인해 바로잡은 사항

- 원본 write helper의 catch를 `unknown`으로 선언해 MSA strict lint를 충족했다. 검사 설정을 완화하지 않았다.
- 이전 조회의 의도적인 MSA 단독 동시 수정 fixture가 후속 DELETE 비교에 남지 않도록 양쪽을 같은 독립 데이터로 다시 준비했다. ACCEPTED의 필수 수거 시각·주소 조회의 필수 direction도 원본 계약에 맞췄다. 만료 행은 전체 비교가 끝날 때까지 공유 잠금으로 보존해 실제 원본 보관 워커와 비교를 경합시키지 않는다. 원본 제약/trigger나 기대 업무 값을 제거하지 않았다.
- 기존 이벤트 수신기는 다른 source의 유효 서비스 token을 401/EVENT_UNAUTHORIZED로 거절한다. 기존 구현과 통화 콘텐츠 회귀에서 이 계약을 확인하고 새로운 검사도 정확히 같은 상태/코드를 요구한다. 임의 token은 바깥 guard의 403이다.
- operations 인증 fixture의 기존 changeset 수 9를 새 010 포함 10으로 동기화하고 010 이력 및 새 테이블 존재를 추가 확인했다. 기존 SQL/changeset checksum은 유지했다. 초기 실패 로그도 ignore 경로에 남겼다.

### 적용과 미검증 범위

operations 010을 앱보다 먼저 적용한다. 전체 선택 시 기존 operations → customer → consultation → order 순서를 사용하며 operations의 ORDER_URL과 기존 CUSTOMER_AUTH_TOKEN을 연결한다. 새 Secret 종류·클라이언트 header/API·런타임 의존성은 추가하지 않는다. 추적 변경은 msa/docs뿐이다.

실제 운영 Jenkins 실행·DB 적용·k3s/HTTPS와 외부 AI/디버/결제는 검증하지 않았다. 이번 MR에서 실제 k3s rollout을 다시 실행하지 않았고 기존 배포/복구 코드의 Linux 회귀만 실행했다. 원본 삭제 관련 회귀는 자동 업무 워커를 제외한 test 환경, HTTP/DB 차등 비교는 production 앱이다. 만료 fixture 잠금은 물리 보관 워커의 동등성을 입증하지 않는다.

분리 DB에는 순간적으로 업무 커밋과 원격 감사 확정 사이가 존재한다. 응답 유실은 원자 실패로 단정하지 않고 기존 영속 증명/릴레이로 복구하며 GET·감사로 확정 결과를 확인한다. 사용자 병합 전 다음 MR 작업을 시작하지 않는다. 주문 생성/수정/취소·결제/청구·접수/배송·남은 상담·교차 서비스 보관과 최종 전체 동등성 검증은 남아 있다.
