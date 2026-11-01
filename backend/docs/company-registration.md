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

### 사원과 고객 주소를 함께 저장

직원은 별도 고객 종류가 아니라 고객에 기업 소속을 연결한 것이다. 이름·전화번호 방식의 사원 등록에서 `address`를 함께 받는다. **신규 기업은 `POST /api/companies`의 `members[].address`, 기존 기업은 `POST /api/companies/{organizationSeq}/members`의 `items[].address`**를 사용한다. 기존 기업의 단건 객체에도 같은 필드가 들어간다. 신규 고객이면 주소와 함께 생성하고, 기존 고객이면 같은 고객 번호를 유지하며 이름·주소를 반영한 뒤 소속을 연결하거나 갱신한다. 고객을 별도로 등록하거나 사원별 주소 PATCH를 이어서 호출하지 않는다.

```json
{
  "items": [
    {
      "employeeNo": "001",
      "name": "김사원",
      "phoneNumber": "01012345678",
      "role": "MEMBER",
      "address": {
        "roadAddress": "서울특별시 중구 세종대로 110",
        "jibunAddress": "서울특별시 중구 태평로1가 31",
        "detailAddress": "101호",
        "dongName": "태평로1가",
        "postalCode": "04524"
      }
    }
  ]
}
```

새 기업은 위 `items` 배열을 `members`라는 키로 바꾸고 기업 `name`과 함께 보낸다. 부서가 있으면 신규 기업은 `departmentName`, 기존 기업은 `departmentSeq`를 사용한다. 두 API의 주소 형식과 저장 규칙은 동일하다.

| address 필드 | 주소 객체 안에서 필수 | 형식 |
| --- | --- | --- |
| roadAddress | 필수 | 공백만 있는 값 불가 |
| jibunAddress | 필수 | 공백만 있는 값 불가 |
| dongName | 필수 | 공백만 있는 값 불가 |
| postalCode | 필수 | 5자리 숫자 문자열. 선행 0 유지 |
| latitude | 선택 | 숫자, -90 이상 90 이하. 미전달·null이면 1 |
| longitude | 선택 | 숫자, -180 이상 180 이하. 미전달·null이면 1 |
| detailAddress | 선택 | 문자열. 생략·빈 문자열 허용, null 불가 |

주소의 문자열 검증은 기존 `CustomerAddressDto`를 재사용하고, 사원 등록용 `MemberAddressDto`에서 좌표 기본값을 적용한다. 두 사원 등록 API 모두 위도·경도를 각각 미전달·null이면 **1**로 채우고, 전달한 숫자는 **0을 포함해 그대로 유지**한다. 한 좌표만 없으면 없는 좌표만 1이 된다. 위도·경도 숫자 문자열, 필수 문자열이 빠진 객체, 알 수 없는 필드는 400이다. 주소 객체의 문자열은 NFC 정규화·앞뒤 공백 제거를 적용한다. API는 주소·좌표가 실제 위치와 일치하는지 외부 조회하지 않는다. 기존 고객 등록·수정 API 자체의 좌표 필수 규칙은 바꾸지 않는다.

- `address` 생략: 기존 고객의 주소 유지. 신규 고객은 주소 미설정(null). 기존 호출의 호환성을 유지한다.
- `address: { ... }`: 고객 내 주소 전체 교체. 기존 고객·직원의 이름·전화번호가 같아도 주소만 수정된다. 좌표를 보내지 않으면 기존 좌표를 유지하지 않고 1로 교체한다.
- `address: null`: 고객 내 주소 삭제. **CSV 주소 빈칸을 자동으로 null로 바꾸지 않는다.** 주소를 유지하려면 필드를 생략한다.
- 고객 번호만 지정하는 기존 `{ customerSeq, employeeNo, role }` 방식은 고객 정보를 수정하지 않고 소속만 연결한다. 주소를 함께 수정하려면 이름·전화번호 방식을 사용한다.
- 주소는 `customers.address_data`에 저장한다. 고객 상세·기업 사원 목록·AI 고객 확인 응답의 `customer.address`에서 같은 주소를 읽는다. PIN과 과거 주문 주소는 변경하지 않는다.
- 고객 주소·사원 소속·성공 감사는 같은 트랜잭션에서 저장하거나 전부 롤백한다. 기존의 탈퇴 고객·다른 기업 소속 충돌 차단과 1MiB·1,000건 제한은 유지한다.

프론트는 CSV의 주소를 자동 조회해 도로명·지번·동·우편번호를 채우고, 확인된 주소 객체를 사원 항목에 넣어 한 번에 보낸다. 위도·경도를 알면 숫자로 함께 보내고, 없으면 생략해 백엔드의 1 기본값을 사용한다. 프론트에서 임의의 고정 좌표를 채워 보낼 필요는 없다. 필수 주소 정보를 조회하지 못한 행은 행 번호와 함께 안내하고 등록 요청을 보내지 않는다. CSV 원본은 프론트가 처리하며 백엔드는 CSV 업로드 API나 주소 조회 API를 추가하지 않는다. 프론트의 CSV 파싱·주소 조회·요청 매핑 변경은 별도로 반영해야 한다. 기본값 1은 실제 위치가 아니므로 위치 기반 기능에 쓰기 전에 실제 좌표를 보완해야 한다.

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
| members[].address | 선택 | 고객 내 주소. 객체 전달 시 도로명·지번·동·우편번호 필수, 상세주소 선택. 위도·경도 미전달·null은 각각 1. 위 주소 계약 참조 |
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
| 400 / INVALID_REQUEST | isNumber, min, max 등 주소 검증 사유 | members[0].address.latitude 또는 items[0].address.latitude |
| 400 / INVALID_REQUEST | DUPLICATE_ITEM | members[1].employeeNo 또는 departments[1].name |
| 422 / VALIDATION_FAILED | DEPARTMENT_NOT_FOUND | members[0].departmentName |
| 422 / VALIDATION_FAILED | CUSTOMER_WITHDRAWN | members[0].phoneNumber |
| 422 / VALIDATION_FAILED | OTHER_COMPANY_MEMBERSHIP | members[1].phoneNumber |
| 409 / REQUEST_IN_PROGRESS | details가 빈 배열 | 다른 소속 변경의 잠금 대기 2초 초과 |
| 413 / PAYLOAD_TOO_LARGE | details가 빈 배열 | 본문 1MiB 초과 |

기존 기업에 사원만 등록할 때의 EMPLOYEE_NO_CONFLICT·PHONE_NUMBER_CONFLICT 등은 유지한다. 오류는 `{ "error": { "code": "...", "message": "...", "details": [...] }, "meta": { "requestId": "..." } }`이며 개인정보를 입력값 그대로 돌려주지 않는다.

프론트는 CSV를 읽은 뒤 **기업과 그 기업의 부서·사원을 한 JSON 요청에 포함**해야 한다. 기존처럼 기업 생성·사원 등록을 두 HTTP 요청으로 나누면 두 요청 전체가 하나의 트랜잭션이 되지는 않는다. 파일에 여러 기업이 있다면 기업마다 이 요청을 호출하며, 파일 전체의 일괄 성공·실패를 보장하는 API는 아니다.

이 API는 Idempotency-Key를 사용하지 않고 동일 기업명도 허용한다. 커밋 후 응답 유실 여부를 모르는 상황에서 자동 재전송하지 않는다. 실제 서버 DB 적용·배포·프론트 코드 변경은 이 명세 작성 범위에 포함하지 않는다.
