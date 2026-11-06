# 미답변 수집·삭제와 통화 콘텐츠 조회·삭제 이식

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)

## 기준과 범위

MR !337 병합을 확인하고 `origin/develop-backend`의 `1597c6238cc1c33fa1e76d685eb5460c014aed86`에서 `feature/msa-call-content`를 분리했다. backend tree `46377df301afd942d27f2cbd9d24694c46a3aae6`, migration 054까지를 읽기 전용 계약으로 삼는다. 기존 worktree는 보존한다. 추적 수정은 msa/infra/docs 내부만 허용하며 원본·프론트·AI·의존성과 이미 적용된 SQL은 수정하지 않는다.

이번 공개 선언은 6개다.

| method | 기존 경로 | 동등성 범위 |
|---|---|---|
| POST | /api/ai/unanswered-questions | AI 전용 토큰, 최초 201/동일 재전송 200, 발생 UUID/정규화 해시, 사유·원문·상태·감사 원자성 |
| DELETE | /api/unanswered-questions/:id | 관리자/Origin, OPEN soft delete, 재삭제 204, REGISTERED 409, 본문 검증·원문/해시 보존 |
| GET | /api/calls/:id/transcript | 현재 통화 확인, 발화 순서/위치·페이지/전체 건수 |
| GET | /api/calls/:id/actions | AI 동작·정수 초·순서/페이지/전체 건수 |
| GET | /api/calls/:id/processing-results | FAQ 질문/답변 발화와 미답변 상태/사유·삭제 시 숨김 |
| DELETE | /api/calls/:id | 통화 종료·녹취 완료/claim 확인, 2초 잠금, soft delete·감사·SSE 숨김 |

주문 소유권·FAQ 생성과 원자성을 함께 보장해야 하는 통화 이벤트 수집, 미답변 목록/FAQ 전환과 통화 목록/상세·녹취 재생은 다음 단계다. 이번 조회는 기존의 정상 업무 행을 주입해 검증하며 이벤트 수집을 구현했다고 보고하지 않는다. 물리 보관 폐기 워커와 전체 동등성은 남아 있다.

## 계획 → 구현 → 검증

1. 기존 consultation 인증·감사 이벤트/DB 트랜잭션을 사용한다. 원본의 DTO·Controller·Service·Repository에서 해당 기능을 이식하며 고객/주문/FAQ 데이터를 복제하거나 교차 DB SQL을 만들지 않는다. DB 구조는 기존 consultation 006/007로 충분한지 확인한다.
2. operations 감사 수신의 consultation 허용 목록에 실제 세 동작과 각 대상/성공 주체만 추가한다. 질문 수집 성공은 AI, 질문/통화 삭제 성공은 ADMIN으로 제한하고 기존 customer 경계를 보존한다. 모듈/이미지/공개 Ingress/배포 probe·OpenAPI·기존 E2E와 관련 테스트를 함께 갱신한다. AI_INSIGHTS_TOKEN과 서비스 인증/감사 준비·확정/중단의 기존 설정을 그대로 사용한다. Redis·브로커·별도 외부 API·새 의존성은 추가하지 않는다.
3. 원본 미답변 DTO 테스트와 이 범위에 해당하는 원본 통합 테스트를 가능한 그대로 실행한다. production 양 앱에 같은 요청을 보내 상태·본문·헤더·권한·부작용/감사를 비교한다. 신규/동일/변조 재전송·두 인스턴스 경합·삭제 뒤 재전송·현재/삭제/5년 만료·빈 페이지·FAQ 복수 참조·미답변 상태/사유·잘못된 본문/토큰/쿠키/Origin·감사 장애 rollback과 실제 강제 종료 후 복구를 포함한다.
4. consultation 전체 비교 검증, operations/customer 기존 회귀와 이벤트/배포 검사 중 영향을 받는 범위를 검증한다. 실행 중 실패는 원인을 재현해 수정하고 검사를 완화하지 않는다. 단계별 커밋 후 develop-backend 대상 MR을 생성해 링크·검증/한계를 보고하고 사용자 병합을 기다린다.

## 영향과 위험

