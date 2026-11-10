# 고객 기본주소·기업 공유 배송지 AI 인계

2026-11-05 갱신. 백엔드 변경만 포함하며 `ai/`는 수정하지 않았다. 팀원 작성 AI 코드는 사용자 결정에 따라 담당자에게 인계한다.

AI의 DIR-01 요청은 기존 `Authorization: Bearer <AI_BUSINESS_TOKEN>`과 정규화된 q 1~100자 처리를 유지한다. 2026-11-10부터 관리자는 같은 DIR-01을 유효한 세션 쿠키로도 조회한다. 프론트는 [관리자 배송지 조회 명세](company-directory-admin-access.md)를 따르며, 사번·주소 없는 사원 조회에는 [별도 관리자 사원 검색](../../docs/api/company-members-search.md)을 유지한다. 053의 기업 PIN 제거는 [과거 주문 호환·배포 절차](company-pin-retirement.md)를 따른다. 아래 과거 검증 결과는 이번 관리자 인증 확장의 검증 결과를 대신하지 않는다.

## 데이터 기준

- 고객의 현재 기본 정보는 `customer.name`, `customer.phoneNumber`, `customer.address`다. 기본 출발지 사용을 위해 개인 PIN을 만들 필요가 없다.
- 개인 PIN은 자주 보내는 상대·추가 배송지를 위한 독립 주소록이다. 이름·주소 변경을 모든 개인 PIN에 전파하지 않는다.
- 기업 공유 배송지는 활성 기업·활성 소속·활성 고객의 현재 이름·전화번호·기본 주소를 조회한 것이다. 주소가 없는 사원은 제외한다. 다른 활성 기업도 검색할 수 있다.
- 주문에는 선택한 주소를 복사한다. 고객·소속 정보 변경으로 과거 주문 주소를 갱신하지 않는다.

## 백엔드에서 바뀐 계약

`POST /api/customers/context`의 customer·personalPins·callSessionSeq와 결제 자격은 유지한다. `companyPins`는 폐기 호환 필드로 항상 빈 배열이다. 초기 응답에 전체 기업 사원 목록을 넣지 않는다.

`GET /api/companies/search?q=주소기업%20주소셋&limit=20&offset=0`으로 기업 배송지를 검색한다. 응답은 `{ data, hasNext, total_count }`이며 각 항목은 다음 형태다.

```json
{
  "organizationSeq": 6,
  "organizationName": "예시기업",
  "membershipSeq": 26,
  "customerSeq": 26,
  "departmentSeq": null,
  "departmentName": null,
  "addressData": {
    "name": "김수령",
    "phoneNumber": "01012345678",
    "roadAddress": "서울특별시 중구 세종대로 110",
    "jibunAddress": "서울특별시 중구 태평로1가 31",
    "detailAddress": "101호",
    "dongName": "태평로1가",
    "postalCode": "04524"
  }
}
```

번호·이름·연락처는 문서 예시다. companyPinSeq·label·version은 더 이상 반환하지 않는다. customerSeq나 membershipSeq를 PIN 번호로 변환하지 않는다. 쿼리의 모든 공백 구분 단어가 기업명·부서명·사원 이름·연락처·주소에 일치해야 한다. 실제 클라이언트에서는 URLSearchParams 등으로 인코딩한다. 검색·정렬·활성 조건·오류는 [검색 계약](../../docs/api/company-directory.md)을 따른다.

기업 PIN의 GET/POST `/api/companies/{id}/pins`, PATCH `/api/company-pins/{id}`는 폐기되어 404다. 개인 PIN API는 유지한다. 053은 기업 PIN 테이블을 제거하고 이전 주문의 COMPANY 출처 참조·주소 사본은 보존한다. 새 기업 배송지를 선택할 때는 주소만 전달하고 originPin을 지정하지 않는다.

## AI 담당자가 적용할 순서

