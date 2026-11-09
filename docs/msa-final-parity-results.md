# 최초 052 기준 전체 동등성 검증 결과

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)

## 기준과 판정

기준 원본은 최초 계획의 `6a141a0512b73837905f6154c4ff84bcf33f912b`, backend tree `12ad37a492879c47b6c1f78c3c3f3bdfdf98edda`다. HTTP 선언은 업무 92개·health/metrics 3개, SQL은 51개 파일(마지막 052), 워커는 6개다. [고정 목록](../msa/parity/initial-baseline.json)과 archive의 전체 API/SQL 해시/워커 비교가 일치했다.

최초 검사 대상 런타임은 MR !363 병합 `06ce863beaf44320111df3d609dc2b79a1bd5db0`이다. 서비스 소스 tree `371364acbb00deaac3112bf67af3c9908a4daf7f`를 보존했다. 이 MR의 추적 변경은 검증 코드·CI의 검증기 회귀 연결·문서다. 후속 API 이식은 보류한다. 기존 055 목록 검사와 구현은 보존하며, !369 병합 이후 Jenkins 검사는 고정 055 원본 CI 작업공간에서 실행한다.

**전체 동등성 조건은 충족하지 못했다.** 최초 범위의 업무 API 23개가 MSA에 선언되지 않았다. 기존 부분 검증의 성공이나 같은 오류 응답을 전체 동등성 통과로 확대하지 않는다. 아래 존재 수는 소스 선언 기준이며 정상 분기 전체의 동등성 수가 아니다.

| 소유자 | 최초 HTTP 선언 | 같은 경로 선언 | 누락 |
|---|---:|---:|---:|
| operations | 30 | 27 | 3(health/metrics) |
| customer | 23 | 23 | 0 |
| consultation | 21 | 12 | 9 |
| order | 21 | 7 | 14 |
| 합계 | 95 | 69 | 26(업무 23·인프라 3) |

## 실제 API·DB 비교

최종 비교 실행 ID는 `dva-final-check-05ee3f09e638`이다. 원본과 서비스별 다섯 DB의 readiness는 모두 200이다. production 이미지를 `NODE_ENV=test`로 실행해 자동 업무 워커를 격리했다. 18개 테이블의 원본 공통 필드로 초기 업무 행을 맞췄고, 95개 경로의 읽기/입력 오류 요청 후 양쪽 업무 행이 변하지 않음을 확인했다.

실제 HTTP 303쌍(95개 경로 × 익명/인증/금지 Origin 285쌍 + 정상 업무 흐름 18쌍), OpenAPI 69개, 초기/불변 행 3개, 테이블 업무 행 18개, 감사·디버 횟수 2개를 합한 **395개 대조 중 296개 일치·99개 불일치**다. 연쇄 데이터 차이와 이후 계약 차이가 포함되어 있어 불일치 수를 독립 결함 수로 해석하지 않는다. 실행 오류 없이 수집을 마쳤으며 `passed=false`, exit 1이 전체 판정이다.

| 정상 흐름 | 원본 HTTP | MSA HTTP | 응답 대조 |
|---|---:|---:|---|
| existing customer read | 200 | 200 | 일치 |
| caller context read with original MVP credentials | 200 | 401 | 불일치 |
| original customer creation without optional address | 201 | 400 | 불일치 |
| original phone format | 201 | 400 | 불일치 |
| registered customer address update | 204 | 204 | 일치 |
| registered customer read immediately | 200 | 200 | 일치 |
| personal PIN creation | 201 | 201 | 일치 |
| personal PIN immediately visible | 200 | 200 | 일치 |
| FAQ batch creation | 204 | 204 | 일치 |
| FAQ immediately visible | 200 | 200 | 일치 |
| persona list | 200 | 200 | 일치 |
| call registration with original MVP credentials | 200 | 401 | 불일치 |
| AI collecting order creation | 201 | 404 | 불일치 |
| new order immediately visible | 200 | 404 | 불일치 |
| admin credit order creation with Dver response | 201 | 404 | 불일치 |
| post-write order list | 200 | 200 | 불일치 |
| post-write call list | 200 | 404 | 불일치 |
| post-write dashboard | 200 | 404 | 불일치 |

