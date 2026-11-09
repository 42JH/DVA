# 기업 청구 조회·월 전환 이식

## 기준과 작업 범위

- Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160).
- MR !360 병합 `cf85fe37ff9b4426f25859fa8e2a5f6a71031021`, backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`와 원본 054까지를 기준으로 한다.
- 전용 브랜치 `feature/msa-billing-months`에서 `msa/`, `docs/`만 수정한다. backend·프론트·AI는 읽기 전용이며 외부 API·입력·인증 형식은 유지한다.
- 이번 단위는 `GET /api/companies/:id/billing`과 `OrganizationBillingService.rollover`다. 결제 완료 시 사용액 적립은 주문 접수/결제 이식에서 연결한다. 기존 주문 금액·결제 요청·배송은 이번 워커가 변경하지 않는다.

## 구현 계획

1. 원본 청구 DTO·월 기본값·응답·404를 customer 공개 경로에 연결한다. 현재 기업명은 customer에서 확인하며 order는 자기 원장의 보존된 이름·금액을 우선 반환한다. 삭제된 기업도 과거 원장이 있으면 조회한다. GET은 원장을 생성하지 않는다.
2. order의 10초 워커가 한국 시간 기준 누락 월을 원본 `generate_series` 규칙으로 찾고 10건 단위로 처리한다. customer의 비삭제 기업 공유 잠금 동안 order callback이 원장을 초기화한다. INACTIVE 기업도 포함하고 삭제 기업은 제외한다. 원본 advisory lock·중복 방지·이전 금액 감사·배치 롤백을 유지한다.
3. 기존 CUSTOMER_AUTH_TOKEN·HTTP 이벤트·AuditPrepared/Committed/Aborted와 생산자 잠금 복구를 재사용한다. 내부 이벤트 source/type/payload/응답을 검사하고 비공개 경로는 Ingress/OpenAPI에서 제외한다. 같은 초기화 재수신은 원장 유일성으로 no-op이며 조회/기업 스냅샷을 inbox에 저장하지 않는다.
4. customer/order 모듈·환경·테스트·검증기·Jenkins 검사 범위·문서를 함께 확인한다. 기존 Liquibase 원장을 사용하고 타 소유자 테이블·Redis·브로커·새 런타임 의존성을 추가하지 않는다.

## 검증 계획

- 원본 청구 관련 회귀를 backend 파일 수정 없이 실행한다.
- 실제 원본 migration/MSA Liquibase와 분리 DB에서 같은 조회 입력의 HTTP/OpenAPI를 비교한다. 기본 한국 월·명시 월·삭제/상태/이름 스냅샷·0/큰 정수 금액·인증/DTO 오류를 포함한다.
- 원본 rollover와 MSA의 원장·감사 순서/actor/target/metadata를 비교한다. 새 기업·누락 월·과거/미래 월·이전 사용액·10건 배치 경계·반복/동시 실행·삭제/수정 경합·배치 뒤쪽 실패 롤백을 확인한다.
- 실제 워커 자동 실행·재시작, 감사 준비/커밋 뒤 종료·ACK 유실·중복 전달과 의존 장애를 확인한다. 복구 후 중복 원장/감사가 없어야 한다.
- 영향받는 customer/order/operations의 빌드·lint·타입·단위/E2E와 기존 동등성 회귀를 실행한다. 배포 제어를 바꾸면 해당 회귀와 격리 실행을 추가한다.
- 실행한 명령과 결과만 완료 근거로 기록한다. 운영 Jenkins·DB·HTTPS와 외부 결제/디버/AI는 로컬 검증과 구분한다.

## 한계와 후속

분리 DB의 전역 원자성은 보장하지 않는다. 기업 공유 잠금과 order 로컬 원장/감사 결정 커밋을 연결하며 확정 응답 유실은 기존 감사 복구와 원장 유일성으로 수렴시킨다. 주문 생성·수정·접수/재시도·결제/사용액 적립·배송 생성/후속 이벤트, 남은 상담·교차 소유자 보관·최종 전체 동등성은 후속이다.

## 구현 결과

구현 커밋은 `d19f5f5094d9ab946a0356aaa79e0a550fa08b58`이다. 계획 `26b05e8` 이후 이 작업 트리에서 아래 검증을 수행하고 구현을 커밋했다. 마지막 원격 fetch에서도 기준 SHA와 backend tree가 같았다. 변경은 msa/docs뿐이며 기존 Liquibase changeset·package/lockfile·프론트·AI·backend는 수정하지 않았다.

- customer 공개 경로·DTO·OpenAPI를 원본 그대로 연결해 customer 선언은 24/24개다. 공개 청구 조회는 관리자 세션 전용이고 새 클라이언트 헤더/토큰이 없다. 원장이 없으면 현재 비삭제 기업 이름과 0을 반환하고, 원장이 있으면 보존 이름/금액을 우선한다. 원장 이름이 NULL이면 현재 기업명으로 fallback하며 기업도 없으면 NULL이다. 삭제·물리 폐기 기업의 원장은 계속 조회한다. GET은 업무·감사·outbox/inbox를 쓰지 않는다.
- order는 현재 비삭제 기업 ID를 발견한 뒤 자기 원장의 max 월과 한국 시간 기준 generate_series로 후보를 구한다. 미래 max 월이나 중간의 기존 과거 구멍을 임의 보정하지 않는다. 10건씩 customer가 이름/삭제 여부를 공유 잠금으로 확인하고 order callback이 원본 advisory lock과 PK 하에서 초기화한다. INACTIVE·청구 자격 false 기업도 원본처럼 포함한다. 현재 잔액은 새 월로 이월하지 않는다.
- 새 월마다 직전 원장의 credit/groupBilling 금액을 amountBefore, 0을 amountAfter로 기록한 두 SYSTEM 감사를 같은 requestId·로컬 업무 트랜잭션에 연결한다. 기존 AuditPrepared → 원장/AuditCommitted 커밋 → 감사 확정 ACK와 생산자 잠금 복구를 재사용한다. 기존 관리자/AI 주문 취소 감사의 권한은 유지하며 order의 정확한 SYSTEM 월 초기화만 허용한다.
- 초기화 요청은 원본과 같은 최대 10건이며 actor/금액을 입력받지 않는다. 조회·기업 발견에는 원본에 없는 기업 수/과거 스냅샷 이름 길이 응답 한도를 두지 않는다. 내부 경로는 공개 OpenAPI/Ingress에서 제외한다. 기존 URL·Secret·DB와 5개 런타임 서비스만 사용한다.
- 10초 워커는 실행 중 tick을 합치고 종료 시 진행 작업을 기다린다. test 모드는 자동 실행하지 않는다. 서비스 장애는 다음 tick에서 다시 확인하며 SQL/감사 준비 실패는 배치 전체 롤백, 커밋 뒤 응답 유실은 PK와 감사 복구로 처리한다.

## 최종 검증 결과 (2026-11-06)

아래 label 수는 실행/검사/정리 항목 수이며 테스트 개수와 다르다. 모든 검증기의 소유 라벨을 확인한 Docker 자원 정리까지 종료 코드 0이었다. 최종 코드 이후에는 검증 기록만 추가했다.

| 검증 | 결과와 근거 |
| --- | --- |
| `python msa/parity/verify-order.py` | passed=true, 175 labels, RUN `dva-order-check-4ea73838d992`. 원본 migration/MSA Liquibase와 실제 DB 6개 사용 |
| 원본 청구 회귀 | backend 파일 수정 없이 `order-billing.integration.test.cjs` 11개 통과. 기존 원본 조회 9개·삭제 4개·취소 18개 회귀도 통과 |
| 청구 동일 입력 비교 | 공개 HTTP 33쌍, Node 8개(상위 포함) 통과. 해당 공개 OpenAPI operation과 참조 schema 전부 비교 |
| 기존 주문 회귀 | GET 136쌍(13개), DELETE 69쌍(9개), 취소 168쌍(12개), 삭제/취소 감사 강제 종료·ACK 복구와 기존 의존 장애 검증 통과 |
| 청구 복구 | Node 6개(상위 포함) 통과. 준비 뒤/업무 COMMIT 뒤 실제 SIGKILL, operations 자동 abort/확정, 준비/확정 ACK 유실, 중복 감사 확정·중복 초기화, 최종 callback ACK 유실 후 재발견·재실행 검사 |
| 실제 자동 워커 | production 앱 재시작 후 10초 timer가 ACTIVE/INACTIVE 두 기업의 현재 한국 월을 생성하고 삭제 기업은 제외. 다음 tick에서 원장/감사 중복 없음 |
| 실제 의존 장애 | order 앱 중단 시 공개 청구 GET 503·오류 비공개화·원장 불변. 같은 customer의 로컬 기업 GET은 200 |
| `python msa/parity/verify-customer.py` | passed=true, 71 labels, RUN `dva-customer-check-54edc6c6f1e8` |
| `python msa/parity/verify-consultation.py` | passed=true, 143 labels, RUN `dva-consultation-check-53863d04227c` |
| `python msa/parity/verify-operations.py` | passed=true, 164 labels, RUN `dva-operations-check-2db5bfce051e` |
| `python msa/liquibase/verify.py` | passed=true, 565 labels. 5개 DB 신규/반복/업그레이드·실패 원자성·원본 주문/배송 schema/함수·기존 데이터/감사/이벤트/체크섬 보존 |
| Linux 빌드 | customer/order/operations 포함 전체 서비스 Docker 빌드의 lint·단위/E2E·TypeScript 및 기존 보안/이벤트 검사를 통과. 새 명령 검증·엄격한 ACK와 워커 병합/재시도/종료 검사 포함 |
| 런타임 의존성 | 최종 customer/order/operations 세 이미지의 `npm audit --omit=dev` 알려진 취약점 각각 0. 의존성과 lockfile은 갱신하지 않음 |
| 배포 회귀·목록 | Linux Python 3.13/Bash 배포 회귀 62개, 원본 96개 API/migration/worker 기준 목록 1개 통과 |
| 격리 k3s | 최종 주문 이미지로 최초 배포 → 정상 교체 → 의도적 readiness 실패 → 기존 리소스 복구 통과. `v1.35.5+k3s1`, RUN `dva-delivery-check-b4427c72`, 요청 465건·실패 0건 |

청구 비교는 월 1000-01/9999-12·기본 한국 월·후행 슬래시·삭제/물리 폐기·NULL/보존 이름·0/32비트 초과/최대 안전 정수 금액·잘못된 월/ID/반복 query·모든 관리자 역할/무효 cookie를 포함한다. 월 전환은 한국 연말 전후 1ms 경계·누락 월·미래 월·비활성/삭제 기업·25개 기업 배치·동시 실행·반복을 비교한다. 원장 업무 필드는 전부, 감사는 순서·actor/name/target/result/metadata를 비교하고 서버 UUID는 형식·월별 두 감사 연결·유일성, 시각은 발생 범위를 검증한다. 서버가 생성하는 audit ID/UUID/시각 이외의 업무 차이를 제거하지 않는다. 주문/상세/결제 요청/사용액 charge/빈 AI 결과는 변하지 않는 것도 확인했다.

뒤쪽 groupBilling 감사 SQL 실패를 실제 주입해 앞쪽 원장·감사까지 롤백되는지 검사했다. 실제 order 테이블 잠금 동안 customer 기업 이름/삭제 UPDATE가 대기하고, 커밋 뒤 월 스냅샷은 잠금 전 이름을 유지하는 것도 확인했다. 잘못된 source/token/actor/대상/음수·안전 정수 초과 금액/불필요 metadata는 거절한다. 기존 SYSTEM 주문 취소 감사는 계속 거절한다.

검증 fixture의 없는 세션/outbox 컬럼을 실제 스키마에 맞추고 테스트 계정 ID를 현재 alphanumeric 규칙에 맞췄다. 인증 검사·HTTP/DB 기대값을 완화하지 않았다. 원인 확인용 상세 예외 probe는 무시된 격리 fixture에서만 사용했고 최종 전체 검증은 원래 앱 entrypoint로 실행했다.

로컬 검증 자료는 무시된 `msa/liquibase/verification-logs/`에 남긴다. 최종 review 이미지의 Docker inspect ID:

- `dva-order-billing:local`: `sha256:0aab8c5ffed247c9fda6b7306e8ff3e37a7e9edb15e82bce27897e4d61e81adc`
- `dva-customer-billing:local`: `sha256:d02d1ebfd21f7cabac488ef20803d6085e60f5577eb71023c59baff50c815bc5`
- `dva-operations-billing:local`: `sha256:2651c9f65ce397b4b710de8d69da29babc692c79fac4f0a6cf0e27acad39a877`

실제 운영 Jenkins·DB·k3s/HTTPS·외부 결제/디버/AI는 검증하지 않았다. 격리 k3s는 Deployment/Service/readiness 교체·복구 검증이며 청구 업무는 위 분리 DB 비교/실제 production timer 검증과 구분한다. k3s progress deadline 오류는 의도적으로 주입한 실패다. customer 전체 24개 선언을 제공하는 것이 전체 96개 동등성 완료를 뜻하지 않는다. 상단 후속 업무와 최종 전체 검증을 남긴다.
