# 통화 분석 상태 056 배포·검증

적용 대상은 모놀리식 backend와 기존 DB runner다. AI·프론트·MSA 소스와 운영 시스템은 이번 작업에서 수정하지 않는다.

## DB

신규 `056-call-analysis-failure.sql` 한 개에서 call_sessions.analysis_failed_at nullable timestamptz만 추가한다. 기본값·신규 테이블·FK·과거 실패 backfill은 없다. 기존 분석·녹취·주문·시각·적용 migration checksum은 보존한다. 기존 앱은 추가 컬럼을 무시할 수 있으며 기존 runner/백업 정책을 따른다.

analysisStatus는 정상 분석 우선으로 조회 시 계산하고 recordedAt은 기존 녹취 최초 저장 시각으로 조회한다. 실패 수신 기록은 통화의 기존 soft delete·최초 수신 기준 5년 보관을 따르며 로그 7일 정리나 재전송으로 수명을 바꾸지 않는다.

## 순서

1. 기존 백업/배포 절차로 056을 적용하고 infra/database/verify.sql의 ledger·nullable/default/type 검사를 통과시킨다.
2. 새 backend를 배포한다. 기존 AI_INSIGHTS_TOKEN을 확인하며 주문·고객용 AI_BUSINESS_TOKEN과 혼용하지 않는다. 새 환경변수는 없다.
3. AI가 새 실패 통보 API를 영속 재전송 경로에 연결한다. 분석 단계 실패를 전체 outbox 실패와 구분한다. AI가 실제 실패를 확인한 과거 통화는 선택적으로 재통보한다.
4. 프론트가 목록 data[]/상세 data.call의 analysisStatus·recordedAt을 사용하고 5분 경과/추가 상세 조회 우회를 제거한다.
5. 새 통화의 PENDING → 실패 통보 FAILED → 정상 분석 복구 COMPLETED, 늦은 실패 유지, 녹취 최초 시각과 기존 목록/상세를 확인한다.

056은 MSA의 consultation_db와 Liquibase를 바꾸지 않는다. 해당 쓰기 API와 후속 목록·상세 이식은 독립된 후속 범위다.

## 검증 범위

- 임시 PostgreSQL에서 채워진 055 업그레이드·후반 SQL 실패 rollback·원본 데이터/FK 보존.
- 실제 HTTP의 insights 토큰/관리자 Origin·식별자·삭제/만료·본문 검증, 최초 실패/동시 요청/정상 결과 우선·감사 실패 rollback.
- 목록과 상세의 공통 상태·최초 녹취·중복 없는 total_count 및 기존 분석/녹취 회귀.
- 공식 Docker lint/format/빌드·전체 테스트와 운영 이미지·실제 Nginx 경로의 실패/복구 인증 검증. runtime 검증용 두 토큰은 매 실행 별도 난수다.

실제 AI 서버·결제사·디버·운영 DB 연동과 원격 dbdiagram 갱신은 포함하지 않는다. 실패 통보 누락은 PENDING으로 남으며 과거 원인을 추정해 바꾸지 않는다.
