# 기업·사원 등록 연동 계약

모든 요청은 ACTIVE 관리자 세션이 필요하며 쓰기 요청은 허용 Origin을 검사한다. `ORG_ADMIN`은 기업 대표자 표시이며 관리자 웹 계정이나 권한을 만들지 않는다. 이번 변경에는 DB migration이 없다.

## 기존 기업에 사원 등록

`POST /api/companies/{organizationSeq}/members`는 기존처럼 단건 객체 또는 `{ "items": [...] }`를 받으며, 성공은 **204 · 본문 없음**이다.

```json
{
  "items": [
    { "employeeNo": "001", "name": "김대표", "phoneNumber": "01012345678", "role": "ORG_ADMIN" },
    { "employeeNo": "002", "name": "이사원", "phoneNumber": "01098765432", "departmentSeq": 5 }
  ]
}
```

- 이름·전화번호 방식의 `role`은 선택이다. 허용값은 `MEMBER`, `ORG_ADMIN`이다. `null`이나 관리자 역할명은 400이다.
- 신규 사원에서 role 생략은 `MEMBER`다. 같은 기업·사번의 기존 사원 갱신에서는 생략한 role을 유지하고, 명시한 role만 변경한다.
- 기존 사원의 고객 번호·소속 번호·사번·ACTIVE/INACTIVE 상태는 유지한다. 부서는 생략 시 유지, null이면 해제한다.
- 기존 고객 번호 방식 `{ "employeeNo": "003", "customerSeq": 123, "role": "MEMBER" }`의 role 필수 규칙은 유지한다. 한 items 배열에 두 형식을 섞을 수 있다.
- 오류 필드는 `items[0].role`, `items[3].phoneNumber`처럼 0부터 시작한다. 기존 목록·PATCH·DELETE 계약은 유지한다.

## 새 기업과 부서·사원 함께 등록

기존 `POST /api/companies`를 확장한다. 기존 `{ "name": "기업명" }` 요청도 유효하다.

```json
{
  "name": "디버",
  "monthlyBillingEnabled": true,
  "departments": [
    { "name": "개발팀", "groupBillingEnabled": false },
    { "name": "지원팀" }
  ],
  "members": [
    { "employeeNo": "001", "name": "김대표", "phoneNumber": "01012345678", "role": "ORG_ADMIN", "departmentName": "개발팀" },
    { "employeeNo": "002", "name": "이사원", "phoneNumber": "01098765432", "departmentName": "지원팀" },
    { "employeeNo": "003", "name": "박사원", "phoneNumber": "01011112222" }
  ]
}
```

| 필드 | 필수 | 의미 |
| --- | --- | --- |
| name | 필수 | 기업명. 앞뒤 공백 제거, 빈 값 불가. 같은 기업명은 허용 |
| monthlyBillingEnabled | 선택 | 기업 월결제 자격. 생략은 false |
| departments | 선택 | 함께 만들 부서 배열. 생략·빈 배열은 부서 없음 |
| departments[].name | 필수 | 부서명. 공백 제거 후 기업 내 고유, 최대 100자 |
| departments[].groupBillingEnabled | 선택 | 부서 그룹결제 자격. 생략은 false |
| members | 선택 | 함께 등록할 사원 배열. 생략·빈 배열은 사원 없음 |
| members[].employeeNo | 필수 | 기업 내 고유 사번. 문자열로 보내 선행 0·대소문자 보존 |
| members[].name | 필수 | 사원 이름. 앞뒤 공백 제거, 빈 값 불가 |
| members[].phoneNumber | 필수 | 숫자 문자열. 선행 0 보존 |
| members[].role | 선택 | MEMBER 또는 ORG_ADMIN. 생략은 MEMBER |
| members[].departmentName | 선택 | 같은 요청에 선언한 부서명. 공백 제거 후 대소문자 구분. 생략·null은 부서 없음 |

새 기업에 연결할 부서 번호가 아직 없으므로 이 요청의 members에는 `departmentSeq` 대신 `departmentName`을 보낸다. `customerSeq`는 받지 않으며 기존 미소속 고객은 전화번호로 연결한다. 다른 기업 소속·탈퇴 고객을 자동 이동하거나 되살리지 않는다.

JSON 최대 **1MiB**, departments·members 각각 최대 **1,000건**이다. 누적 직원 수 제한이 아니다. 배열 안 중복 부서명·사번·전화번호는 400이다. 숫자·boolean 문자열의 자동 형변환이나 알 수 없는 필드 허용은 하지 않는다.

성공 응답은 기존처럼 **201**이다. 이때 기업·부서·고객 변경·사원·성공 감사 기록이 모두 커밋되어 있다.

```json
{
  "data": { "organizationSeq": 123 },
  "meta": { "requestId": "2a486db4-61db-47d5-8d3a-63097f3324a3" }
}
```

같은 기업의 부서 목록·사원 목록·기업 상세를 기존 GET으로 조회할 수 있다. 별도 사원 등록이나 대표자 PATCH를 이어서 보낼 필요가 없다.

## 실패와 트랜잭션 범위

**트랜잭션 단위는 기업 생성 요청 한 건**이다. 그 요청의 부서·사원 중 하나라도 실패하면 기업과 나머지 부서·사원, 새 고객, 기존 고객 변경, 성공 감사까지 전부 롤백한다. 실패 시도 감사는 별도로 남을 수 있다. 사원 등록 내부에서 다른 연결로 별도 커밋하지 않는다. 입력 형식·중복·부서명 연결 검증은 트랜잭션 전에 처리하며, 트랜잭션 안에서 외부 API를 호출하지 않는다.

| HTTP / error.code | details[].reason | 예시 field |
| --- | --- | --- |
| 400 / INVALID_REQUEST | isIn 등 입력 검증 사유 | members[0].role |
| 400 / INVALID_REQUEST | DUPLICATE_ITEM | members[1].employeeNo 또는 departments[1].name |
| 422 / VALIDATION_FAILED | DEPARTMENT_NOT_FOUND | members[0].departmentName |
| 422 / VALIDATION_FAILED | CUSTOMER_WITHDRAWN | members[0].phoneNumber |
| 422 / VALIDATION_FAILED | OTHER_COMPANY_MEMBERSHIP | members[1].phoneNumber |
| 409 / REQUEST_IN_PROGRESS | details가 빈 배열 | 다른 소속 변경의 잠금 대기 2초 초과 |
| 413 / PAYLOAD_TOO_LARGE | details가 빈 배열 | 본문 1MiB 초과 |

기존 기업에 사원만 등록할 때의 EMPLOYEE_NO_CONFLICT·PHONE_NUMBER_CONFLICT 등은 유지한다. 오류는 `{ "error": { "code": "...", "message": "...", "details": [...] }, "meta": { "requestId": "..." } }`이며 개인정보를 입력값 그대로 돌려주지 않는다.

프론트는 CSV를 읽은 뒤 **기업과 그 기업의 부서·사원을 한 JSON 요청에 포함**해야 한다. 기존처럼 기업 생성·사원 등록을 두 HTTP 요청으로 나누면 두 요청 전체가 하나의 트랜잭션이 되지는 않는다. 파일에 여러 기업이 있다면 기업마다 이 요청을 호출하며, 파일 전체의 일괄 성공·실패를 보장하는 API는 아니다.

이 API는 Idempotency-Key를 사용하지 않고 동일 기업명도 허용한다. 커밋 후 응답 유실 여부를 모르는 상황에서 자동 재전송하지 않는다. 실제 서버 DB 적용·배포·프론트 코드 변경은 이 명세 작성 범위에 포함하지 않는다.
