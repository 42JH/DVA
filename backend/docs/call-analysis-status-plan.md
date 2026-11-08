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

- 2단계 계획: 기존 AI_INSIGHTS_TOKEN 가드·providerCallId DTO·감사 패턴을 재사용해 실패 POST를 추가한다. 실패 전용 FOR UPDATE 잠금 뒤 정상 분석을 확인하고 최초 실패만 기록한다. 공통 통화 SQL/DTO에 완료 우선 상태와 MIN 녹취 저장 시각을 추가한다. 구현 전 HTTP 회귀로 누락된 계약을 재현한 뒤 권한·순서/동시성·롤백·페이지네이션을 검증한다.

- 2단계 검증: 구현 전 HTTP 테스트에서 analysisStatus 누락(undefined)을 재현했다. 구현 후 신규 9개 HTTP 테스트 통과, 동일 제품 코드로 기존 분석/목록·상세/녹취 50개 통과. build·전체 src lint·format 통과. 신규 인증 fixture는 기존 관리자 Origin 검사와 ConfigService의 환경변수 fallback을 반영해 보완했으며 기존 보안 검사/기대값은 완화하지 않았다.

- 3단계 계획: AI·프론트 별도 명세와 DB 선적용/과거 미분류 정책을 작성하고 ERD에 컬럼 하나를 맞춘다. 공식 검증의 운영 이미지와 런타임 테스트에 서로 다른 insights/business 토큰을 주입해 실제 Nginx 경로에서 실패 POST·상태 조회·정상 복구를 확인한다. 전체 Docker 및 DB runner를 통과한 후 커밋하고 MR 생성 전 보고한다.

- 3단계 보완: 첫 전체 검증에서 기존 consultations 통합 테스트 10개가 새 두 필드의 기대값 누락으로 실패했다. 기존 전체 응답 deepEqual은 유지하고, 분석 없는 fixture의 PENDING/null과 녹취가 있는 fixture의 최초 저장 시각을 명시한다. 해당 테스트와 신규 상태 테스트를 먼저 재검증한 뒤 공식 전체 검증을 다시 실행한다.

- 3단계 검증: 보완한 기존 통화 조회 24개와 신규 상태 9개를 격리 PostgreSQL에서 재실행해 33개 통과. 최종 `node backend/scripts/check.cjs`는 1,050개 통과·실패/취소/생략 0·종료 0이며 lint/format/Linux 빌드·전체 DB 통합 테스트·운영 이미지·실제 Nginx 실패/복구 경로를 포함한다. 별도 `infra/database/test-monolith.ps1`도 종료 0으로 migration 재실행/변조 거절·원자적 롤백·채워진 구버전 업그레이드·백업/복구를 통과했다. 056/ERD 컬럼 일치·전달 문서 링크·git diff 공백 검사를 확인했다.

- 최종 범위 확인: 원격 develop-backend를 다시 fetch했으며 기준 9624b77과 동일하다. 실제 운영 DB/배포·원격 CI·AI/프론트/MSA 소스·원격 dbdiagram은 변경하거나 연동 검증하지 않았다. 첫 전체 실행 실패 로그와 재실행 성공 로그는 작업 트리 밖 outputs/call-analysis-status-verification-20261108에 보존한다. 실패 통보 누락은 PENDING으로 남으므로 AI의 분석 단계별 영속 통보 연동이 필요하다.
