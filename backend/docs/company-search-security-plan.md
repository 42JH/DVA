# 기업 검색 인증 분리·기업 PIN 정리 — 5개 작업 명세

작성일: 2026-11-05. 상태: 5개 작업의 로컬 구현·검증 완료. 실제 운영 DB 적용·배포는 수행하지 않았다.

2026-11-10 후속 변경: DIR-01은 활성 관리자 세션 또는 기존 AI Bearer를 허용한다. 아래 AI 전용 인증·전환 표는 당시 작업 기록이며, 현행 인증과 쿠키 우선순위는 [관리자 배송지 조회 명세](company-directory-admin-access.md)를 따른다.

검토 기준은 `fix/security-hardening`의 `4626c22d7a7c99cd6b65c861e78df14054ad07f8`이다. AI는 로컬에 가져온 `origin/develop-ai`의 `af9dd885c77357928556d90d98319d5d88d72e59`를 읽기 전용으로 확인했다. FE 동작은 사용자가 전달한 MR !296 설명을 기준으로 하며 해당 MR 코드는 직접 확인하지 않았다.

착수 시 원격 develop-backend의 `5cefb2e`까지 가져와 같은 작업 브랜치에 `9bb0fa1`로 통합했다. 원격 추가분은 MSA 변경이며 이번 구현에서 MSA·AI·FE 코드를 수정하지 않았다. 아래 명세의 구현 결과와 검증 범위는 마지막 절을 따른다.

## 범위와 결정

- 기존 DIR-01은 AI 배송지 검색용으로 두고 `AI_BUSINESS_TOKEN` 인증을 필수로 한다. 관리자 검색에는 별도 API를 제공한다.
- 새 관리자 API는 유효한 ACTIVE 관리자 세션으로만 호출한다. AI 토큰을 브라우저에 전달하지 않는다.
- **두 검색 API의 `q`는 정규화 후 1~100자**로 제한한다. 사용자가 최종 지정한 상한은 100자다.
- 기업 간 공유 범위와 주소 출처 정책은 변경하지 않는다. DIR-01은 계속 활성 사원의 현재 기본 주소를 검색한다.
- 관리자 검색에는 기본 주소가 없는 사원도 포함한다. 사원 등록·수정의 주소 필수화와 주소 삭제 금지는 이번 작업에 포함하지 않는다.
- `company_pins` 제거는 런타임 참조 정리와 실제 스키마 제거로 나눈다. 개인 PIN, 과거 주문 주소 사본, 기존 감사 기록은 보존한다.

| 작업 | 결과물 | FE 영향 | AI 영향 |
| --- | --- | --- | --- |
| 1. DIR-01 서비스 인증 | 기존 배송지 검색에 Bearer 필수 | 기존 검색 창은 작업 2로 전환 필요 | 같은 API에 업무 토큰 헤더 추가 |
| 2. 관리자 사원 검색 | `GET /api/companies/members/search` | URL·응답 필드 연결, 상태 표시 | 사용하지 않음 |
| 3. 검색어 100자 제한 | 두 API에 동일한 검증 계약 | 입력 길이·오류 처리 | 합친 검색어 길이 확인 |
| 4. 기업 PIN 참조 정리 | 주문·기업·부서·보존 작업의 테이블 의존 제거 | 과거 COMPANY 참조를 수정하는 경로 확인 | 현재 공유 배송지 선택 경로는 계약 유지 |
| 5. 기업 PIN 테이블 제거 | 신규 migration·스키마 검증·배포 절차 | 별도 API 변경 없음 | 별도 API 변경 없음 |

## 작업 1. DIR-01에 AI 업무 토큰 인증 적용

### 변경 내용

대상은 `GET /api/companies/search` 한 메서드다. 경로, 검색 대상, 성공 응답 필드, 페이지네이션은 유지한다. 검색어 길이만 작업 3에서 제한한다.

```http
GET /api/companies/search?q=예시기업%20김사원&limit=20&offset=0
Authorization: Bearer <AI_BUSINESS_TOKEN>
```

