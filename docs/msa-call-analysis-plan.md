# 통화 최종 분석·지표 MSA 이식 계획

- Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)
- 기준: develop-backend `e20b7b34` (MR !321 병합), backend tree `c19c5594540415c579b00eee1917df1cbd954a93`.
- 작업 브랜치: `feature/msa-call-analysis`. 수정 범위는 msa·infra·docs이며 frontend·AI·backend는 수정하지 않는다.

## 이번 MR의 계약

consultation에 원본과 동일한 POST `/api/ai/calls/:id/analysis`, `stage-metrics`, `response-wait-metrics` 세 API를 연결한다. 성공은 본문 없는 204이며 AI_INSIGHTS_TOKEN, Cookie/Origin 우선순위, DTO·오류·정규화·해시·중복/충돌·보관 기간·PBX 시각 우선순위·감사 결과를 원본과 맞춘다. 통화 조회·발화 이벤트·대시보드·주문·FAQ·전체 보관 워커는 후속 MR이다.

## 작업

1. 원본의 두 controller, DTO/types, guard, 두 service/repository를 필요한 부분만 이식한다. 이미 있는 전역 세션/HTTP 오류/감사 이벤트 절차를 사용한다. 지표는 분석이 저장된 통화만 수신하고 항목별 해시를 독립 관리한다.
2. consultation 005에 최종 call_analyses·call_dashboard_metrics 및 원본 CHECK/함수/로컬 FK를 추가한다. 기존 통화와 적용 이력은 보존하고 과거 분석을 만들지 않는다.
3. 페르소나는 operations 소유이므로 consultation이 버전 테이블을 복제하거나 다른 DB에 접속하지 않는다. 인증된 비공개 조회 이벤트로 실제 버전 존재를 확인한다. operations 008의 FK 참조 행을 기존 AuditPrepared/Committed/Aborted와 같은 트랜잭션에서 준비·확정·해제해 저장 중 버전 삭제와 프로세스 종료를 처리한다. 감사 공개 metadata와 행은 원본 그대로 유지한다. 향후 분석 보관 삭제를 이식할 때 확정 참조 해제를 함께 연결한다.
4. consultation의 기존 runtime Secret에서 선택적 AI_INSIGHTS_TOKEN을 읽는다. 미설정이면 해당 세 API만 원본처럼 503이다. 새 앱·Redis·의존성·프론트/AI 전용 API를 추가하지 않는다.

## 검증과 커밋

계획 → 구현 → 검증을 작업 단위로 커밋한다. 원본의 분석/지표 단위·통합 테스트, 실제 production HTTP 응답·DB 행·해시·감사 비교, 중복/충돌·인증·버전 삭제 경합·감사 실패/프로세스 종료 복구를 확인한다. 기존 PBX/SSE·고객 확인·PIN·operations 인증/페르소나도 회귀 검증한다. 새 설치·기존 DB 업그레이드·changeset 실패 rollback과 서비스 Docker checks/이미지 빌드 및 배포 스크립트 검사를 수행한다. 실패가 나면 원인을 수정하고 관련 검증을 다시 실행한다.

검증 후 develop-backend 대상 MR을 생성하고 Jira에 링크·근거·미검증 범위를 기록한다. 직접 병합하지 않고 사용자 병합 후 다음 단계로 진행한다. 로컬 Docker 검증과 실제 Jenkins/운영 배포 결과를 구분해 보고한다.
