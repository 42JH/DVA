# 개인 및 기업 PIN 주소록 관리 API

Jira: [S15P31D109-39](https://ssafy.atlassian.net/browse/S15P31D109-39).
모놀리식 `backend/src/pins/`에서 개인 주소록과 기업 공유 주소록을 관리한다.
별도 서비스나 외부 주소 API를 호출하지 않는다.
2026-10-27 합의에 따라 기업 공유 PIN은 기업의 공식 공개 배송지이며, 타 기업 검색은 [40번 디렉터리 API](company-directory.md)를 사용한다.
아래 소속 기업 조회 경로와 관리자 전용 등록·수정 권한은 유지한다.

## HTTP 계약

표의 모든 경로는 `/api`로 시작한다. 단건 성공은 `data/meta`, 목록은 `data/hasNext`,
오류는 `error/meta` 형식이며 `Cache-Control: no-store`를 적용한다.

| 메서드·경로 | 권한 | 성공 응답의 data |
| --- | --- | --- |
| GET /api/customers/{id}/pins | 관리자 또는 현재 통화 고객 | PersonalPin[], 최상위 hasNext |
| POST /api/customers/{id}/pins | 관리자 또는 현재 통화 고객 | 201, `{ personalPinSeq, version }` |
| PATCH /api/pins/{id} | 관리자 또는 현재 통화 고객 | 200, `{ version }` |
| GET /api/companies/{id}/pins | 관리자 또는 활성 소속 기업의 통화 고객 | CompanyPin[], 최상위 hasNext |
| POST /api/companies/{id}/pins | 관리자만 | 201, `{ companyPinSeq, version }` |
| PATCH /api/company-pins/{id} | 관리자만 | 200, `{ version }` |

PersonalPin은 `{ personalPinSeq, customerSeq, label, addressData, version }`이다.
CompanyPin은 `{ companyPinSeq, organizationSeq, label, departmentName, addressData, version }`이다.
label과 departmentName은 null일 수 있다. 소유 고객·기업은 변경할 수 없다. 삭제 API는 제공하지 않는다.

### 목록과 검색

`q`는 별칭·수령인·전화번호·도로명·지번·상세주소의 부분 검색이며, 기업은 부서명도 포함한다.
앞뒤 공백과 Unicode NFC를 정리하고 대소문자를 구분하지 않는다. `%`·`_`는 일반 문자다.
검색어가 없거나 공백이면 해당 주소록 전체를 페이지 조회한다. 결과는 PIN 번호 오름차순이다.
limit 기본 20·범위 1~100, offset 기본 0이며 필터와 페이지 처리는 소유 범위 안에서 수행한다.
검색 결과가 없으면 `{ "data": [], "hasNext": false }`를 반환한다.
검색용 생성 컬럼 search_text는 반환하지 않는다.

통화 시작 시 전체 주소록이 필요하면 [33번 초기 조회](caller-context.md)를 사용한다.
이 API는 대화 중 검색이나 관리자 화면의 페이지 조회에 사용한다.
특정 주문 시점의 주소를 찾는 기능은 PIN 저장 여부와 무관한 [42번 이전 주문 주소 조회](order-address-history.md)를 사용한다.

## 인증과 범위

모든 ACTIVE 관리자 역할(OPERATOR·SUPERVISOR·SYSTEM_ADMIN)에 관리 기능을 허용한다.
관리자는 기존 `dva_session` 쿠키를 보내며 POST·PATCH에는 허용 Origin이 필요하다.

MVP 합의에 따라 AI 서비스 토큰은 요구하지 않는다. AI가 호출할 수 있는 네 메서드에만
`MvpAiPinAccess`를 적용한다. 관리자 쿠키가 있으면 실제 세션을 검증하며 만료되거나 잘못된
쿠키를 AI 호출로 전환하지 않는다. 허용되지 않은 브라우저 Origin은 공통 CORS에서 거절한다.
서비스 인증은 [S15P31D109-135](https://ssafy.atlassian.net/browse/S15P31D109-135)의 후속 범위다.

AI는 `call_session_seq` 헤더에 기존 DB 통화 번호를 전달한다. 양의 PostgreSQL integer 범위만
허용한다. 진행 중 통화의 발신번호와 주소록 소유 고객의 전화번호가 같고 고객이 ACTIVE여야 한다.
번호는 상담 시작 시 `POST /api/customers/context`에 phoneNumber와 call(providerCallId·incomingAt)을 보내 응답의 callSessionSeq에서 받는다. 신규 주문 생성이 선행될 필요는 없다.
다른 고객의 개인 주소록은 같은 기업 구성원이라도 접근할 수 없다.
통화 번호 자체는 인증 토큰이 아니며 이 API는 통화를 새로 만들거나 전화번호 본인인증을 수행하지 않는다.

AI의 기업 공유 주소록 조회는 고객·소속·기업이 모두 ACTIVE인 현재 소속 기업으로 제한한다.
ORG_ADMIN은 대표자 표시로, 기업 공유 주소록 쓰기 권한이나 관리자 계정을 뜻하지 않는다.
AI는 대표자 통화에서도 기업 공유 주소록을 등록·수정할 수 없다.
개인/기업 저장 범위는 결제 수단 선택과 관계없다.

탈퇴 고객의 개인 주소록은 관리자도 이 API에서 사용할 수 없다.
관리자는 비활성 기업의 공유 주소록을 조회할 수 있으나 등록·수정할 수 없다.
AI는 종료된 통화에서 개인/기업 주소록을 사용할 수 없다.
권한 검사와 조회는 같은 읽기 스냅샷에서 수행하고, 쓰기는 통화·소유자 상태를 잠근 뒤 처리한다.

## 등록

```http
POST /api/customers/12/pins
Content-Type: application/json
call_session_seq: 31

{
  "label": "집",
  "addressData": {
    "name": "김철수",
    "phoneNumber": "01012345678",
    "roadAddress": "서울 예시로 12",
    "jibunAddress": "서울 예시동 12",
    "detailAddress": "101호",
    "dongName": "예시동",
    "postalCode": "01234",
    "latitude": 37.5,
    "longitude": 127
  }
}
```

개인 등록 본문은 `{ label?, addressData }`, 기업은 `{ label?, departmentName?, addressData }`다.
label·departmentName은 생략하거나 null로 보낼 수 있다.
주소는 고객 확인이 끝난 완성 주소 전체를 받는다. 수집 중인 정보는 주문에 보관한다.
도로명·지번·동명·수령인 이름은 앞뒤 공백과 NFC를 정리하고 빈 문자열을 거절한다.
전화번호는 숫자 문자열, 우편번호는 숫자 5자리 문자열이며 선행 0을 보존한다.
위도·경도는 실제 숫자이며 각각 -90~90, -180~180 범위다.
detailAddress는 생략 또는 빈 문자열을 허용하고 null은 거절한다. 없는 필수 주소값을 자동 생성하지 않는다.
알 수 없는 필드·소유자 지정·version 지정·결제 필드·숫자 타입 전화번호 등은 400이다.

### 중복 등록

Idempotency-Key를 요구하거나 저장하지 않는다. 보내더라도 처리에 사용하지 않는다.
별도 요청 기록 테이블 없이 기존 DB 고유 제약으로 동시 등록까지 막고 중복이면
409 DUPLICATE_RESOURCE를 반환한다. 기존 PIN·별칭을 덮어쓰거나 기존 응답을 재생하지 않는다.

개인 PIN은 고객별, 기업 PIN은 기업·정규화 부서명별로 `pin_identity(address_data)`를 비교한다.
비교 필드는 수령인 이름·전화번호·도로명·지번·상세주소·동명·우편번호이며 NFC·대소문자·앞뒤 공백·
연속 공백 정규화는 기존 DB 함수를 따른다. 별칭·좌표는 중복 판정에 포함하지 않는다.
상세주소 생략과 빈 문자열, 기업 부서명 null과 빈 문자열은 각각 같은 값으로 판정한다.
같은 주소라도 소유 고객·기업이 다르거나 기업 내 부서가 다르면 별도로 등록할 수 있다.

## 수정

```http
PATCH /api/pins/21
Content-Type: application/json
call_session_seq: 31

{"label":"자택"}
```

개인 수정 본문은 `{ label?, addressData? }`, 기업은 `{ label?, departmentName?, addressData? }`다.
수정할 필드는 하나 이상 필요하다. 생략한 필드는 유지하고 label·departmentName의 null은 값을 지운다.
addressData를 보내면 검증된 완성 주소 전체로 교체한다. 상세주소 한 필드만 담은 부분 객체는 400이다.
소유 고객·기업을 옮기는 수정은 허용하지 않는다.

2026-10-27 합의에 따라 **조회 버전이 오래됐어도 수정 요청을 반영한다.**
expectedVersion은 필요하지 않다. 이전 명세와의 호환을 위해 양의 integer 선택값으로 받아도
비교 조건에 사용하지 않으며 VERSION_CONFLICT로 거절하거나 최신 주소록 재조회를 요구하지 않는다.
expectedVersion만 있고 수정할 필드가 없는 요청은 400이다.

같은 필드의 수정은 DB에 나중에 반영된 값이 최종값이다. 동시에 다른 필드를 수정할 때는
각 UPDATE가 지정한 필드만 갱신하므로 생략한 항목을 과거 조회값으로 덮어쓰지 않는다.
단, addressData는 하나의 교체 단위다. 다른 상세주소 수정끼리는 나중에 반영된 전체 주소가 남는다.

기존 DB 트리거가 실제 변경 시 version을 증가시킨다. 동일한 값을 다시 저장하면 버전은 유지된다.
응답은 DB가 반환한 실제 version이며 요청자가 이미 아는 PIN 번호를 반복해서 반환하지 않는다.
주소 변경으로 중복 제약에 걸리면 409 DUPLICATE_RESOURCE로 전체 요청을 롤백한다.
주소록 변경은 기존 주문·주문 상세에 저장된 주소 스냅샷이나 주문 버전을 변경하지 않는다.

AI는 등록 응답의 PIN 번호와 version, 수정 응답의 version으로 통화 중 복사본을 갱신한다.
저장 시 문자열 앞뒤 공백·NFC를 정리하므로 호출자도 이 규칙에 맞춘 주소와 변경 필드를 보관한다.
다음 통화에서는 33번 초기 조회로 다시 적재한다.

## 오류·감사 기록·검증

| 상태·코드 | 조건 |
| --- | --- |
| 400 INVALID_REQUEST | 본문·ID·페이지 형식 오류, 불완전 주소, AI 통화 헤더 누락·오류, 수정할 항목 없음 |
| 401 UNAUTHORIZED | 관리자 전용 작업의 세션 부재 또는 잘못되거나 만료된 관리자 쿠키 |
| 403 FORBIDDEN | Origin 위반, 다른 통화 고객·기업 범위, AI의 비활성 고객·소속·기업 접근 |
| 404 NOT_FOUND | 통화·고객·기업·PIN이 없음, 미제공 삭제 경로 |
| 409 INVALID_STATE | 종료된 통화, 관리자의 탈퇴 고객 주소록 접근, 비활성 기업의 주소록 변경 |
| 409 DUPLICATE_RESOURCE | 기존 주소 고유 제약 충돌 |

개인 쓰기는 PERSONAL_PIN_CREATED·PERSONAL_PIN_UPDATED, 기업 쓰기는
COMPANY_PIN_CREATED·COMPANY_PIN_UPDATED 감사 기록을 업무 변경과 같은 트랜잭션에 저장한다.
AI는 SYSTEM, 관리자는 ADMIN으로 기록하며 주소·전화번호·본문은 감사 metadata에 담지 않는다.
실패·거부 기록도 기존 감사 흐름을 따른다. 감사 성공 기록 저장에 실패하면 업무 변경도 롤백한다.

기존 테이블·고유 인덱스·검색 생성 컬럼·버전 트리거를 사용하며 DB 마이그레이션은 추가하지 않는다.

```powershell
cd backend
npm.cmd run check:docker
```

격리 PostgreSQL의 실제 HTTP 검증은 AI/관리자 권한, 상태·통화 범위, 정규화 중복·동시 등록,
오래된 버전 허용, 동시 부분 수정, 검색·페이지, 입력 오류, 주문 스냅샷 보존 및 감사 실패 롤백을 검사한다.
운영 이미지·Nginx를 통한 등록·수정·관리자 경계·통화 헤더 전달도 검사한다.
실제 운영 서버 배포 또는 AI 팀의 클라이언트 반영·통화 연동 완료를 의미하지 않는다.