- 현재 `@MvpAiDirectoryAccess()`의 무인증 우회를 제거한다. Swagger 표시만 바꾸지 않고 실제 Guard에서 검증한다.
- 이 메서드는 **AI 서비스 인증 전용**으로 정한다. 관리자 쿠키만으로는 통과하지 않는다. 관리자 검색은 작업 2를 사용한다.
- S01에서 도입한 `AI_BUSINESS_TOKEN`과 토큰 비교 로직을 재사용한다. 별도 비밀값·환경변수를 추가하지 않는다.
- Authorization은 하나만 허용하며 누락·잘못된 형식·중복·불일치는 `401 UNAUTHORIZED`다. 토큰 미설정은 `503 DEPENDENCY_UNAVAILABLE`다.
- DIR-01에서는 Bearer로 인증한다. 유효한 Bearer와 쿠키가 함께 와도 인증 근거는 Bearer이며, 쿠키를 토큰의 대체 수단으로 쓰지 않는다.
- 기존 고객 API의 S01 정책인 ‘관리자 세션 또는 AI 토큰’은 유지한다. 다른 MVP AI 경로의 인증 정책을 함께 바꾸지 않는다.
- Swagger는 Bearer 필수로 표시하고 익명 허용 `{}`와 관리자 세션 대체 인증 표시를 제거한다.
- `Cache-Control: no-store`와 허용 Origin 정책을 유지한다. 토큰·검색어·전화번호·주소를 로그에 남기지 않는다.

### 영향과 수정 위치

BE: [AuthGuard](../src/auth/auth.guard.ts), [MVP 인증 메타데이터](../src/auth/mvp-ai-access.ts), [기업 Controller](../src/organizations/organizations.controller.ts), Swagger와 [기존 AI 토큰 안내](ai-business-auth.md), [DIR-01 계약](../../docs/api/company-directory.md), [AI 인계](company-address-directory-handoff.md).

AI: 기존 `search_company_places()`의 요청에 `Authorization: Bearer ...`를 추가한다. 고객 API에 이미 적용할 예정인 동일 토큰을 사용하되, **기업 검색 요청에도 헤더가 실제로 붙는지** 확인해야 한다. 응답 파서와 선택한 배송지의 주문 전송 형식은 유지한다.

FE: 관리자 검색을 새 API로 옮긴 뒤 기존 DIR-01의 쿠키 접근을 종료한다. 토큰을 FE 환경변수나 요청 코드에 넣지 않는다.

### 완료 기준

- 설정 정상 상태에서 무인증·쿠키만·잘못된 토큰·중복 Authorization 요청은 401, 올바른 토큰은 200이다.
- 토큰 미설정은 503이며 고객 API의 기존 세션/토큰 정상·오류 경로가 회귀하지 않는다.
- 올바른 토큰으로 얻는 배송지·상태 필터·페이지 응답은 기존 계약과 같다.

## 작업 2. 관리자용 사원 검색 API 제공

### 요청과 인증

```http
GET /api/companies/members/search?q=김사원&includeInactive=false&limit=50&offset=0
Cookie: dva_session=<관리자 세션>
```

| 항목 | 계약 |
| --- | --- |
| 인증 | 유효한 ACTIVE 관리자 세션 필수. 기존 관리자 조회와 동일하게 OPERATOR·SUPERVISOR·SYSTEM_ADMIN 허용 |
| `q` | 필수 문자열, 정규화 후 1~100자. 작업 3과 동일 |
| `includeInactive` | 선택, 기본 `false`. 문자열 `true`·`false`만 허용 |
| `limit` | 기본 20, 정수 1~100. FE의 50 사용 가능 |
| `offset` | 기본 0, 0~`Number.MAX_SAFE_INTEGER` 정수 |

기존 관리자 세션 Guard를 사용하며 MVP AI 우회 데코레이터는 붙이지 않는다. 무인증, AI 토큰만, 만료·잘못된 관리자 쿠키는 401이다. `Boolean('false')`처럼 잘못 변환하지 않으며 반복·미지원 파라미터는 기존 검증 방식으로 400을 반환한다.

