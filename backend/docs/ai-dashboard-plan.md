# AI 상담 성능 대시보드 작업 계획

## 확정 범위

- 기준: develop-backend fbbaca1, 작업 브랜치 feature/ai-dashboard. backend·필수 DB 검증과 ERD 문서만 수정한다.
- 프론트 GET 4개: /api/dashboard/stage-dropoffs, registration-time, complaint-calls, response-wait. 공통 customerType=ALL|NEW|EXISTING, 기본 ALL. 날짜 필터 없음.
- AI POST 2개: /api/ai/calls/{id}/stage-metrics, response-wait-metrics. 기존 analysis 저장 후 두 API를 독립 전송한다.
- 이탈은 dropoffStage 하나만 받는다. NONE은 이탈 없음, 미수신은 NULL. 단계 진입 수는 받지 않으며 비율 분모는 이탈 판정 완료 종료 통화다.
- 접수 시간은 접수가 있는 통화 전체 시간 합계 / 같은 통화의 registeredParcelCount 합계다. 배송 상세 단위·결제 대기 포함. PBX 시각 우선, AI 분석 시각 대체. FAQ·조회 시간을 분리하지 않는다.
- 불편은 기존 hasComplaint·complaints를 사용하고 화면용 코드 5개를 추가한다. SLOW_RESPONSE와 과거 코드 4개를 유지하며 RAG·미답변 reason과 연결하지 않는다. 유형별로 같은 통화는 한 번 센다.
- AI가 totalWaitMs와 처리 유형별 totalLatencyMs·measurementCount를 보낸다. 전체 대기시간은 AI가 겹치는 구간을 제외한다. P95·원본 대기 표본은 저장하지 않는다.
- 신규 고객 여부·페르소나는 기존 분석값을 사용한다. ALL에는 고객 미분류도 포함하고 NEW/EXISTING에서 제외한다. 지표 미수신을 0으로 만들지 않으며 분모 0은 비율·평균 NULL이다.
- 신규 call_dashboard_metrics 한 테이블, 8개 컬럼, 분석과 1:1 CASCADE FK. 부모 call_sessions.deleted_at으로 조회를 숨기고 최초 incoming_at부터 5년 폐기 시 분석과 함께 제거한다. 별도 deleted_at·접수 시간 컬럼 없음.

## 순차 작업 및 커밋

1. 계획·영향 확인 → migration 050·DB 제약·배포 verify·ERD·DB 검증 추가. 격리 DB runner와 업그레이드·원본 보존·실패 롤백·CASCADE를 검증한 뒤 커밋한다.
2. AI DTO·토큰 가드 재사용·독립 항목별 원자 저장/해시·성공 감사·불편 코드 확장을 구현한다. 입력·인증·재전송/충돌·동시 저장·감사 실패 롤백·기존 분석 회귀를 검증한 뒤 커밋한다.
3. dashboard 업무 모듈에 GET 4개와 Swagger 응답을 구현한다. 한 SQL 스냅샷에서 집계하고 1:N 중복을 방지한다. 빈 표본·고객 필터·페르소나 가중 평균·불편 중복·레거시·대기 가중 평균·삭제/만료 제외를 검증한 뒤 커밋한다.
4. AI·프론트 별도 연동 MD와 README/API 문서를 작성한다. 전체 backend Docker 검사·DB runner·차이 검사를 마치고 검증 결과를 기록·커밋한다.

## 보존 및 영향 확인

- 과거 001~049 migration·기존 행·분석 해시·시각·기존 FK/트리거는 변경하지 않는다. 신규 표준 제약은 DB 직접 저장도 검증한다.
- AI는 두 항목을 같은 통화에 각각 한 번 확정한다. 최초/동일 재전송 204, 변경 409. 두 항목을 섞어 덮어쓰지 않으며 최초 수신 시각·감사를 중복 생성하지 않는다.
- 부모 통화 잠금으로 soft delete·실제 폐기와 저장 경쟁을 보호한다. 분석 미수신이면 409, 소유 ID 불일치 403, 통화 삭제/만료/없음은 404다.
- 주문·결제·PIN·FAQ·웹훅·기존 SSE·인증/Origin·nginx·환경변수·의존성은 기능 변경하지 않는다. 통화 목록/상세는 기존 구조로 신규 불편 코드도 반환한다.
- 운영 DB 적용·배포·실제 AI/프론트 연동·PR 생성은 이번 로컬 구현/검증 작업과 별도다.

## 진행 기록

- 저장소 청결·원격·작성자 확인 완료. 이전 미답변 PR이 병합된 최신 기준에서 작업 브랜치를 생성했다.
- 검증 결과와 단계별 커밋은 각 단계 종료 시 기록한다.
- 1단계: 격리 DB runner exit 0, ALL MONOLITH DATABASE CHECKS PASSED. 049 상태의 기존 통화/분석 전체 행·해시·시각 보존, 050 직접 SQL 제약/JSON/PK/FK, 항목 독립 저장, soft delete 보존·분석 폐기 CASCADE를 검증했다. 신규/이전 업그레이드·반복 적용·체크섬 거절·최초/후속 실패 롤백·백업 복원도 통과했다. 운영 DB는 변경하지 않았다.
