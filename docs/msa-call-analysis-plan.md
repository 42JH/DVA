# 통화 최종 분석·지표 MSA 이식 계획

- Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)
- 기준: develop-backend `e20b7b34` (MR !321 병합), backend tree `c19c5594540415c579b00eee1917df1cbd954a93`.
- 작업 브랜치: `feature/msa-call-analysis`. 수정 범위는 msa·infra·docs이며 frontend·AI·backend는 수정하지 않는다.

## 이번 MR의 계약

consultation에 원본과 동일한 POST `/api/ai/calls/:id/analysis`, `stage-metrics`, `response-wait-metrics` 세 API를 연결한다. 성공은 본문 없는 204이며 AI_INSIGHTS_TOKEN, Cookie/Origin 우선순위, DTO·오류·정규화·해시·중복/충돌·보관 기간·PBX 시각 우선순위·감사 결과를 원본과 맞춘다. 통화 조회·발화 이벤트·대시보드·주문·FAQ·전체 보관 워커는 후속 MR이다.

## 작업

1. 원본의 두 controller, DTO/types, guard, 두 service/repository를 필요한 부분만 이식한다. 이미 있는 전역 세션/HTTP 오류/감사 이벤트 절차를 사용한다. 지표는 분석이 저장된 통화만 수신하고 항목별 해시를 독립 관리한다.
2. consultation 005에 최종 call_analyses·call_dashboard_metrics 및 원본 CHECK/함수/로컬 FK를 추가한다. 기존 통화와 적용 이력은 보존하고 과거 분석을 만들지 않는다.
3. 페르소나는 operations 소유이므로 consultation이 버전 테이블을 복제하거나 다른 DB에 접속하지 않는다. 인증된 비공개 조회 이벤트가 응답하기 전에 operations 008의 FK 참조를 예약해 원본 FOR KEY SHARE의 보호 시작점을 유지한다. 기존 AuditPrepared에 예약을 연결하고 Committed/Aborted와 같은 트랜잭션에서 확정·해제한다. 동일 재수신의 임시 참조도 해제하며 감사 준비 전 생산자가 종료된 예약은 기존 잠금 증명으로 회수한다. 감사 공개 metadata와 행은 원본 그대로 유지한다. 향후 분석 보관 삭제를 이식할 때 확정 참조 해제를 함께 연결한다.
4. consultation의 기존 runtime Secret에서 선택적 AI_INSIGHTS_TOKEN을 읽는다. 미설정이면 해당 세 API만 원본처럼 503이다. 새 앱·Redis·의존성·프론트/AI 전용 API를 추가하지 않는다.

operations의 기존 앱에서 대기 상담 트랜잭션을 1초 간격으로 기존 복구 절차에 연결한다. 살아 있는 consultation DB 트랜잭션의 advisory lock은 중단 확정을 막으며, 조회 ACK 뒤 감사 준비 이전의 종료도 별도 감사 조회 요청 없이 회수한다. customer 감사 준비를 주기 중단 대상으로 넓히지 않는다.

## 검증과 커밋

계획 → 구현 → 검증을 작업 단위로 커밋한다. 원본의 분석/지표 단위·통합 테스트, 실제 production HTTP 응답·DB 행·해시·감사 비교, 중복/충돌·인증·버전 삭제 경합·감사 실패/프로세스 종료 복구를 확인한다. 기존 PBX/SSE·고객 확인·PIN·operations 인증/페르소나도 회귀 검증한다. 새 설치·기존 DB 업그레이드·changeset 실패 rollback과 서비스 Docker checks/이미지 빌드 및 배포 스크립트 검사를 수행한다. 실패가 나면 원인을 수정하고 관련 검증을 다시 실행한다.

검증 후 develop-backend 대상 MR을 생성하고 Jira에 링크·근거·미검증 범위를 기록한다. 직접 병합하지 않고 사용자 병합 후 다음 단계로 진행한다. 로컬 Docker 검증과 실제 Jenkins/운영 배포 결과를 구분해 보고한다.

## 검증 결과 (2026-11-06)

| 범위 | 확인한 결과 |
| --- | --- |
| 새 공개 API | NODE_ENV=production에서 원본과 HTTP 99쌍의 상태·본문·헤더, 분석/지표/통화 행·해시·성공/실패 감사 일치. 동일 동시 재수신은 독립 DB의 임의 승자 요청 ID만 대응시키고 성공 감사 1건씩을 별도 확인 |
| 실제 버전 참조 | 조회 ACK부터 물리 삭제 차단, 잘못된 내부 이벤트 거절, 동일 재수신 임시 참조 해제, 조회 직후·감사 준비 후 SIGKILL의 rollback/자동 회수, 커밋 후 SIGKILL의 감사/참조 확정, 늦은 abort 후 확정 참조 보존 |
| 원본 테스트 | 변경하지 않은 원본 단위·통합 테스트와 기존 PBX/워커 등 monolith 99개·consultation 26개 통과. 분리 서비스의 필수 peer 환경만 별도 preload fixture로 제공 |
| 기존 상담/고객 | production PBX 19쌍·SSE, 별도 test 환경 고객 확인 59쌍·PIN 115쌍·통화 잠금·등록 SSE·실제 SIGKILL 복구 통과 |
| operations/customer | operations 인증·감사·페르소나·제한·실제 재시작 복구와 customer 조회/쓰기/즉시 감사 비교 통과. 검증기 실행 로그 label은 각각 101개·71개이며 테스트 개수가 아님 |
| DB/공통 CI | PostgreSQL 17.11·Liquibase 5.0.4 새 설치/업그레이드/후반 실패 rollback 및 361개 실행 label 확인. 이벤트 전달 15개·backend 기준 목록 1개·Linux 배포 단위 59개 통과 |
| 이미지 | consultation/operations production 이미지와 Docker checks의 ESLint·Jest·E2E·TypeScript 통과. consultation Node checks 33개, operations E2E 9개 통과 |

재현 명령은 `python msa/parity/verify-consultation.py`, `python msa/parity/verify-operations.py`, `python msa/parity/verify-customer.py`, `python msa/liquibase/verify.py`, `python msa/shared/events/verify.py`다. 성공한 최종 실행은 consultation `643eb0162e98`, operations `58bae062dd9c`, customer `837ec18bca87`이며 로그는 msa/liquibase/verification-logs 아래에 생성된다.

검증 중 전역 prefix에 새 비공개 경로를 연결하지 않은 원인과, 감사 조회가 있어야만 수행되던 준비 복구 경로를 수정하고 E2E/실제 종료 회귀를 추가했다. 원본 테스트 기대값이나 검사를 완화하지 않았다. 새 008 changeset을 확인하도록 MSA fixture의 정확한 이력 수와 필수 테이블 검사를 갱신했다.

실제 운영 Jenkins·공개 HTTPS/k3s·실제 AI/PBX/S3 연동은 이번 로컬 검증에 포함하지 않는다. 운영은 기존 AI_INSIGHTS_TOKEN을 consultation-runtime Secret에 주입해야 한다. 상담 조회/발화·대시보드·주문·FAQ·전체 보관 워커 및 96개 API 전체 동등성은 후속 범위다. 고객 확인/PIN test 환경은 아직 이식하지 않은 월별 청구 자동 워커를 제외한다.