### 검색·노출 규칙

- 사원 이름, 전화번호, 사번, 부서명만 검색한다. 기업명과 주소는 검색 조건에서 제외한다. 기업명 검색은 기존 `GET /api/companies`를 계속 사용한다.
- NFC·대소문자 정리 후 부분 일치로 검색한다. 공백으로 나눈 각 단어가 네 검색 필드 중 하나 이상에 일치해야 한다. 단어들 사이는 AND다.
- 전화번호 비교는 하이픈 유무와 무관하게 숫자로 처리한다. 사번은 문자열로 다루어 선행 0과 구분기호를 보존한다. `%`·`_`는 일반 문자로 처리하고 SQL에는 값을 바인딩한다.
- `customers.address_data IS NOT NULL` 조건을 두지 않는다. 주소 없는 기존 고객·사원과 부서 없는 사원도 검색된다.
- `includeInactive=false`: 기업과 소속 모두 ACTIVE인 사원만 포함한다.
- `includeInactive=true`: 기업·소속의 ACTIVE/INACTIVE를 모두 포함한다. 삭제된 기업·소속·고객과 WITHDRAWN 고객은 계속 제외한다. 비활성 포함은 삭제 기록 검색을 뜻하지 않는다.
- 한 줄은 소속 하나다. 서로 다른 기업 또는 서로 다른 소속을 이름·전화번호로 합치지 않는다.
- 정렬은 NFC·소문자 기업명 → 기업 번호 → 소속 번호 오름차순으로 고정한다.
- 검색·상태 필터 후 서버에서 페이지를 계산한다. FE의 사원 여부 후처리 필터는 제거한다. `total_count`는 같은 조건의 페이지 적용 전 소속 수이고 `hasNext`는 다음 페이지 존재 여부다.
- 응답에는 주소·개인 PIN·결제 설정 등 검색 창에서 쓰지 않는 개인정보를 추가하지 않는다.

### 응답

HTTP 200. 기존 목록과 같은 `{ data, hasNext, total_count }` 형식을 사용한다.

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

번호는 양의 정수, 두 상태는 `ACTIVE | INACTIVE`, `employeeNo`·이름·전화번호·기업명은 문자열이다. 부서가 없으면 `departmentName`은 null이다. 주소 유무에 따라 응답 형태를 바꾸지 않는다. 결과가 없으면 `{ "data": [], "hasNext": false, "total_count": 0 }`이다.

### 영향과 수정 위치

BE: 기존 [Members Controller](../src/members/members.controller.ts)·[Service](../src/members/members.service.ts)·[Repository](../src/members/members.repository.ts)에 검색을 추가하고 검색 DTO·응답 DTO를 정의한다. 새 모듈이나 검색 테이블은 만들지 않는다. 기존 `PaginationQueryDto`·`readPage`·목록 응답 처리를 재사용한다. Swagger와 FE용 계약 문서를 함께 작성한다.

FE 전달사항:

1. 상단바 사원 검색 URL을 `/api/companies/members/search`로 교체하고 관리자 쿠키를 계속 전송한다.
2. `addressData.name`·`addressData.phoneNumber`를 최상위 `name`·`phoneNumber`로 교체한다. `organizationSeq`를 사용한 상세 이동은 유지한다.
3. 사번·부서 검색과 `includeInactive`를 연결하고 비활성 표시는 두 상태 필드를 사용한다. 별도 UI가 준비되지 않으면 기본값 false로 호출한다.
4. 새 API에는 검색어 원문을 보내는 방식을 권장한다. 전화번호 정규화는 서버가 담당한다. 숫자·하이픈 낱말을 일괄 숫자로 바꾸면 `001-23` 같은 사번의 구분기호가 사라지므로, 기존 전처리는 사번 검색과 함께 조정한다.
5. 기존 기업명 검색 `GET /api/companies`와 상세 이동 경로는 유지한다.

사원 등록 시 주소를 필수로 바꾸거나 `address: null`을 금지하는 작업은 하지 않는다. FE의 주소 필수화와 무관하게 서버 검색은 주소 없는 기존 사원도 처리한다.

