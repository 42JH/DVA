# 기업 공유 배송지 검색 — DIR-01

기업 공유 배송지는 활성 기업에 소속된 사원의 현재 고객 주소다. 고객 주소를 기업 PIN에 복사하지 않는다. 개인 PIN은 별도의 추가 배송지 주소록으로 유지한다.

## 요청

```http
GET /api/companies/search?q=예시기업%20김사원&limit=20&offset=0
```

- q: 필수 문자열. 앞뒤 공백·NFC를 정리하며 공백으로 나눈 모든 검색어가 일치해야 한다. 단어 순서는 무관하다. 공백만 있으면 400이다.
- 기업명·부서명·현재 사원 이름·전화번호·도로명·지번·상세주소·동명·우편번호를 검색한다. 대소문자를 구분하지 않으며 `%`·`_`는 일반 문자다.
- limit: 기본 20, 1~100. offset: 기본 0, 0 이상 정수.
- 반복 q, status·customerSeq·organizationSeq 등 지원하지 않는 필드는 400이다.
- 실제 클라이언트는 URLSearchParams 등으로 검색어를 인코딩한다.

## 응답

HTTP 200. 최상위는 `{ data, hasNext, total_count }`이며 meta·page 객체는 추가하지 않는다.

```json
{
  "data": [
    {
      "organizationSeq": 3,
      "organizationName": "예시기업",
      "membershipSeq": 7,
      "customerSeq": 12,
      "departmentSeq": null,
      "departmentName": null,
      "addressData": {
        "name": "김사원",
        "phoneNumber": "01012345678",
        "roadAddress": "서울특별시 중구 세종대로 110",
        "jibunAddress": "서울특별시 중구 태평로1가 31",
        "detailAddress": "101호",
        "dongName": "태평로1가",
        "postalCode": "04524",
        "latitude": 37.5663,
        "longitude": 126.9779
      }
    }
  ],
  "hasNext": false,
  "total_count": 1
}
```

한 항목은 주소가 있는 사원 한 명이다. 기업·소속·고객이 모두 ACTIVE이고 `customers.address_data`가 null이 아닌 항목만 반환한다. 부서가 없는 사원도 포함하며 departmentSeq·departmentName은 null이다. detailAddress는 저장된 기본 주소와 같이 생략될 수 있다.

이름·전화번호는 `customers.name`·`phone_number`, 주소는 `customers.address_data`에서 매번 읽는다. 별도 PIN 등록·동기화·캐시는 없다. 고객 정보 수정·주소 삭제·소속 해제·비활성화는 다음 조회에 반영된다. 같은 기업의 여러 사원과 동명 기업을 임의로 합치지 않는다.

정렬은 소문자·NFC 기업명, 기업 번호, 고객 번호 오름차순이다. total_count는 같은 검색·상태 조건의 페이지 적용 전 전체 사원 수이며 페이지 밖에서도 유지한다. 결과가 없으면 `{ "data": [], "hasNext": false, "total_count": 0 }`다.

## 공유 범위와 인증

활성 기업 사원의 기본 이름·연락처·주소를 기업 간 공유 배송지로 사용한다는 요구사항을 따른다. 개인 PIN·사번·역할·결제 설정은 검색하거나 반환하지 않는다. 이전 company_pins의 데이터도 검색하지 않는다.

기존 MVP 인증 계약은 유지한다. 이 GET 메서드만 관리자 쿠키·서비스 토큰·call_session_seq 없이 조회할 수 있다. 발신자의 소속 기업에 한정하지 않는다. 관리자 쿠키가 있으면 ACTIVE 세션을 검증하며 잘못된 쿠키를 익명 호출로 전환하지 않는다. 허용되지 않은 Origin은 공통 CORS에서 거절한다. 기업 관리·전체 구성원 목록·개인 PIN 접근 권한은 유지한다.

성공·오류에 Cache-Control: no-store를 적용한다. 요청 로그에 검색어·주소·연락처·응답 본문을 남기지 않는다. DB 장애를 빈 성공으로 바꾸지 않는다. 별도 테이블·마이그레이션·검색 인덱스·외부 API는 추가하지 않는다.

## 이전 계약에서 변경된 필드

companyPinSeq·label·version을 제거하고 customerSeq·membershipSeq를 반환한다. 고객 번호를 PIN 번호로 간주하지 않는다. 선택한 addressData를 주문 출발지·도착지의 주소 사본으로 전달하며 기업 배송지 선택에 originPin을 새로 지정하지 않는다. 개인 PIN의 PERSONAL 참조와 기존 주문에 남은 COMPANY 참조는 기존 주문 계약을 유지한다.

기업 PIN의 등록·수정·목록 API는 폐기한다. 과거 주문의 논리 참조·기존 기업 삭제 처리 보존을 위해 테이블은 남기며 데이터 삭제나 migration은 수행하지 않는다. AI 변경·배포 순서는 [AI 인계](../../backend/docs/company-address-directory-handoff.md)를 따른다.
