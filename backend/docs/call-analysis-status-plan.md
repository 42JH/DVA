# 통화 분석 상태·첫 녹취 저장 시각 작업

범위는 프론트 요청 1번의 모놀리식 backend와 관련 infra 검증·문서다. AI·프론트·MSA 소스와 운영 DB/배포는 변경하지 않으며 MR 생성 전 보고한다.

## 계약

- 목록 data[]와 상세 data.call에 analysisStatus(PENDING/COMPLETED/FAILED)·recordedAt(최초 recordings.created_at, 없으면 null)을 추가한다. 실제 녹음 시작과 저장 시각을 구분한다.
- 정상 분석이 있으면 COMPLETED, 없고 최종 실패 수신 기록이 있으면 FAILED, 둘 다 없으면 PENDING이다. 시간 경과·PBX·녹취·주문 확정·다른 AI 단계 실패로 분석 실패를 추정하지 않는다.
- POST /api/ai/calls/{id}/analysis/failure는 기존 AI_INSIGHTS_TOKEN과 providerCallId 검증을 재사용한다. AI_BUSINESS_TOKEN과 관리자 쿠키만으로 호출할 수 없다. 본문은 providerCallId 하나이며 최초 기록·재전송·이미 정상 분석이 있는 경우 204다.
- 056 한 개에서 call_sessions.analysis_failed_at nullable timestamptz만 추가한다. 기존 데이터·FK·삭제/5년 보관을 유지하고 과거 실패를 추정하지 않는다.
- 실패는 먼저 통화 행을 FOR UPDATE로 잠그고 기존 정상 분석의 FOR SHARE와 직렬화한다. 실패 기록과 감사 저장은 같은 트랜잭션이다. 성공 결과를 실패로 덮지 않는다.
- 목록/상세는 같은 SQL·DTO에서 상태를 계산한다. 녹취는 통화별 한 값으로 집계하며 목록 중복·추가 HTTP/S3 호출을 만들지 않는다.

## 작업·검증·커밋 순서

1. DB: additive 056·스키마/배포 검증·채워진 055 업그레이드와 실패 롤백 테스트. 검증 후 커밋.
2. API: 실패 수신·공통 조회/DTO/Swagger. HTTP 권한·본문·재전송·성공/실패 순서와 동시 요청·감사 실패·삭제/만료·최초 녹취·페이지네이션 회귀를 검증 후 커밋.
3. 전달/최종: AI·프론트 개별 명세·배포 안내·ERD 정합성. 전체 공식 Docker/DB 검증 후 커밋하고 MR 직전 보고.

## 재분석·신뢰 경계

- 기준 origin/develop-backend 9624b77. 기존 작업 트리는 깨끗하며 feature/call-analysis-status를 생성했다.
- 현재 정상 분석만 call_analyses에 저장되어 미수신과 최종 실패를 구분하지 못한다. 실제 기존 분석 가드는 AI_INSIGHTS_TOKEN이며 앞선 설명의 AI_BUSINESS_TOKEN 표기를 정정했다.
- 외부 입력은 AI 서비스 토큰·경로 번호·providerCallId로 검증한다. 클라이언트 실패 시각/원문 오류/카운터를 받지 않는다. 삭제·만료 통화나 식별자 불일치를 생성·복구하지 않는다.
- AI outbox 전체 FAILED에는 FAQ/미답변/대시보드 실패도 포함된다. 분석 단계의 최종 실패만 통보해야 하며 실패 알림도 AI에서 재전송한다. 알림 누락은 PENDING으로 남는다.
- MSA는 별도 consultation DB와 changelog를 사용하므로 056으로 적용되지 않는다. 이번 범위는 모놀리식이며 후속 MSA 적용 시 계약을 동기화해야 한다.

## 실행 기록

- 1단계 계획: nullable 컬럼 하나만 추가하고 기존 데이터와 적용 migration은 보존한다. 후반 SQL 실패 시 전체 rollback, 기존/신규 통화 기본 NULL, 배포 검증의 미적용/잘못된 스키마 거절을 실제 임시 PostgreSQL에서 확인한다.

- 1단계 검증: 임시 PostgreSQL에서 채워진 055→056 데이터 보존/후반 오류 롤백과 배포 스키마 회귀 합계 23개 통과, build 종료 0. 최초 실행은 verify.sql 편집의 달러 인용 종료 오타로 실패해 수정 후 같은 검증 전체를 다시 실행했다. 운영 적용 없음.
