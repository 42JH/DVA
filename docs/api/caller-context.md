# 고객 확인·초기 주소록 조회 및 통화 시작 API

Jira: [S15P31D109-33](https://ssafy.atlassian.net/browse/S15P31D109-33).
구현은 모놀리식 `backend/src/customers/`에 둔다.

## 요청

```http
POST /api/customers/context
Content-Type: application/json

{
  "phoneNumber": "01012345678",
  "call": {
    "providerCallId": "call_example",
    "incomingAt": "2026-10-29T01:00:00Z"
  }
}
```

PBX에서 전달받은 발신번호를 본문으로 보낸다. 숫자로만 이루어진 문자열이며 선행 0을 보존한다.
숫자 타입, 빈 문자열, 공백·하이픈·국가번호 `+`, 줄바꿈, null과 추가 필드는 400 INVALID_REQUEST다.
국내 번호로 변환해 보낸다. call을 보낸 경우 숫자 국제 표기 `0082`도 국내 `0`으로 통일해 조회·저장하며, 변환 후 번호는 3~20자리다. `phone`은 지원하지 않는다.
전화번호를 URL에 넣지 않도록 조회에도 POST를 사용한다.

AI는 통화 시작 시 `call`을 함께 보내고 응답의 `data.callSessionSeq`를 보관한다.
이후 주문 조회·취소·이전 주소 조회·개인/기업 PIN API의 `call_session_seq` 헤더에 이 번호를 사용한다.
기존 `{"phoneNumber":"01012345678"}` 요청은 조회만 수행하며 응답에도 callSessionSeq를 추가하지 않는다.

| 통화 필드 | 규칙 |
| --- | --- |
| call.providerCallId | 최초 OpenAI 수신 이벤트의 통화 ID. 1~200자, 공백·NUL 불가. 재요청·주문 결과 전송까지 유지 |
| call.incomingAt | 수신 이벤트 created_at(Unix 초)을 시간대 포함 ISO 8601로 변환한 값. 현재 시각으로 교체하지 않음 |

call을 보낼 때는 두 필드 모두 필요하고 null·빈 객체·추가 필드는 허용하지 않는다.
같은 providerCallId·발신번호·수신 시각으로 재요청하면 같은 번호를 반환하며, 동시 요청도 통화 한 건만 저장한다.
같은 ID의 번호나 시각이 다르면 409다. 이미 종료된 통화를 다시 시작 상태로 바꾸지 않는다.

MVP 합의에 따라 이 메서드만 서비스 인증을 면제한다. 관리자 쿠키, Bearer 토큰, Origin,
call_session_seq 헤더, Idempotency-Key를 요구하지 않는다. 관리자 쿠키를 보낸 경우에는 유효한 세션과
허용 Origin이 필요하며, 만료되거나 잘못된 쿠키를 익명 호출로 전환하지 않는다.
허용되지 않은 브라우저 Origin은 기존 CORS에서 거절한다.

이 API는 발신번호의 DB 일치를 조회하며 전화번호 소유자의 본인인증은 수행하지 않는다.
서비스 인증·신뢰된 발신정보 검증은 [S15P31D109-135](https://ssafy.atlassian.net/browse/S15P31D109-135)의 후속 범위다.
call을 보내면 고객 등록 여부와 무관하게 기존 call_sessions에 통화 ID·발신번호·수신 시각을 저장하거나 기존 통화를 재사용한다.
고객·주문 등록·최근 주문 조회·AI 설정 조회는 수행하지 않는다. 미등록 고객도 통화를 보존하지만 기존 주문·PIN 접근에는 활성 고객이 필요하다.
기존 명세 초안에서 CALL-01에 포함했던 고객 초기 조회를 별도로 제공한다.
이 문서의 경로는 모놀리식 AI 호출용이며 MSA 내부 API 구현을 의미하지 않는다.

## 성공 응답

HTTP 200, `{ data: CustomerContext, meta: { requestId } }` 형식이다.
응답과 오류에 `Cache-Control: no-store`를 적용한다.

```json
{
  "data": {
    "callSessionSeq": 7,
    "lookupStatus": "REGISTERED",
    "customer": {
      "customerSeq": 12,
      "name": "김철수",
      "phoneNumber": "01012345678",
      "status": "ACTIVE",
      "monthlyBillingEnabled": false
    },
    "membership": {
      "membershipSeq": 7,
      "customerSeq": 12,
      "organizationSeq": 3,
      "departmentSeq": 5,
      "employeeNo": "0012",
      "role": "MEMBER",
      "status": "ACTIVE"
    },
    "organization": {
      "organizationSeq": 3,
      "name": "예시 기업",
      "status": "ACTIVE",
      "monthlyBillingEnabled": false
    },
    "department": {"departmentSeq":5,"organizationSeq":3,"name":"개발팀","groupBillingEnabled":false},
    "availableUsageTypes": ["PERSONAL", "COMPANY"],
    "availablePaymentMethods": ["billing"],
    "personalPins": [
      {
        "personalPinSeq": 21,
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
        },
        "version": 1
      }
    ],
    "companyPins": []
  },
  "meta": { "requestId": "a73c0008-775a-42ca-8903-1a240654fcfa" }
}
```

| 필드 | 의미 |
| --- | --- |
| callSessionSeq | call을 보낸 경우에만 반환. DB call_sessions.call_session_seq이며 인증 토큰이 아님 |
| lookupStatus | REGISTERED: 활성 등록 고객, UNREGISTERED: 해당 번호 없음, WITHDRAWN: 탈퇴 고객 |
| customer | 활성 고객의 기본 정보. 미등록·탈퇴 고객은 null |
| membership | 활성 고객의 현재 소속. 없으면 null. INACTIVE 소속도 상태를 함께 반환 |
| organization | 현재 소속 기업 정보. 소속이 없으면 null. INACTIVE 기업도 상태를 함께 반환 |
| department | 현재 소속 부서와 그룹결제 자격. 소속 없거나 미등록·탈퇴면 null |
| availablePaymentMethods | 현재 사용 가능한 billing·credit·groupBilling. 최종 확정 때 서버가 다시 자격 검사 |
| availableUsageTypes | 현재 사용 가능한 PERSONAL·COMPANY 범위. 주소록 유무와 무관 |
| personalPins | 본인의 개인 PIN 전체. 없거나 고객이 비활성이면 빈 배열 |
| companyPins | 폐기된 기업 PIN의 호환 필드. 항상 빈 배열. 기업 배송지는 GET /api/companies/search로 조회 |

고객은 주문 이력이나 PIN이 없어도 REGISTERED다. 미등록과 탈퇴는 모두 customer·membership·organization이
null이고 department도 null이며 availablePaymentMethods·availableUsageTypes·personalPins·companyPins가 빈 배열이지만 lookupStatus로 구분한다.
탈퇴 고객을 자동 등록하거나 복구하지 않는다.

기본 출발지는 customer.name·phoneNumber·address를 우선 사용한다. 개인 PIN 또는 이전 주문의 이름으로 현재 고객 정보를 덮어쓰지 않는다. customer.address가 null이면 주소를 물어보거나 고객이 선택한 개인 PIN·이전 주소를 확인한다. 개인 PIN 등록은 기본 주소 사용의 전제 조건이 아니다.

개인 PIN 항목은 personalPinSeq·label·addressData·version이다. label은 null일 수 있으며 주소는 저장된 값 그대로 반환한다. 목록은 PIN 번호 오름차순이며 페이지 제한 없이 본인 항목 전체를 제공한다. 기업 배송지는 별도 검색 API의 customerSeq·membershipSeq와 addressData를 사용하며 PIN 번호를 만들지 않는다.

## 접근 범위

| 고객 | 소속 | 기업 | 이용 가능 범위 | PIN |
| --- | --- | --- | --- | --- |
| 미등록·WITHDRAWN | 무관 | 무관 | 없음 | 모두 빈 배열 |
| ACTIVE | 없음 | 없음 | PERSONAL | 본인 개인 PIN |
| ACTIVE | INACTIVE | 무관 | PERSONAL | 본인 개인 PIN |
| ACTIVE | ACTIVE | INACTIVE | PERSONAL | 본인 개인 PIN |
| ACTIVE | ACTIVE | ACTIVE | PERSONAL, COMPANY | 본인 개인 PIN |

ORG_ADMIN은 대표자 표시이며 MEMBER와 같은 주소록 범위를 사용한다.
같은 기업에 속한 다른 고객의 개인 PIN, 다른 기업의 PIN, 기업 디렉터리 전체는 반환하지 않는다.
개인 PIN은 주소의 연락처가 아니라 PIN 소유 고객으로 제한한다.
기업 간 공유 배송지는 [40번 디렉터리 API](company-directory.md)로 현재 사원 주소를 검색한다. 개인 PIN·기업 디렉터리 전체를 통화 초기 응답에 추가하지 않는다.

고객·소속·기업 상태와 개인 주소록을 하나의 SQL 문장으로 읽어 같은 시점의 데이터로 응답한다.
통화 저장이 있으면 이 조회와 같은 트랜잭션으로 처리한다. 조회가 실패하면 새 통화도 롤백한다.
새 통화를 생성한 경우에만 CALL_STARTED 감사를 같은 트랜잭션에 저장한다. AI는 AI로 기록하며 재요청·단순 조회에는 추가하지 않는다.
다음 조회는 최신 커밋된 상태를 반영하며 서버에 고객별 응답 캐시를 두지 않는다.
이전 통화의 초기 응답이 이후 주문 실행 권한을 보장하지 않으므로 주문 API의 실행 시점 검증은 유지한다.

## 오류와 AI 연동

- 잘못된 본문: 400 INVALID_REQUEST.
- 같은 providerCallId의 발신번호·수신 시각 불일치: 409 INVALID_STATE. 기존 통화는 변경하지 않는다.
- 유효하지 않은 관리자 쿠키: 401 UNAUTHORIZED. 관리자 쿠키가 있으나 허용 Origin이 없으면 403 FORBIDDEN.
- DB 조회 실패: 503 DEPENDENCY_UNAVAILABLE. 일부 데이터나 UNREGISTERED를 대신 반환하지 않는다.
- 공통 오류는 `{ error: { code, message, details }, meta: { requestId } }` 형식이다.

AI는 lookupStatus를 기준으로 등록 여부를 판단하고 조회 실패는 확인 불가로 처리한다.
현재 develop-ai의 `POST /internal/ai/callers/context`, `{ phone }`, `recent_order/places` 제안과는 계약이 다르다.
AI 담당자는 요청 경로·본문·data/meta 해석을 변경하고, callSessionSeq와 개인 PIN 원본 ID·version을 보관해야 한다. 기업 공유 배송지의 새 응답은 [AI 인계](../../backend/docs/company-address-directory-handoff.md)를 따른다.
대화 중 주소록 검색·등록·수정은 [39번 PIN API](pins.md)를 사용한다. version은 현재 값이며 수정 충돌 검사에는 사용하지 않는다.
최근 주문 조회는 별도 주문 조회 API로 처리한다. 실제 AI 코드 수정·통화 연동 검증은 이 작업에 포함하지 않는다.

## DB와 검증

customers·memberships·organizations·personal_pins·call_sessions 기존 테이블과 인덱스를 사용한다.
새 컬럼·테이블·마이그레이션·중복 처리 방지 키를 추가하지 않는다. 통화 중복은 기존 provider_call_id UNIQUE 제약을 사용한다.
주문 결과 전송도 동일한 통화 저장 코드를 사용한다. 먼저 만든 통화에 주문을 연결하며, 주문 없는 통화도 PBX 웹훅과 녹취를 연결할 수 있다.
Swagger는 `/api/docs` 및 `/api/docs-json`에서 활성화 설정에 따라 제공한다.

```powershell
cd backend
npm.cmd run check:docker
```

격리 PostgreSQL의 HTTP 통합 테스트로 고객 상태, 소속·기업 상태 조합, 대표자 범위,
타인 데이터 차단, 전체 PIN 반환, 상태 변경 반영, 입력 검증, 장애 응답과 로그 비노출을 검증한다.
통화 시작 후 기존 주문 조회·취소·PIN 수정, 통화 재요청·불일치·동시성, 주문 결과 연결, 조회 실패 롤백과 주문 없는 통화의 PBX/녹취 연결도 검증한다.
운영 이미지와 Nginx를 거친 MVP 조회도 검증한다. 실제 운영 서버 배포·AI 팀 연동 완료를 뜻하지 않는다.

## 028 내 주소·선택 부서

등록 고객의 customer.address는 PIN과 독립된 내 주소 객체 또는 null이다. 개인·기업 PIN 배열은 그대로다.
기업 소속이 있어도 membership.departmentSeq와 department는 null일 수 있다.
이 경우 COMPANY 사용과 활성 기업의 credit 자격은 유지하고 groupBilling은 제외한다.