| 응답 직후 저장/호출 결과 | 원본 | MSA |
|---|---:|---:|
| 고객 | 3 | 1 |
| 통화 | 2 | 1 |
| 주문 | 2 | 0 |
| 주문 배송 항목 | 2 | 0 |
| 배송 | 1 | 0 |
| 배송 상태 이력 | 1 | 0 |
| 감사 업무 행 | 102 | 78 |
| 디버 접수 호출 | 1 | 0 |

주문 2건은 AI의 COLLECTING 생성과 관리자 월결제 수기 접수다. 디버는 원본 integration fixture와 같은 Node HTTP 모의 응답을 사용했다. 현재 MSA는 두 생성 경로가 없어 같은 요청에서 주문·배송·접수 호출을 만들지 못한다. PIN과 FAQ는 양쪽 각각 1건이며 필드도 같았다. AI persona 옵션 GET 호출은 원본과 operations에서 각각 1회였다.

원본 MVP 자격 증명으로 고객 확인/통화 등록은 200→401, 주소 생략·기존 전화 형식 고객 등록은 201→400이다. 이후 적용된 AI 업무 Bearer·주소 필수·11자리 전화 계약의 차이로 별도 기록하며 이번 MR에서 런타임을 변경하지 않는다. 최초부터 누락된 업무 경로 23개와 구분한다.

전체 30개 원본 public 테이블 중 18개 행을 비교했고, 감사는 별도 업무 필드로 비교했다. 전체 행 비교에 포함하지 않은 테이블은 `admin_sessions`, `admin_users`, `ai_persona_drafts`, `ai_persona_versions`, `ai_personas`, `audit_logs`, `call_dashboard_metrics`, `call_utterances`, `company_pins`, `empty_ai_order_results`, `faq_change_notifications`, `recordings`이다. 빈 테이블의 일치는 해당 쓰기 기능의 동등성을 증명하지 않는다. 모든 정상 분기, 운영 모드 워커, S3와 서비스 간 보관, 실제 외부 시스템·HTTPS/Ingress는 계속 미검증이다.

실행된 비교 코드 SHA-256: `e4c86734d4b6858f1f8affd5e19da44de276c4a408c4462592eeacba64c45d53`. `differential.json`의 해시가 현재 파일 바이트와 일치한다. 원본/후보의 누락 경로 집합도 소스 선언 검사와 런타임 검사에서 일치한다. 전체 JSON·명령별 로그·이미지 ID는 `msa/liquibase/verification-logs/final/dva-final-check-05ee3f09e638/`에 보존한다.

## 최초 범위에서 남은 업무 경로

주문 쓰기·접수 5개:

- `POST /api/admin/orders/:id/retry`
- `POST /api/admin/orders`
- `POST /api/orders`
- `PATCH /api/orders/:id`
- `POST /api/orders/:id/submit`

결제 9개:

- `POST /api/payments/notifications/:id/completion/retry`
- `POST /api/payments/notifications/:id/retry`
- `GET /api/payments/assets/:name`
- `GET /api/payments/p/:id`
- `GET /api/payments/success/:id`
- `GET /api/payments/fail/:id`
- `GET /api/payments/requests/:id`
- `POST /api/payments/requests/:id/confirm`
- `POST /api/payments/requests/:id/reconcile`

상담·대시보드·FAQ 연결 9개:

- `POST /api/ai/calls/:id/events`
- `GET /api/calls`
- `GET /api/calls/:id`
- `GET /api/dashboard/stage-dropoffs`
- `GET /api/dashboard/registration-time`
- `GET /api/dashboard/complaint-calls`
- `GET /api/dashboard/response-wait`
- `POST /api/unanswered-questions/:id/faqs`
- `GET /api/unanswered-questions`