### 완료 기준

관리자 3개 역할, 비로그인·AI 토큰만·잘못된 쿠키, 이름/전화번호/사번/부서, 주소 없는 사원, 부서 없는 사원, 기업명·주소만 일치하는 사원의 제외를 검증한다. 비활성 조합·삭제·탈퇴 제외, 빈 결과, 동일 이름, 페이지 경계와 범위 밖 offset의 전체 건수도 실제 PostgreSQL로 확인한다.

## 작업 3. 검색어 최대 100자 검증

대상은 기존 DIR-01과 새 관리자 사원 검색이다. 다른 목록·FAQ·개인 PIN 검색의 제한은 이번 작업에서 바꾸지 않는다.

1. URL 디코딩된 문자열에 기존 방식대로 NFC → 앞뒤 공백 제거 → 연속 공백을 한 칸으로 정리한다.
2. 정규화된 전체 `q`를 **공백 포함 Unicode 코드 포인트 기준 1~100자**로 검사한다. 바이트 수나 URL 인코딩된 길이가 아니다.
3. 누락·빈 문자열·공백만·문자열이 아닌 값·반복 q·101자 이상은 기존 오류 형식의 `400 INVALID_REQUEST`로 반환한다. 인증이 필요한 요청은 먼저 인증을 통과해야 이 입력 오류를 확인할 수 있다.
4. 오류 `details`에서 `field: "q"`와 길이 제한 사유를 제공한다. 입력값 자체는 오류나 로그에 포함하지 않는다. 100자는 허용하고 101자는 거절한다.
5. 서버에서 검색어를 임의로 잘라 검색하지 않는다. 두 DTO의 검증과 Swagger `maxLength: 100`을 일치시킨다.

FE는 같은 기준으로 입력·요청을 제한하고 400을 표시한다. 브라우저 기본 maxlength만으로 Unicode 길이 기준을 다르게 적용하지 않도록 확인한다. 서버 검증은 항상 유지한다.

**AI 영향:** 현재 `find_destination()`은 기업명·부서·이름·장소·상세조건을 한 문자열로 합친다. 각 입력에는 길이 제한이 있지만 합친 `q`는 100자를 넘을 수 있다. AI 팀은 요청 직전 같은 정규화·길이 검증을 추가하고, 초과하면 검색 의도를 유지하는 짧은 조건을 구성하거나 고객에게 짧게 다시 묻도록 처리한다. 무조건 앞 100자로 자르거나 같은 400 요청을 반복하지 않는다. 조건을 줄여 후보가 많아지면 기존 추가 질문·후보 선택 절차를 유지한다.

BE 수정 위치는 기존 [CompanyDirectoryQueryDto](../src/organizations/dto/company-directory.dto.ts)와 새 관리자 검색 DTO다. 빈 값·100/101 경계·한글 NFC·공백·보충 평면 문자·반복 파라미터의 HTTP 검증을 추가한다. FE·AI 길이 처리 검증은 각 담당 측에서 수행한다.

## 작업 4. `company_pins` 런타임 참조 제거

현재 기업 PIN 등록·수정·목록 API는 이미 폐기됐지만 다음 코드가 테이블을 사용하고 있다. 먼저 이 경로를 정리하고 테이블을 남긴 상태와 제거한 상태에서 모두 정상 동작하도록 한다.

| 현재 의존 | 변경 내용 |
| --- | --- |
| 주문 생성·수정·최종 접수의 `canUsePin()` COMPANY 분기 | 새 기업 PIN 선택을 종료하고 과거 참조 처리를 분리 |
| 기업·부서 삭제의 `removePins()`와 관련 감사 생성 | 기업 PIN 행 갱신을 제거. 실제로 수행하는 다른 삭제·감사는 유지 |
| 부서명 변경의 `renamePins()`와 관련 감사 생성 | PIN 이름 동기화를 제거. 부서명 변경 자체는 유지 |
| 보존 작업의 기업 PIN 삭제와 부서·기업 정리 조건 | 테이블 참조만 제거. 다른 데이터의 보존 기간·삭제 조건은 유지 |
| 주문 DTO·Swagger·문서·fixture | 신규 선택 계약과 과거 조회 계약을 구분하고 회귀 사례로 교체 |

