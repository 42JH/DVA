# 관리자 사원 검색

`GET /api/companies/members/search`는 관리자 상단바의 사원 이름·전화번호·사번·부서 검색용이다. 기업명 검색은 기존 `GET /api/companies`를 사용한다. AI 배송지 검색 DIR-01과 응답·인증이 다르다.

## 요청

```http
GET /api/companies/members/search?q=김사원&includeInactive=false&limit=50&offset=0
Cookie: dva_session=<관리자 세션>
```

- 유효한 ACTIVE 관리자 세션 필수. OPERATOR·SUPERVISOR·SYSTEM_ADMIN 모두 허용한다. AI Bearer만으로는 조회할 수 없다.
- `q`: 필수. NFC·앞뒤 공백·연속 공백 정리 후 공백 포함 Unicode 코드 포인트 1~100자. 초과하면 400이며 서버가 임의로 자르지 않는다.
- 이름·전화번호·사번·부서명 부분 일치. 공백으로 구분한 모든 단어가 일치해야 하며, 단어마다 서로 다른 필드에 일치해도 된다. 대소문자를 구분하지 않고 `%`·`_`는 일반 문자다. 기업명·주소는 검색하지 않는다.
- 숫자·하이픈으로 된 단어는 전화번호와 숫자로 비교한다. 사번은 문자열로 검색하므로 선행 0·하이픈을 보존한다. FE는 원문 q를 보내고 서버가 전화번호 정규화를 처리하게 한다.
- `includeInactive`: 기본 false. `true`·`false`만 허용한다. false면 기업·소속 모두 ACTIVE, true면 기업·소속의 INACTIVE도 포함한다. 삭제된 기업·소속·고객 및 탈퇴 고객은 항상 제외한다.
- `limit`: 기본 20, 1~100 정수. `offset`: 기본 0, 0~Number.MAX_SAFE_INTEGER 정수.
- 주소 없는 사원·부서 없는 사원도 포함한다. 사원 등록·수정의 주소 필수화나 주소 삭제 금지는 도입하지 않는다.
- 반복·미지원 파라미터, 잘못된 길이·타입·페이지 값은 `400 INVALID_REQUEST`다. 무인증·만료·잘못된 관리자 쿠키는 401이다.

## 응답

```json
{
  "data": [
    {
      "organizationSeq": 3,
      "organizationName": "예시기업",
      "organizationStatus": "ACTIVE",
      "membershipSeq": 7,
      "membershipStatus": "ACTIVE",
      "employeeNo": "0007",
      "departmentName": null,
      "name": "김사원",
      "phoneNumber": "01012340000"
    }
  ],
  "hasNext": false,
  "total_count": 1
}
```

한 줄은 소속 하나다. 상태는 ACTIVE/INACTIVE이며 부서가 없으면 departmentName은 null이다. 정렬은 NFC·소문자 기업명, 기업 번호, 소속 번호 오름차순이다. 전체 건수는 같은 검색·상태 조건에 페이지를 적용하기 전의 소속 수다. 범위 밖 offset에서도 전체 건수를 유지한다. 결과 없음은 `{ "data": [], "hasNext": false, "total_count": 0 }`이다.

성공·오류에 no-store를 적용하고 검색어·연락처·주소·세션을 로그에 남기지 않는다. DB 장애는 빈 성공으로 바꾸지 않는다.

## FE 전환

URL을 이 API로 바꾸고 관리자 쿠키 전송을 유지한다. `addressData.name`·`addressData.phoneNumber` 대신 최상위 `name`·`phoneNumber`를 사용한다. 기존 사원 여부 후처리 필터를 제거하고 상태 필드로 비활성 표시를 연결한다. `organizationSeq`를 이용한 기업 상세 이동은 유지한다.

`/api/companies/search`도 관리자 세션 또는 기존 AI 업무 Bearer로 조회할 수 있다. 기업·사원의 현재 공유 배송지 주소를 검색할 때는 해당 API를, 사번·주소 없는 사원까지 찾을 때는 이 사원 검색 API를 사용한다. 서비스 토큰을 브라우저에 넣지 않는다. [기업 배송지 관리자 조회 명세](../../backend/docs/company-directory-admin-access.md)를 따른다.
