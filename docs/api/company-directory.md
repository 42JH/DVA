# 기업 공식 배송지 검색 — DIR-01

관련 Jira: [S15P31D109-40](https://ssafy.atlassian.net/browse/S15P31D109-40).
AI 연동 작업: [S15P31D109-41](https://ssafy.atlassian.net/browse/S15P31D109-41).

## 2026-10-27 확정 정책

기업 공유 PIN 전체는 해당 기업의 본사·부서·물류센터 등 **다른 기업에서도 검색할 수 있는 공식 배송지**다.
company_pins에 별도 비공개 PIN을 저장하거나 공개 여부를 구분하지 않는다.
기업 자체에 주소 하나나 대표번호를 새로 추가하지 않고 기존 기업·공유 PIN 관계를 사용한다.
ACTIVE 기업에 연결된 PIN만 검색하며 기업당 여러 PIN, 같은 이름의 여러 기업을 모두 지원한다.

이 합의가 기존 초안의 ‘내부 공유 PIN은 외부에 제공하지 않음’이라는 해석보다 우선한다.
개인 PIN·구성원 명단·사번·고객 계정 연락처는 검색하지 않으며, 공유 PIN에 공식 배송 연락처로 등록된
수령인 이름·전화번호는 제공한다. 공개 가능한 공식 배송지만 기업 공유 PIN에 등록해야 한다.

## 요청

```http
GET /api/companies/search?q=%EC%98%88%EC%8B%9C%EA%B8%B0%EC%97%85%20%EB%AC%BC%EB%A5%98%EC%84%BC%ED%84%B0&limit=20&offset=0
```

q는 위 예시에서 ‘예시기업 물류센터’이며 URLSearchParams 등으로 인코딩한다.

| 쿼리 | 규칙 |
| --- | --- |
| q | 필수 문자열. 앞뒤 공백·NFC를 정리하며 공백만 있으면 400 |
| limit | 기본 20, 범위 1~100 |
| offset | 기본 0, 0 이상 정수 |

공백으로 나눈 모든 검색어가 일치해야 한다. 단어 순서는 무관하다.
기업명과 PIN의 부서명·별칭·수령인 이름·전화번호·도로명·지번·상세주소·동명·우편번호를 검색한다.
대소문자를 구분하지 않으며 `%`·`_`는 일반 문자로 처리한다.
따라서 ‘기업명 부서명’처럼 기업명과 PIN 정보를 조합해 검색할 수 있다.
구성원·개인 PIN 정보는 검색어 일치 판정에도 사용하지 않는다.
status·customerSeq·organizationSeq 등 지원하지 않는 필터나 반복 q 값은 400이다.

## 응답

HTTP 200, `{ data: CompanyDirectoryEntry[], hasNext, total_count }`이며 total_count를 포함하고 meta·page 객체는 추가하지 않는다.

```json
{
  "data": [
    {
      "organizationSeq": 3,
      "organizationName": "예시기업",
      "companyPinSeq": 21,
      "label": "물류센터",
      "departmentName": "운영부",
      "addressData": {
        "name": "공식 배송 담당자",
        "phoneNumber": "07012345678",
        "roadAddress": "예시로 12",
        "jibunAddress": "예시동 12",
        "detailAddress": "101호",
        "dongName": "예시동",
        "postalCode": "01234",
        "latitude": 37.5,
        "longitude": 127
      },
      "version": 1
    }
  ],
  "hasNext": false,
  "total_count": 1
}
```

한 항목은 기업 하나가 아니라 **공유 PIN 하나**다. 같은 기업도 부서·사업장별 PIN이 여러 개면 별도 후보로 반환한다.
동명 기업은 organizationSeq로, 같은 기업의 여러 배송지는 companyPinSeq·부서명·주소로 구분한다.
정렬은 소문자·NFC 기업명, 기업 번호, PIN 번호 오름차순이며 페이지를 이동해도 동일 조건의 순서가 고정된다.
label·departmentName은 null일 수 있다. addressData는 저장된 검증 주소를 그대로 반환하며 상세주소는 생략될 수 있다.
조회 결과가 없거나 기업이 비활성이거나 PIN이 없으면 `{ "data": [], "hasNext": false, "total_count": 0 }`다.
고유한 기업명·PIN을 임의로 선택하거나 합치지 않는다.

기업명과 PIN의 변경·기업 비활성화는 다음 조회에 반영한다. 별도 캐시를 두지 않으며
기업 상태와 PIN을 단일 SELECT의 같은 DB 스냅샷에서 읽는다. 조회 실패를 빈 성공으로 바꾸지 않는다.

## MVP 인증과 기존 API 경계

공식 공개 배송지 검색은 관리자 쿠키·AI 서비스 토큰·call_session_seq를 요구하지 않는다.
개인 또는 소속 기업에 제한된 조회가 아니므로 통화 고객이나 기업 소속을 확인하지 않는다.
이 GET 메서드에만 `MvpAiDirectoryAccess`를 적용하며 서비스 인증은
[S15P31D109-135](https://ssafy.atlassian.net/browse/S15P31D109-135)의 후속 범위다.

관리자 쿠키가 있으면 기존 ACTIVE 세션을 검증하며 만료·잘못된 쿠키를 익명 호출로 전환하지 않는다.
허용되지 않은 브라우저 Origin은 공통 CORS에서 거절한다.
기업 관리·구성원 조회·기업 공유 PIN 등록/수정 권한은 그대로 유지한다.
기존 `/companies/{id}/pins`는 소속 기업 조회 계약을 유지하며, 타 기업의 공식 배송지 검색은 이 API를 사용한다.
`/companies/search`는 `/companies/{id}`보다 먼저 등록해 search가 기업 번호로 해석되지 않도록 한다.

## AI 활용과 데이터 관리

AI는 고객이 말한 기업·부서 등으로 필요한 때만 검색하고 후보가 여러 개면 추가 확인한다.
고객이 선택한 addressData를 주문의 도착지에 복사하여 사용한다. 이 API가 주문이나 PIN을 자동 수정하지 않는다.
기업 디렉터리 전체를 [통화 초기 응답](caller-context.md)에 추가하지 않는다.
PIN의 version은 현재 값이며 수정 거절 조건으로 사용하지 않는다.

기업 등록·수정은 [기업 관리 API](companies.md), 공식 PIN 개별 등록·수정은 [주소록 API](pins.md)를 사용한다.
공유 PIN CSV 업로드는 이번 조회 API 범위에 포함하지 않는다. 구성원 CSV와 별도 작업이다.

## 오류와 검증

- 400 INVALID_REQUEST: 검색어·페이지·추가 필드 등 입력 오류.
- 401 UNAUTHORIZED: 잘못되거나 만료된 관리자 세션.
- 403 FORBIDDEN: 허용되지 않은 Origin.
- 공통 오류는 error/meta 형식이며 DB 조회 장애를 결과 없음으로 안내하지 않는다.

성공·오류 모두 Cache-Control: no-store를 적용한다. 요청 로그에 검색어·주소·연락처·응답 본문을 남기지 않는다.
단순 조회이므로 Idempotency-Key를 요구하거나 저장하지 않는다. 테이블·컬럼·마이그레이션도 추가하지 않는다.

```powershell
cd backend
npm.cmd run check:docker
```

격리 PostgreSQL과 실제 HTTP에서 공개 필드, 구성원·개인 PIN 제외, 다중 PIN·동명 기업·페이지,
검색 정규화·변경 반영·세션 및 관리 권한 경계·입력 오류·읽기 전용·Swagger를 검증한다.
운영 이미지·실제 Nginx에서도 검색과 비활성화 반영 및 기존 관리 API 보호를 검증한다.
실제 운영 배포와 AI 클라이언트의 기업 선택·주문 적용 연동은 별도 확인 사항이다.


모든 목록 응답의 최상위 total_count는 필수인 0 이상 정수이며 같은 검색·필터·권한 범위의 전체 결과 수다. limit·offset 적용 전 COUNT(*)를 목록 데이터와 같은 SQL 스냅샷에서 계산한다. 검색 결과 없음은 0이며 offset이 전체 건수를 넘어 data가 비어도 total_count는 유지한다. 기존 hasNext는 유지한다.