### 과거 주문 처리 권고안

- `order_parcels.origin_pin_scope/origin_pin_seq`의 과거 COMPANY 값은 논리 참조이므로 보존한다. 주문 출발지·도착지 주소 사본, 버전·시각·결제·배송·감사 기록을 일괄 변경하지 않는다.
- 새 주문과 새 상세에서는 `originPin.scope=COMPANY`를 받지 않는다. `400 INVALID_REQUEST`로 거절하고, 공유 배송지는 현재처럼 주소 사본으로 전달하게 한다. PERSONAL 선택·소유권 검증은 유지한다.
- 기존 주문의 COMPANY 참조는 조회할 때 그대로 반환할 수 있다. 참조를 그대로 유지하는 수정·최종 접수는 저장된 주소 사본을 사용하며 삭제될 테이블을 조회하지 않는다.
- PATCH에서 COMPANY를 보내는 호환 경로는 **동일 주문의 기존 상세에 저장된 동일 참조와 출발지 주소 사본을 유지하는 경우**로 제한한다. 신규 상세·다른 번호·다른 상세에서 복사한 참조는 거절한다. 출발지 주소를 변경하면 `originPin: null` 또는 유효한 PERSONAL로 전환한다.
- 클라이언트가 `scope=COMPANY`를 보냈다는 이유만으로 검증을 통과시키지 않는다. 기존 주문 접근·수정 권한과 동시 수정·결제 처리 검증은 유지한다.
- `companyPins: []` 호환 필드는 유지한다. 기업 사용 구분인 `availableUsageTypes`의 COMPANY나 AI 주소 출처 COMPANY는 테이블 참조가 아니므로 제거하지 않는다.

BE 수정 위치는 [주문 Repository](../src/orders/orders.repository.ts), [주문 Service](../src/orders/orders.service.ts), [최종 접수](../src/orders/order-submission.service.ts), 주문 DTO, [부서 처리](../src/organizations/departments.repository.ts), [기업·부서 삭제](../src/organizations/organization-deletion.repository.ts), 해당 Service와 [보존 Repository](../src/retention/retention.repository.ts)다.

현재 확인한 develop-ai는 공유 배송지 선택 시 주소 사본을 전송하며 새 COMPANY originPin을 보내지 않는다. 이 경로의 AI 수정은 필요하지 않다. FE의 과거 주문 수정에서 originPin을 그대로 재전송하거나 주소를 바꾸는 경우는 확인이 필요하며, 주소 변경 시 참조 해제가 필요한 부분이 있으면 최종 보고에 명시한다.

완료 기준은 런타임 SQL의 `company_pins` 참조 0건, 신규 COMPANY 선택 거절, 과거 COMPANY 주문의 조회·수정·최종 접수·결제 복구, PERSONAL 주문·PIN, 부서명 변경, 기업·부서 삭제, 보존 작업의 회귀 검증이다. 신규 선택을 허용하던 테스트는 폐기 계약의 거절 테스트와 과거 주문 fixture의 유지 테스트로 바꾸며, 기능을 통째로 삭제해서 검증을 피하지 않는다.

## 작업 5. `company_pins` 테이블 제거와 전환 검증

### 구현 산출물

