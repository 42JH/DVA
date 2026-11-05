# 고객 등록 및 정보 관리 API

Jira: [S15P31D109-34](https://ssafy.atlassian.net/browse/S15P31D109-34).
구현은 모놀리식 `backend/src/customers/`에 두며 MSA는 변경하지 않는다.

## 인증과 범위

고객 등록·상세·수정과 [고객 확인](caller-context.md)의 AI 요청은
`Authorization: Bearer <AI_BUSINESS_TOKEN>`을 요구한다. 관리자 쿠키·Origin은 보내지 않는다.
토큰은 32자 이상 공백 없는 ASCII이며 환경변수에는 Bearer 접두사 없이 값만 저장한다.
서버 미설정은 503, 요청 토큰 누락·오류·중복 Authorization은 401이다.
AI의 address 수정·삭제에는 기존처럼 진행 중 본인 통화의 call_session_seq도 필요하다.
설정·배포·토큰별 사용 범위는 [S01 연동 안내](../../backend/docs/ai-business-auth.md)를 따른다.

고객 목록과 status 변경은 모든 ACTIVE 관리자 역할에 허용한다.
관리자 `dva_session` 쿠키를 보내면 실제 세션을 검증하며 잘못되거나 만료된 쿠키는
AI 요청으로 전환하지 않고 401로 거절한다. 관리자 변경 요청에는 허용 Origin이 필요하다.
유효한 AI 토큰으로도 status·월결제 자격을 변경하면 403이다.
임의의 관리자 ID·AI 식별 헤더로 권한을 부여하지 않는다.

이번 서비스 인증은 상세 조회·이름 수정의 통화별 소유권을 검증하지 않는다. 발신번호 식별과 고객·기업·PIN
초기 데이터 제공은 [33번 API](caller-context.md)를 사용한다. 통화 시작·고객 연결, 실제 고객 본인인증은 별도 범위다.
고객 목록의 phoneNumber 검색은 관리자용이며 AI 발신번호 식별 API를 대체하지 않는다.

## HTTP 계약

| 메서드·경로 | 요청 | 성공 응답 |
| --- | --- | --- |
| POST /api/customers | `{ name, phoneNumber, monthlyBillingEnabled?, address? }` | 201, `{ data: { customerSeq }, meta: { requestId } }` |
| GET /api/customers | 관리자 세션, q·phoneNumber·status·limit·offset | 200, `{ data: Customer[], hasNext, total_count }` |
| GET /api/customers/{id} | 양의 PostgreSQL integer 범위 ID | 200, `{ data: Customer, meta: { requestId } }` |
| PATCH /api/customers/{id} | name·address 또는 관리자 전용 status·monthlyBillingEnabled 중 한 개 이상 | 204, 본문 없음 |

Customer는 `{ customerSeq, name, phoneNumber, status, monthlyBillingEnabled, address }`다. address는 내 주소 객체 또는 null이며 PIN 주소록·기업 소속은 별도다.
조회·오류의 Cache-Control은 공통 `no-store`를 따른다.

이름은 앞뒤 공백을 제거하고 빈 문자열·null을 거절한다. 전화번호는 선행 0을 보존하는
숫자 문자열이며 하이픈·공백·`+`·숫자 타입을 거절한다. 자동 국가번호 변환이나 하이픈 제거는 하지 않는다.
monthlyBillingEnabled는 개인 월결제 자격이며 미입력은 false다. 생성 시 true 또는 자격 변경은 유효한 관리자만 허용한다. boolean 문자열·null은 거절하며 PATCH 생략은 기존 값을 유지한다. 기업 소속 고객의 월결제는 기업 자격을 사용한다.

신규 고객 상태는 ACTIVE이며 등록 본문의 status 등 추가 필드는 400이다.
PATCH의 phoneNumber 변경, 본문 전체 null·빈 객체, 지원하지 않는 필드는 400이며 일부 필드만 저장하지 않는다. address 필드의 null은 내 주소 삭제다.
대상이 없으면 404다. 실제 삭제와 전화번호 변경 API는 제공하지 않는다.

목록은 고객 번호 내림차순이다. limit 기본 20·범위 1~100, offset 기본 0이다.
q는 이름의 대소문자 무시 부분 검색이며 `%`·`_`도 문자 그대로 검색한다.
phoneNumber는 정확히 일치 검색하고 status는 ACTIVE/WITHDRAWN이다. 필터는 AND로 결합한다.
조건에 맞는 결과가 없으면 `{ data: [], hasNext: false, total_count: 0 }`이며 total_count를 포함하고 meta·page 객체는 추가하지 않는다.

## 탈퇴 상태

관리자는 ACTIVE → WITHDRAWN으로 변경할 수 있다. WITHDRAWN → ACTIVE 복구는 409 INVALID_STATE다.
탈퇴 고객의 이름과 이력은 보존하며 관리자에게 목록·상세를 제공한다.
인증된 AI의 상세·이름 수정은 WITHDRAWN 고객을 404로 처리한다.
상태 변경으로 기존 주문·개인 PIN·기업 소속을 삭제하거나 상태를 일괄 변경하지 않는다.
탈퇴한 고객도 전화번호 고유성을 유지하므로 같은 번호를 다시 등록하면 409 DUPLICATE_RESOURCE다.

## 고객 등록 중복 처리

등록 API는 Idempotency-Key를 요구하거나 저장하지 않는다. 기존 클라이언트가 보내는 헤더는 무시한다.
customers.phone_number의 UNIQUE 제약으로 동시 등록까지 막는다. 이미 등록된 번호는
이름이나 상태를 덮어쓰지 않고 409 DUPLICATE_RESOURCE를 반환한다. 탈퇴 고객도 재등록하지 않는다.
응답 유실 시 최초 응답 재생은 지원하지 않으며 기존 고객 여부를 확인한다.
주문 내부의 고객 연결은 기존 CustomersService.resolveForOrder를 사용하며, 활성 고객을 연결하거나 신규 고객과 주문을 함께 저장한다.

## DB 적용과 검증

등록 API는 기존 customers 테이블만 사용한다. 005는 과거 적용 이력으로 보존하며 008에서 요청 기록 테이블을 제거한다. 배포·복구 절차는 [DB 문서](../database/README.md)를 따른다.

```powershell
cd backend
npm.cmd run check:docker
cd ..
./infra/database/test-monolith.ps1
```

기존 Docker 검증에 고객 HTTP/DB 테스트를 연결한다. 입력·검색·권한·상태 전이,
동시 전화번호 충돌·재시작·실패 롤백, 실제 운영 이미지와 Nginx의 AI 토큰 인증 및
관리자 경계를 검사한다. DB runner는 신규 migration·제약·반복 적용·기존 데이터 보존·
백업 복원·체크섬 변경 거부·최초 및 후속 실패 롤백을 검사한다.
테스트는 임시 PostgreSQL만 사용한다. 이 문서는 실제 서버 적용이나 AI 팀 연동 완료를 뜻하지 않는다.

## AI 호출 예시

서버 호출은 Content-Type과 업무 인증을 보낸다.

```http
POST /api/customers
Authorization: Bearer <AI_BUSINESS_TOKEN>
Content-Type: application/json

{"name":"예시 고객","phoneNumber":"01012345678"}
```

201의 data.customerSeq를 이후 상세 조회·이름 수정에 사용한다.
관리자 목록·상태 변경은 기존 로그인 쿠키와 허용 Origin을 사용한다.

## 감사 기록

등록은 CUSTOMER_CREATED, 이름·상태·탈퇴 수정은 CUSTOMER_UPDATED를 고객 번호와 함께 기록한다.
관리자 호출은 ADMIN과 당시 이름, 기존 AI 호출 경로는 AI로 구분한다. 성공 감사와 고객 변경은 같은 트랜잭션이다.
실패·거부는 롤백 후 별도로 남기며 전화번호·요청 본문은 기록하지 않는다. 요청·응답 형식은 그대로 유지한다.


모든 목록 응답의 최상위 total_count는 필수인 0 이상 정수이며 같은 검색·필터·권한 범위의 전체 결과 수다. limit·offset 적용 전 COUNT(*)를 목록 데이터와 같은 SQL 스냅샷에서 계산한다. 검색 결과 없음은 0이며 offset이 전체 건수를 넘어 data가 비어도 total_count는 유지한다. 기존 hasNext는 유지한다.

## 고객의 내 주소

028 migration의 customers.address_data(jsonb)에 저장하며 개인/기업 PIN과 독립이다.
기존 고객은 null이며 PIN·과거 주문에서 추측해 채우지 않는다. PIN 생성·변경·삭제는 내 주소를 변경하지 않는다.
POST /api/customers와 PATCH /api/customers/{id}에 선택 address를 보낼 수 있다. 객체는 전체 교체, 생략은 유지(신규는 null), null은 삭제다.

```json
{"address":{"roadAddress":"서울시 예시로 1","jibunAddress":"서울시 예시동 1","detailAddress":"101호","dongName":"예시동","postalCode":"01234","latitude":37.5,"longitude":127}}
```

객체 안에서 detailAddress만 선택이며 생략/빈 문자열은 허용하고 null은 거절한다. 나머지 문자열·좌표는 필수다.
우편번호는 숫자 5자리, 위도 -90~90·경도 -180~180이다. 이름·전화번호를 주소에 중복 저장하지 않는다.
고객 목록·상세·발신자 context·직원 목록의 customer.address는 항상 주소 객체 또는 null이다.
주문 본문의 인라인 customer에는 address를 받지 않으며, 주문 주소·과거 스냅샷은 이 기능으로 변경하지 않는다.
고객 주소 수정도 기존 CUSTOMER_UPDATED 성공 감사와 같은 트랜잭션으로 처리한다.