HTTP/AI 입력은 기존 전역 guard와 전용 CallInsightsGuard 경계를 통과해야 한다. 서비스간 감사 이벤트는 기존 outbox/inbox를 사용하며 성공 응답 전 감사 확정을 기다린다. 삭제는 원본 045 이후 정책대로 원문·발생 해시·업무 연결을 보존하고 일반 조회에서 숨긴다. 다른 호출자가 사용하는 통화 등록/PBX/분석/SSE 경로와 기존 프로세스 종료 복구를 회귀 검증한다. 원본 테스트 중 아직 이식하지 않은 수집/주문/목록/전환 경로는 제외 이유와 함께 별도 기록한다.

실제 운영 Jenkins/k3s·공개 HTTPS·실제 AI/PBX/S3는 로컬 임시 PostgreSQL/HTTP 검증과 구분한다.


## 검증 중 확인한 원인

- 원본 DTO의 제어문자 정규식과 any 반환이 MSA의 엄격한 lint와 충돌했다. 동등한 NUL 이스케이프 정규식으로 matches 제약과 오류 reason까지 유지하고 Transform 반환을 unknown으로 명시했다. lint 규칙과 검증 기대값은 완화하지 않았다.
- 신규 DELETE에 대한 E2E AuditService mock에 recordFailure가 없어 원래의 401 대신 500이 발생했다. 실제 감사 구현은 유지하고 mock을 보완했다. OpenAPI 예상 경로 정렬도 실제 사전 순서로 바로잡았다.
- 원본 production 보관 워커는 10초마다 만료 통화를 물리 삭제한다. 이전 분석 비교에서 2020년 fixture가 요청 중 삭제되는 경합을 실제로 관찰했다. 동일 만료 시각으로 바꾸기 전에 fixture 행에 FOR KEY SHARE를 유지해 물리 폐기만 SKIP LOCKED로 격리한다. 만료 API의 404·전체 행 비교와 모든 기존 기대값은 그대로 검사한다. 물리 폐기 워커 검증은 후속이며 이번 결과로 대체하지 않는다.
- 진행 통화 fixture는 원본의 시작/종료 쌍 CHECK에 맞게 두 값을 모두 null로 주입했다.
- 첫 production 수집 비교는 operations 감사 수신이 새 질문 동작을 거절해 500을 반환했다. source/action/target/성공 주체의 기존 경계를 유지하면서 실제 세 동작만 허용하며 새 쓰기/삭제와 기존 customer·분석을 함께 회귀 검증한다.

- production 오류 본문 대조에서 NUL 거절 reason이 matches에서 notContains로 달라짐을 발견해 같은 matches 제약으로 유지했다. 관리자 ID fixture는 원본의 영숫자 규칙으로 고쳤고 연도 0000은 원본 실행의 isIso8601/HTTP 400 계약으로 확인했다.
- 일반 관리자 DELETE에 Origin 검사 누락이 있어 MSA에서 204가 반환되는 반례를 재현했다. 내부 서비스/PBX·쿠키 없는 AI 예외를 보존하면서 안전한 메서드 외의 관리자 요청은 원본처럼 세션 인증 전에 Origin을 확인한다. 새 E2E와 production의 Origin 미지정/불허 검사를 유지한다.


## 최신 기준 갱신

작업 중 develop-backend에 고객 등록 주소 필수화(25d187e)와 주문 물품가액 범위 변경이 병합되어 `ad405269b4ec5c74063d8fdab0de1efbef9f11a7`을 merge했다. 현재 backend tree는 `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`이며 migration은 여전히 054다. 원본 변경은 그대로 보존하고 MSA customer의 등록 DTO·OpenAPI 설명·정상 fixture 및 주소 누락/null/불완전 객체 거절 비교를 갱신한다. PATCH 주소 생략/삭제/전체 교체는 원본처럼 유지한다. 신규 고객 등록은 이름·전화번호·주소 필수, 상세주소만 선택이다. 주문 물품가액 1원~1억원·최초 결제 승인 전 검증은 주문 단계의 최신 계약이며 미구현 주문 API를 이번에 완료로 보고하지 않는다. 최종 세 서비스 비교는 이 기준으로 재실행한다.


## 최종 검증 기록 (2026-11-06)