- 적용된 기존 migration은 수정하지 않는다. `backend/migrations/<다음번호>-drop-company-pins.sql`을 추가한다. 현재 마지막 번호는 052이며 다음 번호는 구현 착수 시 원격 변경과 다시 확인한다.
- 작업 4가 끝난 뒤 `company_pins`와 그 테이블 전용 객체만 제거한다. 무조건적인 `CASCADE`로 다른 객체를 함께 삭제하지 않는다. 개인 PIN이 공유하는 함수·검증·트리거 기반은 보존한다.
- [스키마 검증](../../infra/database/verify.sql), DB 검증 fixture·테이블/제약 개수, [ERD](../../docs/database/monolith.dbml), [DB 안내](../../docs/database/README.md), [백엔드 README](../README.md), [PIN 계약](../../docs/api/pins.md), [기업 삭제 계약](../../docs/api/company-deletion.md), 배포·복구 안내를 변경된 최종 스키마에 맞춘다.
- 기존 migration에 남은 테이블 생성·변경 기록은 정상적인 이력이므로 유지한다. 현재 스키마와 런타임 의존만 제거한다.

### 실제 삭제 전 확인과 배포 순서

1. 운영 데이터에서는 총 행·활성/삭제 행, 과거 COMPANY 주문 참조, 아직 진행 중인 해당 주문, 보관 대상 이력을 집계한다. 현재는 이 현황을 조회하지 않았다.
2. 삭제되는 기업 PIN 원본과 과거 주문 주소 사본이 별개라는 점을 확인한다. 보존이 필요한 원본의 처리·백업 보관 범위를 정한 뒤 적용한다. 이름·주소가 비슷하다는 이유로 현재 고객 주소에 자동 합치지 않는다.
3. 기존 `infra/database/migrate.sh` 절차의 백업·체크섬·트랜잭션을 사용하고 별도 DB에서 복원 가능한지 확인한다.
4. 테이블에 의존하는 구버전 앱·워커를 중지하거나 작업 4의 호환 버전으로 전환한다. 구버전이 실행 중인 상태에서 먼저 DROP하지 않는다.
5. 새 migration → 최종 스키마 검증 → 호환 앱 실행 → 주문·기업·보존 경로 확인 순서로 적용한다.
6. DROP 후에는 테이블을 요구하는 구버전 이미지로 단독 롤백할 수 없다. 호환 버전으로 복귀하거나 백업을 복원하는 별도 복구 절차가 필요하다. 새 주문 등 전환 후 데이터의 보존을 고려하지 않은 전체 복원도 실행하지 않는다.

이번 명세 작성에는 운영 DB 접속·삭제·배포를 포함하지 않는다. 실제 적용은 삭제 대상·데이터 현황·백업·검증 결과를 제시한 뒤 진행한다.

### 완료 기준

신규 DB 전체 migration과 기존 데이터가 있는 DB의 업그레이드를 모두 검증한다. 최종 스키마에서 테이블 부재, 개인 PIN·주문 주소 사본·과거 참조·감사 보존, migration 재실행, SQL 실패 시 트랜잭션 롤백, 백업 복원을 확인한다. 실제 신규 스키마에서 작업 4의 정상·회귀 시나리오를 다시 실행한다.

## 공통 인증·오류 계약

| 요청 | DIR-01 | 새 관리자 사원 검색 |
| --- | --- | --- |
| 인증 정보 없음 | 401 | 401 |
| 올바른 AI 토큰만 | 200 | 401 |
| 유효한 관리자 쿠키만 | 401 | 200 |
| 잘못된 관리자 쿠키만 | 401 | 401 |
| 정상 인증 + 잘못된 q·페이지·필터 | 400 | 400 |
| 정상 인증 + 결과 없음 | 200, 빈 목록 | 200, 빈 목록 |

표는 서비스 토큰 설정과 정상 의존성이 갖춰진 상태를 전제로 한다. DIR-01의 토큰 미설정은 503이다. DB 장애를 200 빈 목록으로 바꾸지 않으며, 기존 공통 오류 envelope `{ error: { code, message, details }, meta: { requestId } }`와 no-store를 사용한다.

## 권장 적용 순서와 인계

