# 부서와 결제 자격

Jira: [S15P31D109-138](https://ssafy.atlassian.net/browse/S15P31D109-138).

관리자 세션·기존 Origin 검사를 적용한다. 부서 조회·등록·수정은 OPERATOR, SUPERVISOR, SYSTEM_ADMIN이 사용할 수 있다.

| API | 입력 | 응답 |
| --- | --- | --- |
| GET /api/companies/{id}/departments | 기업 번호, limit/offset | data에 부서 목록, hasNext |
| POST /api/companies/{id}/departments | name, groupBillingEnabled(선택) | 201, data.departmentSeq |
| PATCH /api/departments/{id} | name 또는 groupBillingEnabled | 204 |
| DELETE /api/departments/{id} | 부서 번호 | 204 |

부서는 기업에 속하며 기업 내 이름이 고유하다. 이름은 앞뒤 공백 제거 후 1~100자다. 그룹결제 설정은 boolean만 허용하며 생성 시 생략하면 false, PATCH에서 생략하면 유지한다. 삭제하면 소속 사원의 기업·부서 소속을 해제하고 해당 부서 PIN만 삭제한다. 개인 고객·다른 부서·기업 공용 PIN·업무 이력은 보존하며 [삭제 API와 기록 보존](company-deletion.md)을 따른다.

기업 구성원 생성에는 departmentSeq가 필수이며 같은 기업의 부서여야 한다. 기존 구성원 PATCH에서 departmentSeq를 보내 같은 기업 안에서 부서를 이동할 수 있다. 고객당 소속은 하나이고 모든 기업 구성원은 부서 하나에 속한다. 부서의 기업을 바꾸거나 다른 기업의 부서에 연결할 수 없다.

구성원 CSV 헤더는 `employeeNo,name,phoneNumber,departmentSeq`다. 각 행의 부서 번호는 양의 PostgreSQL 정수이며 대상 기업에 속해야 한다. 기존 사번 재업로드는 고객 정보와 부서 배정을 갱신한다. 다른 기업 부서가 한 행이라도 있으면 전체를 저장하지 않는다. 기존 크기·행 수·중복·개인정보 오류 응답 정책은 유지한다.

## 월결제 설정

- 개인: 고객 생성·PATCH의 monthlyBillingEnabled. 관리자가 설정하며 AI는 true로 등록하거나 변경할 수 없다. 주문 본문의 customer에는 이 필드를 받지 않는다.
- 기업: 기업 생성·PATCH의 monthlyBillingEnabled. 기업 전체에 적용한다.
- 그룹: 부서 생성·PATCH의 groupBillingEnabled. 해당 부서에만 적용한다.
- 신규 설정은 미입력·false이면 false, 명시적인 true만 true다. 문자열, 숫자, null은 boolean으로 변환하지 않는다. PATCH에서 생략한 설정은 유지한다.

고객 확인 `POST /api/customers/context`는 department와 availablePaymentMethods를 추가로 반환한다. billing은 개인 카드, credit은 월결제, groupBilling은 부서 그룹결제다. 개인 고객은 자기 월결제 설정, 기업 구성원은 활성 소속·활성 기업의 월결제 설정 및 소속 부서의 그룹결제 설정을 사용한다. 기업 소속이 있으면 개인 월결제 설정으로 기업 자격을 우회할 수 없다. 최종 주문 확정에서도 자격을 다시 확인한다.

## 017 이관 전 실제 부서 배정

구성원이 없는 DB는 별도 배정 없이 적용한다. 구성원이 있으면 실제 기업·고객·팀 목록을 받은 후 아래 구조의 staging table에 CSV 등으로 적재해야 한다. 임의 기본 부서는 만들지 않는다.

```sql
CREATE TABLE migration_department_assignments (
  customer_seq integer PRIMARY KEY,
  organization_seq integer NOT NULL,
  department_name text NOT NULL
);
```

각 기존 구성원에 정확히 한 행을 제공한다. 이름은 실제 팀 이름이며 같은 기업·팀 이름은 같은 부서로 생성한다. 기존 소속과 다른 기업, 중복 고객, 누락된 구성원, 잘못된 팀 이름은 이관을 중단한다. 새 부서의 그룹결제와 기존 고객·기업의 월결제는 false로 시작한다. migration 전체가 성공하면 staging table을 제거한다. 실패하면 업무 데이터와 스키마는 롤백되고 입력한 배정표는 보존된다.
