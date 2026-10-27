# 고객 등록 및 정보 관리 API

Jira: [S15P31D109-34](https://ssafy.atlassian.net/browse/S15P31D109-34).
구현은 모놀리식 `backend/src/customers/`에 두며 MSA는 변경하지 않는다.

## MVP 인증과 범위

2026-10-27 합의에 따라 고객 등록·상세·이름 수정에 AI 서비스 인증을 요구하지 않는다.
서버 간 호출에는 관리자 쿠키, Bearer 토큰, Origin, X-Call-Session-Id가 필요하지 않다.
이 세 작업만 명시적으로 `MvpAiCustomerAccess`를 사용한다. 기존 관리자·기업·PBX 인증은 유지한다.
서비스 인증 도입은 [S15P31D109-135](https://ssafy.atlassian.net/browse/S15P31D109-135)의 후속 작업이다.

고객 목록과 status 변경은 모든 ACTIVE 관리자 역할에 허용한다.
관리자 `dva_session` 쿠키를 보내면 실제 세션을 검증하며 잘못되거나 만료된 쿠키는
인증 없는 요청으로 전환하지 않고 401로 거절한다. 관리자 변경 요청에는 허용 Origin이 필요하다.
Origin이 없는 익명 status 변경 요청은 기존 Origin 검사에서 403, 허용 Origin만 있고
유효한 세션이 없는 요청은 401이다. 임의의 관리자 ID·AI 식별 헤더로 권한을 부여하지 않는다.

이 MVP는 익명 고객 ID 접근의 통화별 소유권을 검증하지 않는다. 발신번호 식별과 고객·기업·PIN
초기 데이터 제공(33번), 통화 시작·고객 연결, 실제 고객 본인인증은 별도 범위다.
고객 목록의 phoneNumber 검색은 관리자용이며 AI 발신번호 식별 API를 대체하지 않는다.

## HTTP 계약

| 메서드·경로 | 요청 | 성공 응답 |
| --- | --- | --- |
| POST /api/customers | `{ name, phoneNumber }`, Idempotency-Key UUID 필수 | 201, `{ data: { customerSeq }, meta: { requestId } }` |
| GET /api/customers | 관리자 세션, q·phoneNumber·status·limit·offset | 200, `{ data: Customer[], hasNext }` |
| GET /api/customers/{id} | 양의 PostgreSQL integer 범위 ID | 200, `{ data: Customer, meta: { requestId } }` |
| PATCH /api/customers/{id} | name 또는 관리자 전용 status 중 한 개 이상 | 204, 본문 없음 |

Customer는 `{ customerSeq, name, phoneNumber, status }`다. 주소록과 기업 소속을 포함하지 않는다.
조회·오류의 Cache-Control은 공통 `no-store`를 따른다.

이름은 앞뒤 공백을 제거하고 빈 문자열·null을 거절한다. 전화번호는 선행 0을 보존하는
숫자 문자열이며 하이픈·공백·`+`·숫자 타입을 거절한다. 자동 국가번호 변환이나 하이픈 제거는 하지 않는다.
신규 고객 상태는 ACTIVE이며 등록 본문의 status 등 추가 필드는 400이다.
PATCH의 phoneNumber, null, 빈 객체, 지원하지 않는 필드는 400이며 일부 필드만 저장하지 않는다.
대상이 없으면 404다. 실제 삭제와 전화번호 변경 API는 제공하지 않는다.

목록은 고객 번호 내림차순이다. limit 기본 20·범위 1~100, offset 기본 0이다.
q는 이름의 대소문자 무시 부분 검색이며 `%`·`_`도 문자 그대로 검색한다.
phoneNumber는 정확히 일치 검색하고 status는 ACTIVE/WITHDRAWN이다. 필터는 AND로 결합한다.
빈 목록은 `{ data: [], hasNext: false }`이며 meta·총건수·page 객체를 추가하지 않는다.

## 탈퇴 상태

관리자는 ACTIVE → WITHDRAWN으로 변경할 수 있다. WITHDRAWN → ACTIVE 복구는 409 INVALID_STATE다.
탈퇴 고객의 이름과 이력은 보존하며 관리자에게 목록·상세를 제공한다.
인증 없는 상세·이름 수정은 WITHDRAWN 고객을 404로 처리한다.
상태 변경으로 기존 주문·개인 PIN·기업 소속을 삭제하거나 상태를 일괄 변경하지 않는다.
탈퇴한 고객도 전화번호 고유성을 유지하므로 새 키로 같은 번호를 등록하면 409 DUPLICATE_RESOURCE다.

## 고객 등록 재시도

같은 등록 의도의 재시도는 같은 UUID Idempotency-Key와 같은 본문을 보낸다.
같은 키·정규화된 이름·전화번호는 원래 customerSeq를 HTTP 201로 반환한다.
키를 다른 내용에 재사용하면 422 IDEMPOTENCY_KEY_REUSED,
같은 키를 처리 중이면 409 REQUEST_IN_PROGRESS다. 409 처리 중 응답은 같은 키로 재시도한다.
다른 키로 이미 등록된 전화번호를 보내면 409 DUPLICATE_RESOURCE다.

MVP에는 인증된 AI 주체가 없으므로 키는 고객 등록 API 전체 범위에서 고유하다.
관리자·AI 요청 및 앱 인스턴스 간에도 같은 키를 공유한다. UUID 대소문자는 정규화한다.
`api_idempotency.customer_creations`에 UUID·요청 해시·고객 번호·생성 시각을 저장하며
이름·전화번호 원문이나 쿠키·토큰을 저장하지 않는다. 키는 인증 수단이 아니며 자동 만료는 두지 않는다.
인증 도입 시 호출자별 키 범위와 기존 기록 처리 방법을 함께 검토한다.

트랜잭션 advisory lock과 UUID PK, 고객 전화번호 UNIQUE 제약으로 동시성을 제어한다.
고객과 멱등 기록은 같은 PoolClient에서 함께 커밋하거나 롤백한다.
성공한 등록 응답은 재시작·이름 수정·탈퇴 이후에도 원래 번호를 반환하며 고객을 복구하지 않는다.
requestId는 HTTP 시도마다 달라질 수 있으며 멱등키를 대체하지 않는다.

## DB 적용과 검증

`backend/migrations/005-customer-creation-requests.sql`을 기존 migration runner로 적용한다.
001~004와 public 업무 테이블은 변경하지 않는다. 앱 시작은 기존 001만 적용하며,
Jenkins 배포에서 앱 교체 전에 migration과 스키마 검증을 수행한다.

```powershell
cd backend
npm.cmd run check:docker
cd ..
./infra/database/test-monolith.ps1
```

기존 Docker 검증에 고객 HTTP/DB 테스트를 연결한다. 입력·검색·권한·상태 전이,
동시 등록·키 충돌·재시작·실패 롤백, 실제 운영 이미지와 Nginx의 무인증 AI 호출 및
관리자 경계를 검사한다. DB runner는 신규 migration·제약·반복 적용·기존 데이터 보존·
백업 복원·체크섬 변경 거부·최초 및 후속 실패 롤백을 검사한다.
테스트는 임시 PostgreSQL만 사용한다. 이 문서는 실제 서버 적용이나 AI 팀 연동 완료를 뜻하지 않는다.

### 2026-10-27 검증 기록

- `node backend/scripts/check.cjs`: Linux Node.js 24에서 ESLint·Prettier·TypeScript 빌드와
  공통 단위/HTTP 13개, 인증·DB·PBX 31개, 기업 17개, 고객 10개, 운영 이미지/Nginx 6개로 총 77개 통과.
- `infra/database/test-monolith.ps1`: 005 신규 제약·기존 PBX 보존·반복 적용·백업 복원·
  적용 SQL 체크섬 변경 거부·최초/후속 실패 시 전체 미적용 migration 롤백 통과.
- Windows 샌드박스의 네이티브 HTTP 테스트는 loopback 연결 권한 오류로 실패하여,
  기존 Docker 검증기로 실제 Linux 환경에서 전체 검사를 완료했다.
- 운영 서버 migration·배포와 AI 팀의 실제 호출은 수행하지 않았다.

## AI 호출 예시

서버 호출은 Content-Type과 등록용 Idempotency-Key만 보내면 된다.

```http
POST /api/customers
Content-Type: application/json
Idempotency-Key: 98c97572-700c-4c1a-82ad-522e06259f61

{"name":"예시 고객","phoneNumber":"01012345678"}
```

201의 data.customerSeq를 이후 상세 조회·이름 수정에 사용한다.
관리자 목록·상태 변경은 기존 로그인 쿠키와 허용 Origin을 사용한다.
