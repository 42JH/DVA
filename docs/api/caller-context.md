# 발신번호 기반 고객 식별 및 초기 데이터 API

Jira: [S15P31D109-33](https://ssafy.atlassian.net/browse/S15P31D109-33).
구현은 모놀리식 `backend/src/customers/`에 둔다.

## 요청

```http
POST /api/customers/context
Content-Type: application/json

{"phoneNumber":"01012345678"}
```

PBX에서 전달받은 발신번호를 본문으로 보낸다. 숫자로만 이루어진 문자열이며 선행 0을 보존한다.
숫자 타입, 빈 문자열, 공백·하이픈·국가번호 `+`, 줄바꿈, null과 추가 필드는 400 INVALID_REQUEST다.
국가번호 변환 등 정규화는 호출 전에 수행한다. `phone`은 지원하지 않는다.
전화번호를 URL에 넣지 않도록 조회에도 POST를 사용한다.

MVP 합의에 따라 이 메서드만 서비스 인증을 면제한다. 관리자 쿠키, Bearer 토큰, Origin,
통화 ID, Idempotency-Key를 요구하지 않는다. 관리자 쿠키를 보낸 경우에는 유효한 세션과
허용 Origin이 필요하며, 만료되거나 잘못된 쿠키를 익명 호출로 전환하지 않는다.
허용되지 않은 브라우저 Origin은 기존 CORS에서 거절한다.

이 API는 발신번호의 DB 일치를 조회하며 전화번호 소유자의 본인인증은 수행하지 않는다.
서비스 인증·신뢰된 발신정보 검증은 [S15P31D109-135](https://ssafy.atlassian.net/browse/S15P31D109-135)의 후속 범위다.
고객 등록·통화 생성·고객과 통화 연결·최근 주문 조회·AI 설정 조회는 수행하지 않는다.
기존 명세 초안에서 CALL-01에 포함했던 고객 초기 조회를 별도로 제공한다.
이 문서의 경로는 모놀리식 AI 호출용이며 MSA 내부 API 구현을 의미하지 않는다.

## 성공 응답

HTTP 200, `{ data: CustomerContext, meta: { requestId } }` 형식이다.
응답과 오류에 `Cache-Control: no-store`를 적용한다.

```json
{
  "data": {
    "lookupStatus": "REGISTERED",
    "customer": {
      "customerSeq": 12,
      "name": "김철수",
      "phoneNumber": "01012345678",
      "status": "ACTIVE"
    },
    "membership": {
      "membershipSeq": 7,
      "customerSeq": 12,
      "organizationSeq": 3,
      "employeeNo": "0012",
      "role": "MEMBER",
      "status": "ACTIVE"
    },
    "organization": {
      "organizationSeq": 3,
      "name": "예시 기업",
      "status": "ACTIVE"
    },
    "availableUsageTypes": ["PERSONAL", "COMPANY"],
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
| lookupStatus | REGISTERED: 활성 등록 고객, UNREGISTERED: 해당 번호 없음, WITHDRAWN: 탈퇴 고객 |
| customer | 활성 고객의 기본 정보. 미등록·탈퇴 고객은 null |
| membership | 활성 고객의 현재 소속. 없으면 null. INACTIVE 소속도 상태를 함께 반환 |
| organization | 현재 소속 기업 정보. 소속이 없으면 null. INACTIVE 기업도 상태를 함께 반환 |
| availableUsageTypes | 현재 사용 가능한 PERSONAL·COMPANY 범위. 주소록 유무와 무관 |
| personalPins | 본인의 개인 PIN 전체. 없거나 고객이 비활성이면 빈 배열 |
| companyPins | 접근 가능한 소속 기업의 공유 PIN 전체. 없거나 접근 불가면 빈 배열 |

고객은 주문 이력이나 PIN이 없어도 REGISTERED다. 미등록과 탈퇴는 모두 customer·membership·organization이
null이고 availableUsageTypes·personalPins·companyPins가 빈 배열이지만 lookupStatus로 구분한다.
탈퇴 고객을 자동 등록하거나 복구하지 않는다.

개인 PIN 항목은 `personalPinSeq`, `label`, `addressData`, `version`이다.
기업 PIN 항목은 `companyPinSeq`, `label`, `departmentName`, `addressData`, `version`이다.
label과 departmentName은 null일 수 있다. addressData는 저장된 검증 주소 원문이며
detailAddress는 없거나 null·빈 문자열일 수 있다. 나머지 주소 필드는 예시의 타입을 따른다.
검색용 생성 컬럼 search_text는 노출하지 않는다.

각 PIN 목록은 해당 PIN 번호 오름차순이며 페이지 제한 없이 전체를 반환한다.
개인/기업 구분은 두 배열로 표현하며 출발지/도착지 kind를 임의로 만들지 않는다.
같은 PIN을 발송지나 도착지로 사용할지는 주문에서 선택한다.

## 접근 범위

| 고객 | 소속 | 기업 | 이용 가능 범위 | PIN |
| --- | --- | --- | --- | --- |
| 미등록·WITHDRAWN | 무관 | 무관 | 없음 | 모두 빈 배열 |
| ACTIVE | 없음 | 없음 | PERSONAL | 본인 개인 PIN |
| ACTIVE | INACTIVE | 무관 | PERSONAL | 본인 개인 PIN |
| ACTIVE | ACTIVE | INACTIVE | PERSONAL | 본인 개인 PIN |
| ACTIVE | ACTIVE | ACTIVE | PERSONAL, COMPANY | 본인 개인 PIN + 소속 기업 공유 PIN |

ORG_ADMIN은 대표자 표시이며 MEMBER와 같은 주소록 범위를 사용한다.
같은 기업에 속한 다른 고객의 개인 PIN, 다른 기업의 PIN, 기업 디렉터리 전체는 반환하지 않는다.
개인 PIN은 주소의 연락처가 아니라 PIN 소유 고객으로 제한한다.
기업 PIN에는 별도 비공개 상태 컬럼이 없으며 소속 기업의 공유 PIN만 대상으로 한다.
공식 공유 PIN의 타 기업 검색은 [40번 디렉터리 API](company-directory.md)로 제공하며 초기 응답의 소속 범위는 변경하지 않는다.

고객·소속·기업 상태와 두 주소록을 하나의 SQL 문장으로 읽어 같은 시점의 데이터로 응답한다.
다음 조회는 최신 커밋된 상태를 반영하며 서버에 고객별 응답 캐시를 두지 않는다.
이전 통화의 초기 응답이 이후 주문 실행 권한을 보장하지 않으므로 주문 API의 실행 시점 검증은 유지한다.

## 오류와 AI 연동

- 잘못된 본문: 400 INVALID_REQUEST.
- 유효하지 않은 관리자 쿠키: 401 UNAUTHORIZED. 관리자 쿠키가 있으나 허용 Origin이 없으면 403 FORBIDDEN.
- DB 조회 실패: 503 DEPENDENCY_UNAVAILABLE. 일부 데이터나 UNREGISTERED를 대신 반환하지 않는다.
- 공통 오류는 `{ error: { code, message, details }, meta: { requestId } }` 형식이다.

AI는 lookupStatus를 기준으로 등록 여부를 판단하고 조회 실패는 확인 불가로 처리한다.
현재 develop-ai의 `POST /internal/ai/callers/context`, `{ phone }`, `recent_order/places` 제안과는 계약이 다르다.
AI 담당자는 요청 경로·본문·data/meta 해석을 변경하고, PIN 원본 ID·version과 개인/기업 구분을 보관해야 한다.
대화 중 주소록 검색·등록·수정은 [39번 PIN API](pins.md)를 사용한다. version은 현재 값이며 수정 충돌 검사에는 사용하지 않는다.
최근 주문 조회는 별도 주문 조회 API로 처리한다. 실제 AI 코드 수정·통화 연동 검증은 이 작업에 포함하지 않는다.

## DB와 검증

customers·memberships·organizations·personal_pins·company_pins 기존 테이블과 인덱스를 사용한다.
새 컬럼·테이블·마이그레이션·중복 처리 방지 키를 추가하지 않는다. 반복 조회는 업무 데이터를 변경하지 않는다.
Swagger는 `/api/docs` 및 `/api/docs-json`에서 활성화 설정에 따라 제공한다.

```powershell
cd backend
npm.cmd run check:docker
```

격리 PostgreSQL의 HTTP 통합 테스트로 고객 상태, 소속·기업 상태 조합, 대표자 범위,
타인 데이터 차단, 전체 PIN 반환, 상태 변경 반영, 입력 검증, 장애 응답과 로그 비노출을 검증한다.
운영 이미지와 Nginx를 거친 MVP 조회도 검증한다. 실제 운영 서버 배포·AI 팀 연동 완료를 뜻하지 않는다.