`GET /health`, `GET /health/ready`의 동일 경로도 없다. 서비스별 `/operations/health`, `/operations/health/ready` 등은 별도로 제공하므로 URL 차이로 구분한다. `GET /internal/metrics`는 같은 수집 경로가 없다. 공개 Ingress에는 `/api/payments`, `/api/dashboard` 라우팅도 아직 없다.

## 자동 처리와 이벤트의 남은 범위

최초 `OrderMaintenanceWorker`는 접수 복구, 한국시간 청구 월 전환, 결제 기한 만료 취소, PAID/SUBMITTING_FAILED 자동 접수를 담당한다. 현재 order `BillingWorker`는 이 중 월 전환을 제공한다. 나머지 책임의 연결과 장애 복구 검증이 필요하다. delivery는 배송 존재 확인을 제공하며 주문 확정에 따른 배송 생성·상태 이력은 후속이다.

최초 `PaymentsWorker`의 결제 안내·완료 안내·미확정 승인 조회 복구는 현재 MSA에 해당 워커가 없다. 최초 `RetentionWorker`의 통화/S3 삭제 점유·주문/배송/결제·고객/기업/관리자/FAQ·감사 7일·FAQ 사례 5년 정리를 서비스 소유권에 맞춰 연결해야 한다. 현재 초안 보관 워커로 전체 업무 보관의 동등성을 인정할 수 없다.

PBX/녹취, 진행 통화 수, FAQ 알림과 공통 outbox/inbox에는 기존 구현이 있다. 공통 전달의 롤백·멱등·ACK 유실·재시작 통합 테스트 통과와 개별 업무 이벤트 생산/수신의 완료는 각각 기록한다. 미답변→FAQ, FAQ 질문 사례, 주문→배송·결제/청구와 교차 소유자 보관은 추가 실행 근거가 필요하다.

## 실행 방법과 비교 규칙

```sh
# 고정 커밋을 포함한 Git 이력 + Node 24/Python 3.12 이상 + Docker; 운영 Secret/kubeconfig 불필요
# 전체 API/DB 실행 수집과 동등성 판정
python msa/parity/verify-final.py
# 소스 선언의 누락 별도 확인
node -e "const p=require('./msa/parity/final-parity.cjs'); console.log(p.coverage(require('./msa/parity/initial-baseline.json').inventory.routes,p.msaRoutes(process.cwd())).filter(x=>!x.declared))"
# 검증기 회귀
node --test msa/parity/final-contract.test.cjs
# Jenkins와 같은 고정 055 inventory/이벤트 검사: Linux의 깨끗한 체크아웃에서 실행
python msa/parity/ci_workspace.py
python msa/.ci-source/msa/shared/events/verify.py
```

`verify-final.py`는 최초 원본을 git archive로 추출해 checks/production 이미지와 다섯 MSA checks/production 이미지를 빌드한다. 원본 DB와 서비스별 다섯 DB에 같은 초기 업무 행·세션을 넣고 95개 경로에 익명·인증·금지 Origin 요청을 보낸다. source/OpenAPI 선언이 없는 경로는 같은 404를 받아도 실패다. 정상 업무 요청과 응답 직후 데이터·감사 비교를 수행한 뒤, 별도 DB에서 원본 전체 integration 명령을 실행한다. AI/디버는 기존 Node HTTP 테스트 패턴의 임시 peer를 앱 내부 네트워크에서 제공한다.

응답 requestId를 검사하고 유효한 meta timestamp만 정규화한다. 새 생성/수정 시각은 업무 흐름의 시작~완료 시각(1초 여유) 안인지와 생성≤수정 관계를 확인한다. 진행 통화 수의 observedAt은 최근 15초 범위를 확인하고 수치를 보존한다. 기존 시각, incomingAt·삭제/보관 시각·금액·상태·버전·업무 연결은 그대로 대조한다. DB 감사는 생성 로그 번호/발생 시각을 제외한 주체·행위·대상·requestId·결과·metadata를 대조한다.