1. 작업 2·3의 관리자 API와 100자 검증을 준비한다. AI의 토큰·길이 대응을 함께 확인한다.
2. FE는 새 URL·평탄화된 이름/전화번호·상태·검색어 전처리로 전환한다. 비활성 검색이 준비되지 않으면 기본 false로 사용한다.
3. AI가 DIR-01에도 토큰을 보내는 것을 확인하고 작업 1을 적용한다. 쿠키 전용 FE를 남겨 둔 채 DIR-01만 잠그면 기존 검색 창은 401이 된다. 필요한 전환을 같은 배포 일정으로 조정한다.
4. 작업 4를 로컬 검증한다. 테이블을 남긴 단계에서 호환 동작을 먼저 확인할 수 있으나 운영에서는 남은 기업 PIN FK가 물리 보존 정리에 영향을 주므로 앱/워커 중지와 작업 5를 같은 전환으로 준비한다.
5. 데이터·복구 검토 후 작업 4·5를 함께 배포한다. 새 스키마에 구버전 앱이 재기동되지 않도록 배포·복귀 절차를 맞춘다.

이 순서는 배포 의존 관계다. 순차 구현 시 각 작업 검증을 마치고 다음으로 진행한다. 인증의 실제 제공 시점은 작업 1의 배포 완료 시점이며 이 문서만으로 배포 일정이나 Jira 상태가 확정되지는 않는다.

BE 검증은 기존 node:test·격리 PostgreSQL을 사용한다. 인증 Guard를 바꾸는 작업은 고객·관리자 정상 경로를 함께, PIN 제거는 주문·결제·기업 삭제·보존·개인 PIN을 함께 확인한다. 변경에 맞춰 lint·format·빌드, 통합 테스트와 `npm run check:docker`, DB migration 검증을 수행한다. 새 테스트 진입점이 필요한 경우에만 package.json과 기존 검증 실행 목록에 연결한다.

## 구현 결과·검증 범위

5개 작업을 구현했다. [관리자 API 계약](../../docs/api/company-members-search.md), [AI 업무 인증](ai-business-auth.md), [053 데이터·배포·복구 안내](company-pin-retirement.md)를 최종 인계 문서로 사용한다. 실제 운영 테이블을 삭제한 것이 아니라 새 migration과 호환 앱을 준비하고 임시 DB에서 검증한 결과다.

| 검증 | 결과 |
| --- | --- |
| 인증·검색 단계 전체 Docker 검증 | 977/977 통과 |
| 기업 PIN 참조 정리 단계 전체 Docker 검증 | 979/979 통과 |
| 053 적용 최종 `npm run check:docker` | 980/980 통과, 실패 0·건너뜀 0 |
| 최종 구성 | 단위 182·결제 모의 21·격리 PostgreSQL 통합 755·운영 이미지/Nginx 22 |
| lint·format·컴파일 | 최종 Docker checks에서 통과 |
| `infra/database/test-monolith.ps1` | 신규 전체 적용·기존 업그레이드·runner 재실행·체크섬·실패 롤백·백업 복원 통과 |
| 신규 052→053 데이터 검증 | 주문 주소/COMPANY 참조·개인 PIN·기업/부서/소속·고객·감사 보존, 의존 뷰 차단, 삭제 후 실패 롤백, 원본이 있는 백업 복원 통과 |
| `infra/deploy/test-deploy.sh` | 네트워크 없는 Linux 컨테이너의 가짜 Docker로 053 중지→백업 순서·오류 처리·구버전 배포/롤백/자동 복귀 차단 통과 |
| 소스·문서 확인 | backend/src의 company_pins SQL 참조 0건, 변경 문서의 로컬 링크 확인, git diff --check 통과 |

ERD 변경은 기업 PIN 테이블·FK 제거 범위다. 기존 다른 필드 전체의 동기화는 수행하지 않았으며 실제 최종 스키마는 migration·verify.sql과 위 DB 검증을 기준으로 한다.

AI·FE 코드는 수정하지 않았고 실제 AI 통화·FE MR 코드·운영 DB 현황·운영 배포는 미검증이다. 기업 간 공유/주소 출처 변경, 주소 필수화, 별도의 호출 횟수 제한, 미뤄 둔 다른 보안 항목은 추가하지 않았다. 운영에서는 FE의 새 API 전환과 AI의 Bearer·100자 대응을 먼저 맞추고 원본 보관·백업 확인 후 053과 앱을 함께 전환한다.
