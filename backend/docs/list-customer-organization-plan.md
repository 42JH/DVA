# 통화·관리자 주문 목록의 고객 소속 조회

## 범위와 기준

- 기존 feature/call-analysis-status의 45cbbde부터 누적한다. origin/develop-backend 9624b77과 기준 차이는 기존 1번 작업의 세 커밋뿐이며 시작 시 작업 트리는 깨끗하다.
- 통화 목록 data[]·상세 data.call에 organizationName을 추가한다. 기존 customerSeq·customerName과 동일하게 주문 고객 우선, 없으면 통화에 등록된 고객을 사용한다.
- 관리자 GET /api/admin/orders 항목에는 organizationName과 customerSeq를 추가한다. 고객 미연결·삭제 시 customerSeq=null이며 원본 주문의 논리 참조는 보존한다.
- 기업명 있음은 기업 고객, 기업명 없음+customerSeq 있음은 현재 무소속 고객, customerSeq=null은 미확인이다. customerCategory/customerType 응답 필드는 추가하지 않는다.
- 현재 소속·현재 기업명 기준이다. 삭제되지 않은 INACTIVE 소속·기업도 이름을 표시한다. 삭제된 고객·소속·기업의 이름은 노출하지 않고 LEFT JOIN으로 통화·주문 행은 보존한다. 소속 변경/삭제 시 과거 목록 표시도 바뀌며 결제 당시 billingOrganizationName과 혼용하지 않는다.
- 두 관리자 목록에서 organizationSeq 양의 int32 필터를 지원한다. 다른 조건과 AND, 미존재/삭제 기업은 빈 목록이며 목록과 total_count의 조건은 같다.
- DB/마이그레이션/FK/보관 정책·AI 일반 주문 조회/접수·결제·권한·환경변수는 변경하지 않는다. 기존 고객별 미삭제 소속 UNIQUE와 기업 PK를 재사용하며 새 캐시/인덱스/외부 호출은 없다.
- 사용자 요청에 따라 AI/프론트별 전달 명세는 후속 작업과 누적해 마지막에 전달한다. 이번에는 Swagger와 내부 작업 기록만 함께 갱신한다. MR/푸시/운영 배포는 이번 범위가 아니다.

## 작업 단위

1. 통화: 실패하는 HTTP 회귀로 기업명/필터 누락을 확인한 뒤 공통 SQL·DTO·Swagger와 기존 전체 응답 fixture를 수정한다. 고객 선택 우선순위, 주문 없는 통화, 개인/기업/미확인, 삭제/비활성, 현재 소속 변경, 중복 없는 페이지/총계, 입력·권한을 검증하고 커밋한다.
2. 관리자 주문: 같은 소속 기준과 customerSeq/기업명·기업 필터를 관리자 전용 DTO/SQL에 반영한다. 기존 상세 parcels·상태 탭·합계/페이지·AI 접근 차단과 일반 주문 API 계약 보존을 검증한다. 실제 Nginx 운영 이미지 회귀를 포함한 공식 전체 검증 후 별도 커밋한다.

## 신뢰 경계·영향 확인

- 새 입력은 관리자 조회의 organizationSeq뿐이며 기존 세션/역할/Origin을 유지한다. DTO는 정수/범위를 검사하고 SQL 값은 바인딩한다. 조회에 쓰기나 새 잠금·트랜잭션을 추가하지 않는다.
- 공통 통화 SELECT의 findMany/findOne 및 이를 쓰는 상세·STT 접근 확인을 점검한다. 관리자 주문은 adminList의 전용 경로만 바꾸고 공유 OrderSummaryDto/list/detail은 유지한다.
- 기존 테스트의 전체 응답 비교·보안/soft delete 검사를 유지한 채 새 필드 기대값을 명시한다. 신규 HTTP 테스트는 격리 PostgreSQL과 무작위 식별자만 사용한다.

## 실행 기록

- 1단계 RED: 제품 수정 전 신규 HTTP 테스트에서 organizationName 누락(undefined)과 유효한 organizationSeq의 기존 400 거절을 재현했다.
- 1단계 검증: 통화 기업 조회 5개와 기존 통화 목록/상세·분석 상태·분석 조회·녹취를 새 임시 PostgreSQL에서 합계 74개 통과(실패/생략 0, 종료 0). build·전체 src lint·format 검사도 종료 0이다. 기존 전체 응답 비교는 유지하고 organizationName=null 기대값만 추가했다.
- 2단계 RED: 관리자 제품 수정 전 기존 통화 5개는 통과하고 관리자 신규 5개는 customerSeq 누락과 정상 기업 필터 400으로 실패했다.
- 2단계 검증: 관리자/통화 신규 10개와 기존 주문·재접수 목록·soft delete 회귀 합계 141개를 새 임시 PostgreSQL에서 통과했다(실패/생략 0, 종료 0). build 종료 0. 일반 AI 주문 목록/상세에는 organizationName·고객 유형 필드를 추가하지 않았으며 실제 HTTP로 기존 본인 고객 범위와 원본 주문 데이터 보존을 확인했다. 기존 관리자 목록의 전체 필드·Swagger 비교도 유지했다.
- 최종 검증 계획: 공식 Docker 검증의 운영 이미지·실제 Nginx에서 통화 기업명/고객번호와 두 목록의 기업 필터, 관리자 주문 새 필드가 보존되는지 확인한다. 기존 분석 실패/복구 경로와 모든 회귀를 함께 통과한 뒤 두 번째 단위를 커밋한다.
- 최종 결과: 공식 `node backend/scripts/check.cjs` 종료 0, 합계 1,060개 통과, 실패/취소/생략/할 일 0. lint/format·Linux 빌드·전체 격리 DB 통합 테스트·운영 이미지·Nginx/HTTPS/PBX 회귀를 포함한다. 실제 Nginx에서 통화의 organizationName=null과 기존 분석 상태, 두 목록의 유효한 기업 필터, 관리자 주문의 customerSeq/organizationName 필드가 보존됨을 확인했다.
- 범위 재확인: 이번 2번 변경에는 migration·DB/FK·infra·AI/프론트·공유 일반 주문 DTO/컨트롤러 변경이 없다. 검증은 로컬 임시 PostgreSQL과 Docker이며 실제 운영 배포·프론트 화면·원격 CI 검증은 하지 않았다. 별도 연동 명세 전달은 후속 작업까지 누적한다.