검증기는 로컬 실행 완료와 전체 동등성 통과를 구분한다. 미구현/불일치/미검증이 남으면 exit 1과 `passed=false`를 유지한다. 모든 정상 분기·미포함 테이블·교차 소유자 워커·외부 호출 횟수·운영 배포는 별도 근거가 필요하다. 현재 검사 범위를 넓힌 뒤 해당 미검증 표기를 갱신한다.

## 실행 명령별 검증 결과

| 검증 | 실제 결과 |
|---|---|
| 최초 archive 전체 목록 | API 95개·SQL 51개 해시·워커 6개 일치 |
| 원본 compiled + 결제 모의 테스트 | 140 + 21개 통과, exit 0 |
| 원본 최종 전체 integration | 735개 통과·실패 0·skip 0, exit 0 |
| 다섯 MSA checks/production 이미지 | 모두 빌드 성공; 기존 lint/단위/E2E/TypeScript 검사 포함 |
| 원본/다섯 MSA schema 설치 | 모두 성공, 실제 분리 PostgreSQL 17.11 |
| 전체 동등성 수집 명령 | 오류 없이 395개 대조, 동등성 실패에 따른 exit 1 |
| 기존 이벤트 CI 명령 | exit 0; 실제 PG/HTTP 통합 15개·검증기 회귀 5개·최신 목록 1개 통과 |
| 정적 검사 | CJS 구문·Python AST·git diff --check 통과 |

네 번의 원본 integration 실행 결과는 순서대로 735/735 통과, 698/699 통과(보관 경합 1개 실패), 735/735 통과, 735/735 통과다. 두 번째 실행은 `&&` 뒤의 후속 통합 파일이 실행되지 않았다. 원본 실패 기록도 보존하며 마지막 성공만으로 불안정성이 해소됐다고 판단하지 않는다.

마지막 실행 소유 컨테이너·내부 네트워크·이미지 태그 정리는 모두 성공했다. 운영 Jenkins·DB·클러스터·실제 AI/디버/결제는 변경하거나 호출하지 않았다. 이 MR에서 backend/frontend/AI·서비스 런타임·Liquibase changeset·의존성 버전은 변경하지 않았다.

## 검증 중 발견한 fixture 오류

첫 실행 `dva-final-check-795531eedc86`에서 원본 자체의 735개 integration 테스트는 실패·skip 없이 통과했지만 비교 fixture가 없는 `customers.created_at`을 INSERT해 초기화가 중단됐다. 원본 052와 MSA의 실제 스키마/기존 fixture를 확인해 이 컬럼을 제거했다. 첫 실행은 API 동등성 실행 결과에 사용하지 않는다. 원본 backend 테스트나 기대값을 변경하지 않았다.

두 번째 실행 `dva-final-check-1be27ddbe72c`는 AI 모의 health가 없는 설정에서 원본 readiness 503으로 중단됐다. 세 번째 `dva-final-check-7ceec0e0473e`는 전체 경로 호출·초기 행 불변 확인을 마쳤지만 UUID가 아닌 추적 ID가 원본 middleware에서 교체되어 정상 흐름 비교가 중단됐다. 최종 검증기는 `crypto.randomUUID()`와 감사 `uuid[]`를 사용하고 응답 헤더/본문의 ID 일치 검사를 유지한다. PIN 201·AI 주문 201·수기 주문 201 원본 기대값도 유지했다.

원본 자체의 보관 경합 테스트가 두 번째 실행에서 1회 실패했다. `data-retention.integration.test.cjs:171`에서 동시 정리 후 통화 행이 남아 `true !== false`가 발생했다. 첫 번째·세 번째 실행에서는 원본 전체 735개가 통과했다. 고정 원본이나 테스트 기대값은 수정하지 않았으며, 불안정성의 세부 원인은 추가 재현 근거가 필요하다.

## 2026-11-09 최신 develop-backend 반영

