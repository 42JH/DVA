# 기업명·상태 관리 API

Jira: [S15P31D109-35](https://ssafy.atlassian.net/browse/S15P31D109-35).
구현 위치는 `backend/src/organizations/`이며 모듈형 모놀리식 `backend/`만 대상으로 한다.

## 범위와 현재 연결 상태

기업은 구성원과 기업 공유 PIN의 소속 단위다. 기업 자체의 배송 주소·대표번호·공개 여부를 추가하지 않는다.
실제 배송 주소는 선택한 PIN에서 결정한다. 공식 공유 PIN의 외부 검색은 [40번 기업 디렉터리 API](company-directory.md)를 사용한다.
이 문서의 기업명·상태 관리 경로는 기존 관리자 권한을 유지한다.

기업명은 앞뒤 공백을 제거하고 빈 문자열을 거절한다. 동일 기업명은 허용하며 신규 상태는 ACTIVE다.
비활성화는 기업 상태만 바꾸며 구성원·PIN의 삭제나 일괄 상태 변경을 수행하지 않는다.
수정 버전 컬럼이 없는 현재 ERD를 따르므로 임의의 expectedVersion을 요구하지 않는다.

**인증은 83번에서 구현한 공통 세션 인증을 사용한다. 기업 모듈에 별도 로그인·인증 코드를 만들지 않는다.**
기업 Controller는 공통 `AuthRequest`의
`request.admin.adminUserSeq`와 Swagger의 `adminSession` 쿠키 정의를 사용한다.
OrganizationsModule을 AppModule에 등록하여 일반 앱 실행과 활성화된 Swagger에 기업 경로를 제공한다.
AuthModule의 전역 Guard가 네 경로 모두에서 로그인·현재 계정 상태와 변경 요청의 CSRF를 검증한다.
기업별 관리자 역할 제한은 추가하지 않는다. 테스트도 실제 AppModule을 실행하고 로그인 API가 발급한
쿠키를 사용하며 관리자 정보를 임의로 주입하지 않는다.
이 소스 변경만으로 서버 배포나 DB migration이 자동 적용되지는 않는다.

## HTTP 계약

모든 경로는 로그인 가능한 ACTIVE 관리자에게 허용한다. 관리자 역할별 추가 제한은 없다.
인증된 관리자 ID는 공통 세션 인증에서 제공해야 하며 요청 본문·query·임의의 관리자 ID 헤더로 받지 않는다.

| 메서드·경로 | 요청 | 성공 응답 |
|---|---|---|
| GET /api/companies | q, status, limit, offset | 200, `{ data: Organization[], hasNext }` |
| POST /api/companies | `{ name }` | 201, `{ data: { organizationSeq }, meta: { requestId } }` |
| GET /api/companies/{id} | 양의 PostgreSQL integer 범위 ID | 200, `{ data: Organization, meta: { requestId } }` |
| PATCH /api/companies/{id} | name 또는 status 중 한 개 이상 | 204, 본문 없음 |

Organization은 `{ organizationSeq, name, status }`다. 내부 주소록·구성원 정보는 조회하지 않는다.
삭제는 DELETE 대신 PATCH의 INACTIVE 상태 변경으로 처리한다. ACTIVE로 다시 변경할 수 있다.
목록은 기업 번호 내림차순, limit 기본 20·최대 100, offset 기본 0이다. 목록에 meta·page·총건수를 추가하지 않는다.
q는 대소문자를 구분하지 않는 기업명 부분 검색이며 `%`, `_`도 검색어 자체로 취급한다.
공백만 있는 q는 전체 조회다. status는 ACTIVE 또는 INACTIVE만 허용한다.

등록 본문에는 name만 허용한다. status·주소·관리자 ID 등 추가 필드는 400이다.
수정 본문에 null, 공백 기업명, 지원하지 않는 상태, 빈 객체를 전달하면 400이다.
대상이 없으면 404이며, 나머지 오류도 기존 error/meta 공통 형식을 따른다.

## 기업 등록 중복 처리

Idempotency-Key는 요구하거나 저장하지 않는다. 각 POST는 새로운 기업을 등록한다.
현재 ERD는 같은 기업명을 허용하며 사업자번호 컬럼이 없다. 기업명 UNIQUE는 추가하지 않는다.
관리자 화면은 처리 중 등록 버튼을 비활성화하고, 응답이 유실되면 목록을 확인한 뒤 다시 등록한다.
동일 요청의 자동 재시도는 지원하지 않는다. 기존 클라이언트가 보내는 Idempotency-Key는 무시한다.
기업 생성과 성공 감사는 같은 트랜잭션으로 커밋하거나 함께 롤백한다.

## 마이그레이션·검증

등록 API는 기존 organizations 테이블만 사용한다. 004는 과거 적용 이력으로 보존하며, 008에서 요청 기록 테이블을 제거한다. 배포·복구 절차는 [DB 문서](../database/README.md)를 따른다.

```powershell
cd backend
npm.cmd run check:docker
cd ..
./infra/database/test-monolith.ps1
```

Docker 검증은 기존 테스트와 기업 API HTTP/DB·독립 등록·재시작·감사 롤백·Swagger 계약 검증을 실행한다.
실제 로그인 세션으로 모든 ACTIVE 역할의 기업 등록·목록·상세·수정 성공과 미인증·위조·만료·로그아웃·
PENDING 계정 거절, Origin 없는 변경 거절을 확인한다. 운영 이미지와 실제 Nginx에서도 로그인 후
기업 생성·조회·수정 및 로그아웃 후 접근 거절을 검증한다.
별도 DB 검증은 migration 재실행, 체크섬 변경 거부, 백업 복원과 최초/후속 실패 롤백을 검증한다.
기존 배포 Jenkins 검증 실행기도 같은 npm test:integration을 사용한다.
기업 테스트는 기존 업무·세션 스키마를 사용하며 요청 기록 테이블에 의존하지 않는다.

## Postman으로 로컬 확인

개발 DB에 현재 migration을 순서대로 적용하고 테스트할 ACTIVE 관리자 계정을 준비한 뒤 앱을 실행한다.
초기 관리자 생성 방법은 [백엔드 README](../../backend/README.md)의 CLI 절차를 따른다.
실제 비밀번호나 세션 쿠키를 컬렉션·소스에 저장하지 않는다.

Postman 환경에 `baseUrl=http://localhost:3000`, `origin=http://localhost:5173`과 로그인 정보를 설정한다.
origin 값은 백엔드의 CORS_ORIGINS에 등록된 값과 같아야 한다.

1. `POST {{baseUrl}}/api/auth/login`을 JSON 본문
   `{ "loginId": "{{loginId}}", "password": "{{password}}" }`로 호출한다.
   헤더는 `Content-Type: application/json`, `Origin: {{origin}}`을 넣는다.
2. 응답의 `dva_session` 쿠키가 Postman 쿠키 저장소에 저장되면 같은 호스트의 기업 API를 호출한다.
   Bearer 토큰이나 관리자 ID 헤더는 필요하지 않다.
3. 등록은 `{ "name": "테스트 기업" }`만 보낸다. 중복 클릭과 자동 재전송은 하지 않는다.
4. 목록·상세는 GET으로, 수정은 PATCH와 `{ "name": "변경 기업", "status": "INACTIVE" }`로 확인한다.
   POST·PATCH에는 로그인 때와 동일한 Origin 헤더를 넣는다.
5. 로그아웃하거나 쿠키를 제거하면 기업 API가 401을 반환하는지 확인한다.

운영의 Secure 쿠키는 HTTPS에서만 사용한다. [자동 배포 파이프라인](../../infra/deploy/README.md)이
반영된 이후에는 Jenkins가 앱 교체 전에 미적용 migration을 실행한다. 서버에서 확인하려면 해당
소스를 배포하고 인증·기업 API의 호스트 Nginx 공개 경로도 설정해야 한다.
