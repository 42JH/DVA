# 관리자 주문 상태 그룹 변경

## 요청과 응답

기존 `GET /api/admin/orders`의 `statusGroup`을 6개로 재편한다. 전체는 파라미터를 생략한다.

| statusGroup | 포함하는 실제 status | statusCounts 필드 |
| --- | --- | --- |
| COLLECTING | 유효한 INCOMPLETE 초안을 COLLECTING 행으로 반환 | incomplete |
| notPaid | notPaid | notPaid |
| PAID | PAID, SUBMITTING, SUBMITTING_FAILED | paid |
| ACCEPTED | ACCEPTED | accepted |
| SUBMISSION_FAILED | SUBMISSION_FAILED | submissionFailed |
| CANCELLED | CANCELLED | cancelled |

접수 완료 탭은 `GET /api/admin/orders?statusGroup=ACCEPTED`로 조회하고 `statusCounts.accepted`를 표시한다.
결제 완료 탭에서는 이제 접수 완료 주문이 빠지고 자동 재시도 중인 주문이 포함된다.
접수 실패 탭은 자동 재시도가 끝난 최종 실패만 포함한다.

응답에 `statusCounts.accepted`가 추가되며 기존 `paid`와 `submissionFailed`의 집계 범위도 위와 같이 바뀐다.
각 행의 실제 `status` 8개, `data`, `hasNext`, `total_count`, 검색·기간·기업 조건과 정렬은 유지한다.
탭 건수는 선택한 그룹과 limit·offset을 제외한 같은 조회 조건으로 계산한다.
`SUBMITTING`·`SUBMITTING_FAILED`는 개별 상태이며 그룹 값으로 보내면 기존처럼 400이다.

## 적용 범위

모놀리식 관리자 주문 목록의 DTO·Swagger·필터·집계를 변경한다. DB migration과 환경변수 변경은 없다.
기존 주문 데이터를 바꾸지 않으며 저장된 주문은 배포 후 새 그룹으로 조회된다.
결제 승인·디버 전송·자동 재시도·AI의 주문 상태 계약은 유지한다.

홈 `GET /api/dashboard/home`은 같은 집계를 사용하므로 `pendingWork.submissionFailed`도 최종 실패만 포함한다.
프론트는 기존 결제 완료·접수 실패 탭의 의미 변경과 새 접수 완료 탭을 함께 반영해야 한다.
프론트의 상태 그룹 타입·탭 목록에 `ACCEPTED`, 건수 타입에 `accepted`, 탭별 건수 매핑에 `ACCEPTED: 'accepted'`를 추가한다.
MSA는 `msa/parity/baseline.json`의 고정 모놀리식 계약을 비교하는 별도 이행 작업이므로 이번에는 변경하지 않는다.

## 검증

2026-11-10 기존 입력 검증 테스트에 ACCEPTED를 추가해 변경 전 400 실패를 확인한 뒤 구현했다.
`BACKEND_TEST_PROFILE=orders node backend/scripts/check.cjs`로 아래 검증을 통과했다.

| 검증 | 통과 건수 |
| --- | ---: |
| 단위 | 215 |
| 결제 모듈 | 21 |
| 격리 PostgreSQL 주문 관련 통합 | 311 |
| 운영 이미지·Nginx·HTTPS 경유 | 13 |
| 합계 | 560 |

실패·skip·취소는 0이며 컴파일·lint·format 검사도 통과했다. 실행 시간은 약 150초다.
6개 그룹의 실제 행 상태·탭 건수·페이지 범위·검색/기간·기업 조건·권한·Swagger와
접수 실패 → 수동 재접수 성공 뒤의 그룹 이동, 홈 집계·운영 이미지 경로를 회귀 검증했다.
운영 배포·실제 외부 결제/디버 요청·프론트 화면·MSA 동등성 검증은 실행하지 않았다.