최종 비교 기준은 ad40526의 backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`이다. 임시 Docker PostgreSQL 17.11·Liquibase 5.0.4와 Linux Node.js 24를 사용했다. 실행 label은 이미지 준비·복사·SQL·정리를 포함하며 테스트 개수가 아니다.

| 검증 | 결과 |
|---|---|
| `python msa/parity/verify-consultation.py` | `4e62067fdb1c`, passed=true, 143개 label. 원본 미답변 DTO 8개를 수정 없이 양쪽에 각각 실행했다. 원본 통합 15개는 모놀리식에서 실행하며 미구현 이벤트 수집/FAQ 전환을 MSA에서 통과했다고 보고하지 않는다. 전체 source suite 123개·MSA suite 34개와 원본 녹취 정책 4개씩 통과. |
| 새 production HTTP/DB 비교 | 6개 API에 220쌍. 정상/변조/재전송·원문/사유·상태/해시/시각 보존·51건 누적·세 관리자 역할·쿠키/AI 전용 토큰/Origin·DTO 오류 reason·100KiB·권한/페이지/전체 건수·발화/복수 FAQ·삭제 후 숨김을 비교했다. source와 분리 DB의 업무 값 및 모든 해당 요청의 감사가 응답 직후 일치했다. 시각은 요청 구간과 재수신 불변을 확인하며 생성 값만 정규화했다. |
| 경합·실패·실제 종료 | 두 MSA production 프로세스의 동시 발생 재전송은 한 번만 수집/감사. 실제 DB 감사 INSERT 장애로 질문 수집/삭제·통화 삭제가 롤백됨을 비교. 실제 통화 행 잠금의 2초 REQUEST_IN_PROGRESS, 진행 통화·녹취 RECEIVED/FAILED/살아 있는 claim 차단 통과. 새 수집/삭제 생산자를 준비/커밋 경계에서 SIGKILL해 미커밋 롤백·고아 준비 회수·커밋 감사 확정·재수신 단일 반영을 확인했다. |
| 비공개 감사 수신 | 위조 source·동작/대상 조합·성공 주체·추가 필드·잘못된 번호를 거절하며 inbox/준비 행이 남지 않았다. 기존 customer·CALL_STARTED·분석 경계는 유지했다. |
| consultation 기존 회귀 | production PBX/SSE 19쌍·분석/지표 99쌍·실제 버전 참조 보호/생산자 종료, 별도 test 환경 고객 확인 59쌍·고객 수정/PIN 115쌍과 실제 프로세스 종료 복구 통과. |
| `python msa/parity/verify-customer.py` | `30bf13e790a9`, passed=true, 71개 label. production 읽기와 test 환경 쓰기 68쌍·업무/감사·기존 종료 복구 통과. 최신 주소 누락/null/배열/빈 객체/문자열/필수 우편번호 누락은 AI·관리자 모두 400이며 상세주소 생략/빈 문자열은 201. 자동 월별 청구 워커를 제외한 쓰기 검증이다. |
| `python msa/parity/verify-operations.py` | `f899f17e32d1`, passed=true, 164개 label. 원본 인증·관리자·감사·페르소나/FAQ suite, production 권한/제한·페르소나/FAQ HTTP·DB/알림 FIFO·실제 production 프로세스 SIGKILL와 같은 UUID 재전송/감사·재시작 probe 회귀 통과. 새 감사 동작의 기존 customer 경계 영향도 customer 전체 비교로 확인했다. |
| 서비스 이미지 | 최신 세 서비스 checks/production 이미지 빌드. lint·Jest·E2E·TypeScript·공통 보안 경계와 기존 Node 검사를 유지했다. 새 DELETE Origin E2E는 원본 순서대로 인증 전 거절하는지 확인한다. |
| 이벤트·목록·배포 회귀 | `python msa/shared/events/verify.py`: 실제 PG/HTTP 전달 15개와 기준 목록 1개 통과 (`78342ae7740c`). 최신 source 병합 후 inventory를 다시 실행해 통과. Linux 배포 unittest 61개 통과. |

이번에는 migration/적용된 SQL·의존성·새 Secret 변경이 없다. 세 서비스 비교에서 실제 분리 DB에 기존 changeset을 적용했다. 이전 단계의 전체 SQL upgrade/실패 rollback 426개 label 결과를 이번 신규 실행으로 재사용해 보고하지 않는다. source 최신 테스트·기대값은 수정하지 않았다.

추적 변경은 msa/docs 내부이며 최종 target 대비 backend/frontend/ai·루트 파일은 동일하다. 통화 이벤트 수집/FAQ 사례 생성, 미답변 목록/전환, 주문/청구·배송과 전체 물리 보관 워커 및 전체 API 동등성은 후속이다. 실제 운영 Jenkins/k3s/공개 HTTPS·실제 AI/PBX/S3는 로컬 검증 범위 밖이다. 사용자 MR 병합 후 다음 단계로 진행한다.
