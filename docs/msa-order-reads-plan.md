# 주문 조회 4개 API 이식

- Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)
- 기준: MR !352 병합 `c400c7231d1383577734b42da7b586e4e9b991c3`, backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`, 원본 migration 054까지.
- 브랜치: `feature/msa-order-reads`. 기존 worktree와 변경은 보존한다.
- 수정 범위: `msa/`, `infra/`, `docs/`. backend·프론트·AI는 읽기 전용이다.

## 계약과 작업 범위

| API | 유지할 동작 |
| --- | --- |
| `GET /api/orders` | 관리자 전체/AI 현재 발신번호의 활성 고객 범위, AND 검색·날짜 경계·정렬·페이지·전체 개수 |
| `GET /api/orders/:id` | 실제 저장 버전·상세·주소/PIN/청구 스냅샷·현재 유효 결제 요청, 타 고객과 없는 주문 모두 404 |
| `GET /api/admin/orders` | 관리자 세션, 상태 탭 묶음·NFC/전화번호/일반 문자 검색·상세 순서 |
| `GET /api/customers/:id/addresses` | 고객 존재 확인, ACCEPTED·ACTIVE 상세만, 양 방향 주소/기간/검색/페이지 |

원본 DTO·SQL·응답 envelope·에러 문구·보관/삭제 조건을 사용한다. call header는 기존 형식 그대로 받고, 만료·잘못된 관리자 cookie가 있으면 AI로 우회하지 않는다. AI는 저장된 call.customer_seq가 아닌 **현재 발신번호와 일치하는 활성 고객**을 사용한다. 종료된 통화는 연결된 주문 상세만 허용하며 목록·이전 주소 조회는 409다. 읽기가 주문/상세/고객/통화/배송/감사/이벤트 업무 데이터를 변경해서는 안 된다.

주문 생성·수정·취소·삭제·결제·청구·접수·배송 업무 이벤트·보관 워커는 다음 MR이다. 이번에 쓰기 API의 일부 성공 응답을 임시로 제공하지 않는다.

## 구현 순서와 영향 범위

1. order에 기존 MSA의 PostgreSQL·설정·관리자 세션 조회·HTTP 검증/에러/보안 기록 기반을 적용하고 네 조회 controller·DTO·repository·service를 연결한다. 기존 패키지 버전을 재사용하며 새 종류의 의존성/앱/Redis/브로커를 도입하지 않는다.
2. 내부 `OrderReadRequested` 조회 이벤트를 order → consultation → customer → order로 전달한다. consultation은 유효한 통화의 상태/발신번호를, customer는 활성 고객 또는 관리자 주소 조회 고객 존재를 확인한다. 해당 행의 공유 잠금을 유지하는 동안 order가 로컬 REPEATABLE READ 스냅샷으로 조회한다. order는 원격 대기 중 자기 DB 연결을 점유하지 않는다. 다른 소유자의 테이블과 개인정보 응답 캐시를 복제하지 않는다. 조회 재시도는 현재 상태를 다시 읽으며 outbox/inbox 업무 이력을 생성하지 않는다.
3. 기존 내부 토큰·보안 로그 Secret을 재사용한다. 내부 source/type/payload/요청 크기·응답 ID·구조·timeout을 검증하고 오류/응답 유실은 안전한 오류로 반환한다. 내부 controller는 공개 Ingress·OpenAPI에서 제외한다. 고객 잠금은 원본과 동일한 일관된 접근 판정을 위한 것으로, 동시 쓰기는 짧게 대기할 수 있다.
4. Docker context·health/readiness·k3s 환경/기존 공개 경로·Jenkins parity 단계·서비스 선택/배포 순서와 문서를 함께 연결한다. `/api/customers/:id/addresses`는 customer Prefix보다 구체적인 order 라우트로 보낸다. 기존 customer API 경로를 덮어쓰지 않는다.

## 검증 및 완료 조건

- Linux Docker lint·단위/E2E·TypeScript 빌드, 이벤트/기준 목록 검사.
- 실제 원본 migration과 MSA Liquibase DB를 각각 설치하고 동일 고정 fixture를 저장한다. 원본과 4개 API의 정상·잘못된 입력·cookie/권한·통화 상태·발신번호/고객·기간·정렬/페이지·삭제/보관·결제 요청/청구 스냅샷 응답을 비교한다. requestId 등 의도한 비결정 값만 명시적으로 처리한다.
- 조회 전후 소유 DB 업무 행·버전·시각·감사/이벤트 수가 동일한지 확인한다. 다른 고객·배송 개인정보가 응답에 나타나지 않는지 확인한다.
- 같은 조회 이벤트 재수신, 잘못된 내부 인증/본문/ACK, 응답 유실·의존 장애, 통화 종료·고객 상태 변경과 조회 잠금 경합, 주문/상세 동시 수정의 스냅샷 일관성을 검증한다.
- 변경되는 customer/consultation 내부 경로의 기존 정상 API 회귀와 Linux 배포 회귀를 수행한다. 검사 완화나 원본 테스트 기대값 수정으로 차이를 숨기지 않는다.
- 계획/구현/검증 근거를 커밋하고 최신 원격을 다시 확인한 뒤 Task 160에 연결한 MR → develop-backend를 생성한다. 승인·병합·자동 병합·브랜치 삭제는 하지 않고 사용자 병합 확인을 기다린다.
- 로컬 정적 검사·컴파일·테스트·실제 컨테이너 실행을 구분하며, 운영 Jenkins/k3s/HTTPS와 외부 AI/디버/결제 및 전체 API 동등성은 별도 미검증 범위로 보고한다.

## 최종 검증 기록 (2026-11-06)

구현 커밋은 `cfb4c2c`다. 완료 후 다시 fetch한 `origin/develop-backend`는 `c400c7231d1383577734b42da7b586e4e9b991c3`, backend tree는 `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`로 변하지 않았다. 수정은 msa/docs 안에서만 수행했다.

| 구분 | 실행·관찰 결과 |
| --- | --- |
| Linux 앱 빌드 | Node.js 24 Docker에서 order lint·단위 1개·E2E 3개·TypeScript 빌드·공통 보안 기록 5개·조회 프로토콜 4개 통과. 기존 customer/consultation/operations 이미지의 각 Docker 검사도 통과 |
| 원본 조회 회귀 | backend 파일을 수정하지 않고 원래 `helpers/orders.cjs`·`orders-reads.cjs`를 실행해 9개 통과. 원본 fixture가 요구하는 NODE_ENV=test이며 자동 업무 워커는 제외 |
| 주문 운영 이미지 비교 | `python3 msa/parity/verify-order.py` 최종 `passed=true`. PostgreSQL 17.11 DB 5개에 실제 원본 53개 migration/054까지와 MSA Liquibase를 각각 설치. 양쪽 앱 NODE_ENV=production, 자동 워커 활성화 상태에서 동일 HTTP 요청 **136쌍**과 공개 GET 4개의 OpenAPI operation·재귀 참조 schema가 일치. Node 테스트는 부모 포함 13개 통과 |
| 데이터 불변 | 고객/개인 PIN·관리자/세션/감사·주문/상세/결제 요청/월 청구/주문 청구/빈 AI 결과의 초기 저장 행 대조와 조회 전후 전체 행 불변 확인. 상담은 아래 접근 업무 필드를 대조하고 각 DB의 전체 물리 행을 별도로 전후 비교. 4개 소유 DB의 outbox/inbox 행도 불변 |
| 권한·경합 | 활성/탈퇴/삭제/전화번호 재등록 고객, 없는/삭제/보관/종료/기존 주문 연결 통화, 잘못된/중복 cookie, 타 고객 403/404, 모든 상태·검색·날짜·페이지·과거 금액/PIN·청구 스냅샷·유효 결제 요청 비교. 풀 한도보다 많은 AI 조회 12개 동시 완료. 실제 상세 수정 중 이전 버전과 상세가 함께 보임. 조회가 끝날 때까지 통화 종료/고객 탈퇴 쓰기 대기 확인 |
| 조회 재수신·장애 | 같은 이벤트도 현재 고객 상태를 재검사. 내부 토큰/source/payload 위조, 틀린 ACK·잘못된 필드·리다이렉트·응답 유실 거절. 실제 consultation 컨테이너를 중단한 별도 테스트 1개에서 AI 조회 503·관리자 로컬 목록/상세 200·order 행 불변 확인 |
| 기존 고객 회귀 | `python3 msa/parity/verify-customer.py` `passed=true`. 운영 조회 100쌍, 자동 업무 워커를 제외한 test 쓰기/조회/인증 68쌍과 응답 직후 업무/감사 상태 비교 통과 |
| 기존 상담 회귀 | `python3 msa/parity/verify-consultation.py` `passed=true`. 원본/이식 PBX·녹취/재시도·분석/대시보드/미답변 검사, 운영 PBX/SSE·분석·통화 콘텐츠, 별도 test의 통화 등록/고객·개인 PIN 연동·응답 유실·프로세스 종료 복구 통과. 기존 환경 분리는 유지 |
| 이벤트/기준 목록 | `python3 msa/shared/events/verify.py`: 영속 이벤트 HTTP·중복·순서·rollback·SIGKILL/재시작 15개, 원본 96개 API/migration/worker 기준 목록 1개 통과 |
| 배포 회귀 | 격리 Linux Python 3.13에서 배포 선택/패키징/DB 실패 중단/복구 62개·Bash 구문 통과. 새 선택 순서는 operations → customer → consultation → order → 나머지 |
| 실제 격리 k3s | `integration_app_rollout.py --service order --image dva-order-reads:local`: k3s v1.35.5+k3s1, 임시 order/operations DB·기존 형태 Secret 사용. manifest server dry-run, 첫 설치·정상 교체·의도적인 readiness 실패·이전 이미지 복구 성공. NodePort HTTP **473건, 실패 0건**. 운영 kubeconfig 사용 안 함 |
| 의존성 | 최종 런타임 `npm audit --omit=dev` 알려진 취약점 0개. 전체 설치의 개발 의존성 low 8개는 기존 MSA lockfile 버전과 동일하며 이번에 갱신하지 않음 |

상담의 기존 MSA에는 퇴역 `end_reason` 열이 남아 있고 원본 보관 워커의 `purge_claim_id/purge_claimed_until`은 아직 없다. 이 MR의 교차 DB 대조는 call_session_seq/provider_call_id/caller_phone_number/customer_seq/order_seq/incoming_at/started_at/ended_at/registered_at/deleted_at을 명시적으로 비교한다. 이 차이를 전체 상담 스키마 동등성으로 보고하지 않으며, 양쪽 전체 물리 행의 조회 전후 불변 검사도 유지한다. 보관 워커/레거시 열 정리는 후속 범위다.

검증 중 원본 DTO의 any 입력 표기·MSA isolatedModules 타입 import와 DB 모듈 의존성 연결을 빌드로 확인해 수정했다. 검증 환경에는 원본의 필수 AI_AGENT_URL을 제공했다. 실제 스키마에 없는 고객 created_at 가정을 제거했고, 원본 조직 FK가 이미 제거된 월 청구 행은 CASCADE만으로 초기화되지 않아 명시적으로 fixture를 초기화했다. 보관 행 공유 잠금은 만료/불변 검사 후 해제해 동시성 테스트의 의도적인 테이블 잠금과 충돌하지 않도록 했다. 수정할 수 없는 notPaid 상세를 임의로 편집하지 않고 실제 COLLECTING 상세의 동시 수정으로 스냅샷을 검증했다. 원본의 업무 제약이나 기존 테스트 기대값을 완화하지 않았다.

검증 로그/JSON은 ignored `msa/liquibase/verification-logs/order`, `customer`, `consultation`에 저장한다. `checks` label 수는 독립 테스트 수가 아니다. 이번 SQL/changeset 변경은 없으며 전구간 Liquibase 검증기는 재실행하지 않았다. API 검증에서는 각 DB의 실제 신규 설치를 실행했다. 실제 운영 Jenkins 실행·운영 DB·운영 k3s/HTTPS·Traefik 종단 라우팅과 외부 AI/디버/결제는 확인하지 않았다. 격리 k3s의 HTTP 검사는 NodePort 경로이며 이를 운영 HTTPS 검증으로 확대하지 않는다.

주문 생성/수정/취소/삭제·결제/승인 복구/안내·기업 청구·접수 재시도·주문→배송 이벤트, 남은 상담 이벤트/목록/FAQ 전환·교차 서비스 보관 워커·최종 전체 동등성 검증은 후속이다. MR을 보고한 뒤 사용자 병합 확인을 기다린다.
