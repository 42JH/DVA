# 기업·부서 삭제와 기록 보존

Backend 전용 기능. 현재 앱은 `053-drop-company-pins.sql`까지 적용한다. 기업 PIN 테이블 제거·과거 참조 호환은 [053 전환 안내](../../backend/docs/company-pin-retirement.md)를 우선한다.

| API | 권한·입력 | 응답 |
| --- | --- | --- |
| DELETE /api/companies | 모든 활성 관리자, 관리자 세션·허용 Origin, organizationSeqs 배열 1~100개 | 204, 본문 없음 |
| DELETE /api/departments | 동일, departmentSeqs 배열 1~100개 | 204, 본문 없음 |

기업은 단건도 `{ "organizationSeqs": [123] }`로 전달한다. 기존 `DELETE /api/companies/{id}`는 제거되어 404이며 GET 상세와 PATCH는 유지한다. 기존 프론트 상세 삭제가 구형 URL을 사용하므로 [호출 전환 명세](../../backend/docs/company-delete-array-only.md)를 적용한 뒤 함께 배포한다.

없거나 이미 삭제된 ID는 404, 잘못된 ID는 400, 작업 잠금 경합은 409다. AI는 삭제할 수 없다. 재요청해도 같은 데이터를 다시 삭제하거나 청구하지 않는다. 응답 유실 뒤 재요청의 404는 대상이 이미 없는 상태이므로 목록을 다시 조회한다.

## 삭제 범위

| 대상 | 기업 삭제 | 부서 삭제 |
| --- | --- | --- |
| 기업·부서 | 기업과 소속 부서 전체 soft delete | 해당 부서만 soft delete |
| 소속 | 기업 구성원 전체 소속 soft delete | 해당 부서 구성원 소속 soft delete |
| 개인 고객·개인 월결제 설정·개인 PIN | 보존 | 보존 |
| 기업 PIN | 053에서 테이블 제거, 삭제 API는 접근하지 않음 | 동일 |
| 다른 부서·사원 | 다른 기업 데이터 보존 | 같은 기업의 다른 부서·사원 보존 |
| 주문·상세·배송·결제 요청·청구 원장·월별 금액 | 보존 | 보존 |
| 통화·발화·녹취 객체와 DB 연결·기존 감사 로그 | 보존 | 보존 |

마지막 부서를 삭제하면 기업은 부서·구성원이 없는 상태로 남을 수 있다. 새 구성원을 연결하기 전에 새 부서를 생성한다. 소속 해제 후 월결제는 고객 자신의 `monthlyBillingEnabled`를 적용하며, 이전 회사의 월결제·그룹결제 권한을 승계하지 않는다.

## 기존 기업 PIN 이력

기업 PIN 등록·수정·조회 API는 폐기되었다. 기업 공유 배송지는 활성 기업 사원의 현재 고객 주소에서 조회한다. 053은 company_pins만 제거하고 과거 주문의 COMPANY 논리 참조·주소 사본·기존 감사를 유지한다. 기업·부서 삭제나 개명에서 PIN 동기화·새 PIN 감사는 수행하지 않는다.

## 과거 주문과 청구 조회

결제 시 `billingOrganizationSeq`, `billingOrganizationName`, `billingDepartmentSeq`, `billingDepartmentName`을 복사하고 주문 상세에 반환한다. 삭제 후에도 번호·이름·금액·주소·버전·상태·접수 결과를 지우거나 다시 계산하지 않는다. 기업·부서의 재등록은 새 번호를 사용하며 과거 기록을 새 기업에 연결하지 않는다.

`GET /api/companies/{id}`는 삭제 후 404다. `GET /api/companies/{id}/billing?month=YYYY-MM`은 보존된 청구 월이 있으면 해당 회사의 과거 합계와 `organizationName`을 반환한다. 삭제된 기업의 미기록 월은 404이며 새 월을 생성하지 않는다. 결제 후 기업·부서를 개명해도 기존 주문 이름은 유지된다. 과거 월의 기업명은 그 월의 최초 생성 시점 이름이다.

021 이전 주문은 이관 시 확인 가능한 현재 기업·부서명으로 보완한다. 과거 개명 이전의 실제 이름은 복원할 수 없다. 이관 중 기존 주문 `updated_at`·버전·내용을 변경하지 않는다.

## 진행 중인 주문

- `COLLECTING`: 삭제 전 내용을 그대로 보존한다. 접수 시 현재 결제 자격과 PERSONAL PIN 권한을 다시 검사한다. 결제 자격이 사라졌으면 403이며 자동 전환하지 않는다. 과거 COMPANY는 저장된 주소 사본으로 진행한다. 주소 변경 시에만 originPin을 null 또는 유효한 PERSONAL로 전환한다.
- `notPaid`: 기존 금액·주소·만료 시각·결제 요청을 유지한다. 회사·PIN 삭제 후에도 개인 결제를 완료할 수 있다.
- `PAID`·`SUBMITTING`·`SUBMISSION_FAILED`·`ACCEPTED`: 결제 당시 사본으로 진행하며 회사 삭제가 취소·재청구를 유발하지 않는다. 실패 주문은 기존 관리자 재접수 API를 사용한다.

## 트랜잭션과 감사

소속/CSV 공통 잠금 → 대상 고객 번호순 잠금 → 기업·부서 잠금 → 소속 soft delete → 부서·기업 soft delete 순서다. 삭제와 성공 감사는 같은 트랜잭션이며 감사 저장 실패도 전체 롤백한다. 디버·S3·AI에 삭제 요청을 보내지 않는다.

작업 주체는 요청 관리자 `ADMIN`, 표시명 `운영자`다. 소속별 `MEMBERSHIP_REMOVED`, 부서별 `DEPARTMENT_DELETED`, 기업 `ORGANIZATION_DELETED`를 같은 `requestId`로 연결한다. 작업자 번호·이름과 `organizationSeq/organizationName`, 해당 시 `departmentSeq/departmentName/customerSeq`를 보존한다. 개인 주소·전화번호·사번을 삭제 로그에 복사하지 않는다. 기존 COMPANY_PIN·AI·SYSTEM 로그의 주체와 내용은 바꾸지 않는다.

## 배포와 검증

기존 백엔드 쓰기 중지 → 백업 → 021 적용·검증 → 새 앱 실행 순서다. 021 이후에는 구버전 앱이 PIN 연결과 역사 이름을 누락할 수 있어 해당 migration이 없는 배포·롤백·자동 복귀를 차단한다. 이미 적용한 001~020은 수정하지 않는다.

검증은 격리 PostgreSQL의 `company-deletion.integration.test.cjs`, PIN·주문·기업·통화 관련 회귀, `infra/database/test-monolith.ps1`의 020→021 데이터 보존·실패 롤백, `infra/deploy/test-deploy.sh`를 사용한다. 실제 운영 DB·S3 삭제는 이 기능 구현/검증에 포함하지 않는다.

2026-10-30 검증: `npm run check:docker`에서 단위 76개·결제 테스트 21개·DB 통합 367개·실제 Nginx 17개, 합계 481개 통과. 전체 DB 구성·기존 이관·021 실패 롤백, Linux 배포 모의 테스트 통과. ERD의 테이블 25개·컬럼 212개·FK 20개를 격리 DB와 대조했다. `npm audit --omit=dev --audit-level=high`는 알려진 취약점 0개다. 실제 디버·결제사·카카오·S3 호출과 서버 배포는 검증하지 않았다.
