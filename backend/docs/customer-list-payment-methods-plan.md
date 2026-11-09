# 고객 목록 결제 가능 수단

## 계획과 범위

- 기존 feature/call-analysis-status에서 3번 요구사항을 이어서 작업한다. 시작 시 작업 트리는 깨끗하며 앞선 통화 분석·기업 조회 커밋은 보존한다. 최신 origin/develop-backend의 추가 변경은 MSA 영역으로 이번 backend 조회와 겹치지 않는다.
- GET /api/customers의 data[]에 availablePaymentMethods 배열을 추가한다. billing은 개인 카드, credit은 월결제, groupBilling은 부서 그룹결제이며 이 순서를 유지한다. 기존 필드·필터·정렬·페이지·total_count·권한은 유지한다.
- POST /api/customers/context의 현재 계산식을 같은 Repository 안에서 공유한다. ACTIVE 개인 고객은 billing, 미삭제 소속이 없고 개인 월결제가 허용되면 credit을 추가한다. ACTIVE 소속·기업에서 기업 월결제가 허용되면 credit, 같은 기업의 미삭제 부서에서 그룹결제가 허용되면 groupBilling을 독립적으로 추가한다.
- 비활성 소속·기업은 기업 결제 자격을 주지 않으며, 미삭제 소속이 있으면 개인 월결제로 우회하지 않는다. 삭제된 소속은 현재 소속에서 제외한다. 탈퇴 고객은 [], 삭제된 고객은 목록에서 제외한다. 현재 context의 삭제/비활성 처리도 그대로 유지한다.
- 목록 전용 DTO와 기존 결제 수단 타입을 사용한다. 고객 상세·사원 응답·context.customer의 공통 DTO에는 새 필드를 추가하지 않는다. context의 최상위 계약과 실제 주문·결제 시 자격 재검증은 유지한다.
- 고객·소속·기업·부서를 한 목록 SQL에서 읽고 고객마다 context API나 주소록을 조회하지 않는다. 기존 미삭제 소속 UNIQUE와 PK를 사용하며 새 DB 컬럼·인덱스·migration·캐시·의존성은 없다. 조회에 새 쓰기·잠금·외부 호출을 추가하지 않는다.
- backend 내부 구현·Swagger·테스트·작업 기록만 변경한다. AI/프론트별 전달 명세는 후속 요구사항과 모아서 전달하며 MR·push·운영 배포는 이번 작업 범위가 아니다.

## 작업 단위와 검증

1. 계획: 목록/context의 호출자·공유 DTO·결제 자격·soft delete·페이지 계약과 테스트 실행 목록을 확인한다.
2. 작업: 먼저 HTTP 회귀로 필드 누락을 재현한 뒤 공통 결제 SQL, 목록 전용 응답 DTO, Swagger를 반영한다. 기존 고객 통합 테스트에 시나리오를 추가해 실행 목록은 그대로 재사용한다.
3. 검증: 개인·기업·부서 자격 조합의 목록/context 동등성, 탈퇴·삭제·비활성·이력 중복, 페이지/전체 건수, 관리자/AI 경계, 부작용 없는 고정 조회 수, 공통 응답 보존을 확인한다. build·lint·format과 관련 회귀 후 공식 Docker 전체 검증의 운영 이미지/Nginx까지 확인한다.
4. 검증 결과와 한계를 기록한 뒤 이 작업만 feat 커밋 하나로 남기고 사용자에게 보고한다.

## 실행 기록

- RED: 제품 변경 전 고객 HTTP 테스트 24개 중 기존 계약과 고정 조회 수 검사는 20개 통과했고 신규 4개가 필드/Swagger 누락으로 실패했다. 환경의 Docker 접근 제한은 권한이 있는 격리 실행으로 해소한 뒤 실제 계약 누락을 재현했다.
- 구현: 기존 context의 결제 CASE 식을 Repository 내부 상수로 공유하고 목록에서 고객·미삭제 소속·기업·같은 기업 부서를 LEFT JOIN한다. 목록 전용 CustomerListItemDto와 공통 결제 수단 타입을 추가했다. 기존 공통 CustomerResponseDto의 응답 필드는 그대로다.
- 관련 검증: 새 결제 HTTP 검사 5개를 포함해 고객·context·사원·결제 자격·결제 처리·기업 삭제/등록·soft delete·페이지네이션 통합 테스트 170개 통과, 실패/취소/생략/할 일 0, 종료 0. 개인 2가지와 소속/기업 상태·기업 월결제·부서 그룹결제 16가지 조합을 기대값 및 context와 비교했다. 삭제/누락/탈퇴 변경의 다음 조회 반영, 삭제 이력으로 인한 중복 방지, 페이지 크기와 무관한 조회 횟수, 업무 쓰기 없음, AI 목록 접근 차단, 상세/Swagger 계약 보존을 확인했다.
- 로컬 build·전체 src lint·format 검사 종료 0, git diff --check 통과.
- 최종 검증: 공식 `node backend/scripts/check.cjs` 종료 0. Linux 빌드·lint/format·전체 단위/통합 테스트·운영 이미지·실제 Nginx/HTTPS/PBX 회귀 합계 1,065개 통과, 실패/취소/생략/할 일 0. Nginx 경유 고객 목록에 availablePaymentMethods가 보존되고 context 결과와 같은지 확인했다. 앞선 통화 분석 상태와 기업 조회 회귀도 포함한다.
- 검증 로그와 집계는 저장소 밖 `outputs/customer-list-payment-methods-verification-2026-11-08T10-50-44-886Z`에 보관한다. 실제 운영 DB·원격 CI·프론트 화면은 검증하지 않았다. 현재 조회 자격은 결제 예약이 아니며 실제 주문·결제의 기존 재검증을 유지한다.
- 이번 변경은 backend 내부 9개 파일이며 DB/migration/FK·기존 결제 처리·AI/프론트 소스·infra·MSA 변경은 없다. 전달 명세는 후속 작업까지 누적한다.