1. `BackendAPI.caller_context`에서 현재 customer.address를 별도 기본 출발지로 해석한다. 기존 클라이언트는 customer.address를 사용하지 않고 PIN·이전 주문만 읽으므로 이 변경이 필요하다.
2. 등록 고객의 기본 출발지 제안은 현재 고객 이름·발신번호·기본 주소를 우선한다. 이전 주소를 적용하는 `Call.use_place`·`Order.set_place` 경로에서 오래된 개인 PIN의 이름이 현재 발신자 이름을 덮어쓰지 않게 한다. 기본 주소가 없으면 사용자에게 묻거나 선택한 추가 주소를 확인한다.
3. 기업·사원으로 받는 곳을 지정하면 위 검색 API를 호출한다. 개인 PIN만 검색한 결과가 0건이라고 기업 배송지도 없다고 단정하지 않는다. 후보가 여러 개면 기업·사원·부서·주소로 확인하고, 결과 없음과 API 장애를 구분한다.
4. 받는 곳 정정 시 이전 수신인 이름·후보를 조건에 남기지 않는다. 예를 들어 처음 다른 사람을 말한 뒤 “아니다, 주소기업의 주소셋”이라고 바꾸면 새 기업·사원으로 다시 검색한다.
5. 선택한 addressData의 이름·전화번호·주소를 이번 주문에 함께 복사한다. 고객이 저장된 기업 사원을 선택했다면 응답에 전화번호가 있는데도 다시 묻지 않는다. 상세주소 생략은 기존 선택값 규칙을 따른다.
6. 기존 고객 등록 판정·통화 번호·개인 PIN 접근 범위·확인 관문·주문 재전송 키·결제 처리는 유지한다.

주소에서 위도·경도는 제거했다. AI는 조회한 도로명·지번·동·우편번호와 선택 상세주소를 사용하며 좌표를 보완하거나 주문 요청에 포함하지 않는다. [좌표 제거 계약](address-coordinates-removal.md)을 따른다.

## 담당자 검증과 반영 순서

AI의 가짜 백엔드 테스트에서 다음을 검증한 뒤, 사용자가 실제 통화를 확인한다. OpenAI·PBX 실호출을 자동 테스트에 넣지 않는다.

- 현재 고객 이름·기본 주소와 이름이 다른 오래된 개인 PIN이 같이 있어도 기본 출발지에 현재 고객 이름을 사용한다.
- 개인 PIN·이전 주문이 전혀 없어도 등록 고객의 기본 주소를 사용할 수 있다.
- 회사 A의 발신자가 회사 B의 활성 사원을 찾아 저장된 이름·연락처·주소로 접수한다.
- 다른 수신인을 말한 뒤 기업 사원으로 정정해도 이전 검색 조건을 지운다.
- 비활성 기업·비활성 소속·탈퇴 고객·주소 없음은 후보에서 제외한다. 여러 후보·빈 결과·검색 장애를 각각 처리한다.
- 개인 PIN 검색·권한, 주문 확인·결제·취소·기존 주문 주소가 회귀하지 않는다.

백엔드 작업 브랜치와 AI 담당자의 `develop-ai` 작업 브랜치는 각각 팀 MR 절차를 따른다. 확인한 develop-ai는 이미 새 검색 응답을 사용하며, 이번에는 기업 검색의 업무 토큰 헤더와 합친 q의 100자 처리가 추가로 필요하다. AI 코드와 이 문서의 계약을 검증한 뒤 조정된 시점에 배포한다. 이번 작업은 AI/FE 코드 수정·배포·MR 생성·실제 통화 검증을 포함하지 않는다.

## 2026-11-02 당시 검증 기록

- 변경 전 컴파일 결과로 새 기업 배송지 테스트를 실행해 사원 주소가 있어도 검색 결과가 비는 등 10건의 실패를 확인했다. 변경 후 해당 15개 테스트가 모두 통과했다.
- `npm run check`의 ESLint·Prettier·컴파일·기본 테스트 113개와 결제 모의 도구 테스트 21개가 통과했다.
- 운영 DB와 분리한 로컬 PostgreSQL 18에 기존 migration 전체를 적용하고 `infra/database/verify.sql`을 통과했다. package.json의 전체 통합 검증 31개 명령, 569개 테스트가 모두 통과했다. 주문·결제·취소·기업 삭제·개인 PIN·고객 컨텍스트·기업 검색 경로를 포함한다.
- Docker 엔진이 실행 중이 아니어서 Docker 운영 이미지·Nginx 경유 테스트는 실행하지 못했다. 해당 테스트 코드는 새 계약에 맞게 갱신하고 Node 구문 검사를 수행했다. PostgreSQL 17 운영 환경과 실제 AI 통화는 미검증이다.
- 별도 구형 검사인 `backend/database-tests/monolith-check.sql`은 public 테이블 기대값 27개와 현재 migration 결과 29개가 달라 실패했다. 이번 작업은 스키마를 바꾸지 않으며 해당 기존 검사나 기대값을 완화하지 않았다. 위 통합 검증은 현재 검사인 `infra/database/verify.sql`을 사용했다.

전용 작업 브랜치는 `refactor/company-address-directory`이며 기업 검색 전환, 기업 PIN API 폐기·개인 PIN 보존, 문서·AI 인계의 세 커밋으로 나눴다. 원래 작업 폴더와 다른 worktree의 미커밋 변경은 포함하지 않았다. 원격 푸시·MR 생성·운영 배포는 수행하지 않았다.