사용자 요청에 따라 `test/msa-final-parity`에 최신 대상 `581344039532cf3475dbda3e56c39624e744a0f6`을 일반 병합했다.
병합 커밋은 `b7ec2015fc3b7c4732ebec4ce38a5cbaf2a9a3d9`이며 Git 충돌 0건으로 자동 병합됐다.
!369의 CI 이미지 공유·고정 055 원본·배포 준비 흐름을 보존했다. 이번 MR이 대상 브랜치에 추가하는 변경은 계속 msa/docs 11개 파일이다.

최초 052 baseline은 최초 계획 `7266964`의 Git blob과 바이트·JSON이 모두 같았다. archive를 다시 추출해
API 95개·SQL 51개 해시·워커 6개 전체 목록이 일치함을 확인했다.
서비스 src·공통 이벤트 CJS·Liquibase changelog는 최초 실행 대상 `06ce863b`와 차이가 없다.
현재 소스 선언의 누락도 업무 23개·인프라 3개 그대로다. 위의 395개 실제 대조 결과는 원래 실행 기록으로 보존한다.

| 갱신 검증 | 결과 |
| --- | --- |
| Git 충돌·범위·diff 검사 | 충돌 0, msa/docs 11개 파일, 대상의 backend/frontend/AI와 차이 없음 |
| 검증기 회귀 | Node 24.22.1에서 5개 통과 |
| 배포·이미지 공유·범위 선택 회귀 | Linux Docker에서 111개 통과, 24.154초 |
| CJS/Python 구문 | MR의 CJS 4개·Python 2개 통과 |
| 실제 CI 원본 준비 | 1.222초, 원래 backend tree 보존·snapshot의 MSA tree 일치 |
| CI 소스/고정 원본 연결 | 0.165초, 원본 source commit과 고정 backend 확인 |
| 실제 PG/HTTP 이벤트 경로 | 42.209초, exit 0. 이미지 단위 10개·초안 단위 3개·PG/HTTP 통합 15개·inventory/검증기 회귀 6개 통과 |
| 변경 범위 선택 | 0.406초, diff 기준 앱/DB 대상 0개·DB CI false, 기존 서비스 회귀 4개 선택 |
| 검증 자원 정리 | 해당 실행의 컨테이너·이미지 태그·네트워크 잔여 0개 |

CI 연결은 기존 Jenkins agent/dind의 독립 작업공간에서 배포 없이 확인했다.
고정 CI 원본은 `9624b7789ee7876648b6c56b5e7a4a7a5a9ef378`/backend tree `12c6fa0f17354f53b28244d8b804bd564f1141be`이며,
검증한 MSA tree는 `0e369ee8f962c22b41a428f34b91bb46390c7221`이다.
문서의 이전 직접 inventory 실행 안내도 고정 CI 작업공간 경로에 맞췄다.
로그·정리 확인·소스 기록은 Git 제외 경로 `msa/liquibase/verification-logs/mr364-sync-ab78ae7f/`에 보존했다.

이번 갱신에서 전체 95개 API/DB 수집·원본 735개 integration·기존 서비스 회귀 4개 전체·운영 Jenkins Job/CD는 재실행하지 않았다.
전체 동등성 미달 판정과 기존 실패·미검증 기록을 유지한다. `verify-final.py` 전체 비교는 Jenkins 자동 단계에 추가하지 않았고,
이벤트 단계에는 검증기 회귀만 연결한다. 실제 CD 선택은 기존처럼 서버의 배포 성공 이력을 따르며 위의 diff 범위 검사와 구분한다.

## 다음 작업

최초 범위의 주문 쓰기 → 접수·배송 → 결제·자동 워커 → 상담 이벤트/조회·대시보드·FAQ 사례 → 교차 소유자 보관을 구현·검증한 뒤 전체 동등성 검증을 반복한다. 후속 계약의 고객 주소 필수·전화번호 11자리·AI 업무 Bearer·055 초안 변경으로 발생하는 차이는 최초부터 빠진 경로와 분리해 기록하고 이번 검증 MR에서 되돌리지 않는다.
