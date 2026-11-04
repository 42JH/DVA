# 이전 주문 기반 배송지 조회 — ADDR-02

관련 Jira: [S15P31D109-42](https://ssafy.atlassian.net/browse/S15P31D109-42).
모놀리식 `backend/src/orders/`에서 주문 당시 출발지·도착지 스냅샷을 조회한다.
AI 연동 작업은 [S15P31D109-43](https://ssafy.atlassian.net/browse/S15P31D109-43)이다.

## 요청

```http
GET /api/customers/12/addresses?direction=DESTINATION&from=2026-10-18T15:00:00Z&to=2026-10-25T15:00:00Z
call_session_seq: 31
```

예시는 한국 시간 2026-10-19 0시 이상, 2026-10-26 0시 미만의 주문이다.
조회 기준은 **주문 생성 시각(createdAt)** 이며 접수 완료·수거·배송 시각이 아니다.
AI가 ‘지난주’ 같은 표현을 정확한 기간으로 바꾸어 전달한다. 백엔드는 자연어 날짜를 해석하지 않는다.
시간대 오프셋 `+09:00`을 보낼 때는 URLSearchParams 등으로 `+`를 `%2B`로 인코딩한다.

| 파라미터 | 규칙 |
| --- | --- |
| id | customerSeq. 양의 PostgreSQL integer 범위 |
| direction | 필수. ORIGIN 또는 DESTINATION |
| from | 선택. 주문 생성 시각의 시작 경계, 포함 |
| to | 선택. 주문 생성 시각의 종료 경계, 미포함. from이 있으면 더 늦어야 함 |
| q | 선택. 선택한 방향의 이름·전화번호·도로명·지번·상세주소·동명·우편번호 부분 검색 |
| limit | 기본 20, 범위 1~100 |
| offset | 기본 0, 0 이상 정수 |

from·to는 시간대가 있는 ISO 8601이어야 하며 Z와 명시적 오프셋을 허용한다.
시작 또는 종료 경계 하나만 지정할 수도 있다. q는 앞뒤 공백·NFC를 정리하고 대소문자를 구분하지 않는다.
`%`·`_`는 일반 문자로 검색한다. 빈 검색어나 공백은 검색어 제한 없이 조회한다.
날짜·검색어·고객 조건은 AND이며 반대 방향의 주소나 PIN 별칭은 검색에 사용하지 않는다.
지원하지 않는 status·customerSeq 같은 추가 쿼리 필드는 400이다.

## 응답과 조회 대상

HTTP 200, `{ data: OrderAddress[], hasNext, total_count }` 형식이며 total_count를 포함하고 meta·page 객체는 추가하지 않는다.

```json
{
  "data": [
    {
      "orderSeq": 101,
      "orderParcelSeq": 201,
      "createdAt": "2026-10-20T01:00:00.000Z",
      "address": {
        "name": "예시 수령인",
        "phoneNumber": "01012345678",
        "roadAddress": "예시로 12",
        "jibunAddress": "예시동 12",
        "detailAddress": "101호",
        "dongName": "예시동",
        "postalCode": "01234",
        "latitude": 37.5,
        "longitude": 127
      }
    }
  ],
  "hasNext": false,
  "total_count": 1
}
```

- 접수 완료가 확인된 ACCEPTED 주문만 반환한다. COLLECTING·notPaid·PAID·SUBMITTING·SUBMISSION_FAILED·CANCELLED는 제외한다.
- 주문 생성 시각 내림차순, 주문 번호 내림차순, 상세 순번·상세 번호 오름차순으로 정렬한다.
- 페이지 단위는 주문 상세별 주소다. 같은 주소도 주문·상세가 다르면 각각 반환하며 합치지 않는다.
- 해당 방향의 도로명·지번이 모두 없는 과거 예외 행은 후보에서 제외한다. 나머지 원본의 null은 그대로 보존하고 없는 정보를 만들지 않는다.
- PIN 등록 여부와 무관하게 조회한다. 원본 PIN이 수정되어도 주문 당시 주소는 바뀌지 않는다.
- 주문의 ACCEPTED 여부를 사용하며 이후 배송 상태로 필터링하지 않는다. 배송 행이 없어도 주문 주소를 조회할 수 있다.
- 결과가 없으면 `{ "data": [], "hasNext": false, "total_count": 0 }`다. 실제 조회 실패는 오류로 반환하며 빈 성공으로 대체하지 않는다.

이 API는 신규 주문이나 PIN을 생성·수정하지 않는다. 선택한 주소를 현재 주문에 적용하고 고객에게
확인하는 것은 AI 호출 흐름의 역할이다. 주문 접수 후 AI가 개인 PIN 등록 API를 호출하는 흐름과도 독립적이다.
PIN 목록·검색·저장은 [주소록 API](pins.md), 일반 주문 목록·상세는 [주문 조회 API](order-read.md)를 사용한다.

## 접근 범위

관리자는 ACTIVE OPERATOR·SUPERVISOR·SYSTEM_ADMIN의 기존 `dva_session` 쿠키로 지정 고객의 이력을 조회한다.
GET이므로 Origin·통화 헤더가 필요하지 않다. 보관된 주문 확인을 위해 탈퇴 고객의 이력도 관리자에게 제공한다.

AI는 쿠키 없이 `call_session_seq`에 기존 DB 통화 번호를 전달한다. 진행 중인 통화의 발신번호로
확인된 ACTIVE 고객과 경로의 customerSeq가 같아야 한다. 같은 기업 소속이어도 다른 고객의 이력은 볼 수 없다.
관리자 쿠키를 보냈다면 실제 세션을 검사하고 만료·잘못된 쿠키를 AI 호출로 전환하지 않는다.
AI 서비스 인증은 MVP 합의에 따라 생략한다. 통화 번호는 인증 토큰이 아니며 본인인증을 제공하지 않는다.

통화의 고객 범위 확인과 주소 조회는 같은 읽기 전용 REPEATABLE READ 트랜잭션에서 수행한다.
조회 도중 상태나 데이터가 변경되어도 응답에 서로 다른 시점의 결과를 섞지 않는다. 다음 요청은 변경된 상태를 반영한다.

## 오류

| 상태·코드 | 조건 |
| --- | --- |
| 400 INVALID_REQUEST | ID·필터·날짜·범위 오류, AI 통화 헤더 누락·형식 오류 |
| 401 UNAUTHORIZED | 잘못되거나 만료된 관리자 쿠키 |
| 403 FORBIDDEN | AI 통화 고객 불일치·비활성 고객·발신번호 부재, 관리자 권한 또는 Origin 위반 |
| 404 NOT_FOUND | 통화 없음 또는 관리자가 지정한 고객 없음 |
| 409 INVALID_STATE | 종료된 통화로 AI 주소 이력 조회 |

성공·오류 모두 Cache-Control: no-store를 적용한다. 공통 요청 로그에는 경로 템플릿과 요청 ID만 사용하고
필터·전화번호·주소·응답 본문을 기록하지 않는다. 조회에는 Idempotency-Key를 요구하거나 저장하지 않는다.

## 검증과 연동

```powershell
cd backend
npm.cmd run check:docker
```

격리 PostgreSQL과 실제 NestJS HTTP로 접수 상태·출발/도착 분리·날짜 경계·시간대·검색·페이지·고객 범위·
PIN 독립성·동시 변경 스냅샷·입력 오류·읽기 전용·Swagger를 검사한다.
운영 이미지·실제 Nginx를 통해 응답 주소와 기존 주문 상세가 같은지, 통화 헤더와 세션 경계가 유지되는지도 검사한다.

기존 orders·order_parcels·customers·call_sessions를 사용하며 테이블·컬럼·마이그레이션을 추가하지 않는다.
외부 디버 API를 호출하지 않는다. 실제 운영 배포와 AI 클라이언트의 날짜 해석·후보 확인·주소 적용 연동은 별도다.


모든 목록 응답의 최상위 total_count는 필수인 0 이상 정수이며 같은 검색·필터·권한 범위의 전체 결과 수다. limit·offset 적용 전 COUNT(*)를 목록 데이터와 같은 SQL 스냅샷에서 계산한다. 검색 결과 없음은 0이며 offset이 전체 건수를 넘어 data가 비어도 total_count는 유지한다. 기존 hasNext는 유지한다.
