# 고객 전화번호 부분 검색

`GET /api/customers`의 기존 `phoneNumber` 필터를 숫자 1~11자리의 포함 검색으로 변경한다. `phoneNumber=1234`는 앞·중간·끝 어디에든 1234가 포함된 고객을 반환한다. 전체 번호를 보내는 기존 호출도 유지한다.

`q`는 기존 이름 검색이며 phoneNumber·status와 AND로 결합된다. 고객 번호 내림차순, limit·offset·hasNext·total_count, soft delete 제외, 관리자 세션은 유지한다. 같은 검색창에서 전화번호를 찾으려면 프론트가 숫자를 phoneNumber에 전달한다.

하이픈·공백·국가번호·빈 값·반복 파라미터·12자리 이상·숫자 이외 문자는 400이다. 조회 필터만 변경하며 고객 등록·AI 고객 확인·주문·주소록 연락처의 기존 11자리 검증은 유지한다. 새 migration·환경변수는 없다.
