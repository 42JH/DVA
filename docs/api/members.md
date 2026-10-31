# 기업 구성원 및 전화번호 관리 API

Jira: [S15P31D109-37](https://ssafy.atlassian.net/browse/S15P31D109-37).
모놀리식 `backend/src/members/` 구현이며 고객·기업·소속의 기존 public 스키마를 사용한다.

## 인증과 대표자 표시

모든 경로는 기존 `dva_session`으로 인증하며 모든 ACTIVE 관리자 역할에 허용한다.
POST·PATCH·DELETE에는 설정된 허용 Origin이 필요하다. AI 무인증 예외는 적용하지 않는다.
`MEMBER`는 일반 구성원, 기존 DB 값 `ORG_ADMIN`은 대표자 표시다. 대표자에게 관리자 웹 계정이나
추가 API 권한을 부여하지 않는다. 고객은 이름·전화번호의 원본이며 memberships에 중복 저장하지 않는다.

고객당 소속 행은 최대 1개이고 INACTIVE 행도 이 제약에 포함된다. 사번은 기업 내 고유하며
앞뒤 공백만 제거하고 선행 0·대소문자는 보존한다. 다른 기업의 같은 사번은 허용한다.
등록 후 사번·기업·고객 ID는 변경하지 않는다. 소속 이동은 기존 소속 해제 후 새로 등록한다.

부서 등록·조회·그룹결제 자격은 [부서 API](departments.md)를 사용한다. 기존 구성원의 이관에는 실제 부서 배정표가 필요하며 임의 부서는 만들지 않는다.

## HTTP 계약

| 메서드·경로 | 요청 | 성공 |
| --- | --- | --- |
| GET /api/companies/{id}/members | status, limit, offset | 200, `{ data: MemberView[], hasNext, total_count }` |
| POST /api/companies/{id}/members | `{ employeeNo, customerSeq, departmentSeq, role }` | 204 |
| POST /api/companies/{id}/members/import | multipart/form-data의 file 1개 | 204 |
| PATCH /api/members/{id} | role·status·departmentSeq 중 한 개 이상 | 204 |
| DELETE /api/members/{id} | 본문 없음 | 204 |

204 응답은 본문이 없다. ID는 양의 PostgreSQL integer 범위다. 목록은 membershipSeq 내림차순,
limit 기본 20·범위 1~100, offset 기본 0이다. 존재하지 않는 기업은 404이고 빈 기업은 빈 배열이다.
status는 ACTIVE/INACTIVE이며 활성·비활성 기업과 탈퇴 고객의 기존 소속도 관리자가 조회할 수 있다.

MemberView는 다음 형태다. 고객 이름·전화번호를 직접 변경하면 이후 목록에도 반영된다.

```json
{
  "membership": { "membershipSeq": 1, "customerSeq": 2, "organizationSeq": 3, "departmentSeq": 5, "employeeNo": "001A", "role": "MEMBER", "status": "ACTIVE" },
  "customer": { "customerSeq": 2, "name": "예시 직원", "phoneNumber": "01012345678", "status": "ACTIVE" }
}
```

개별 등록은 ACTIVE 기업에 기존 ACTIVE 고객을 연결하고 소속 상태를 ACTIVE로 만든다.
고객 또는 기업이 없으면 404, 비활성 기업·탈퇴 고객은 409 INVALID_STATE다.
기존 소속이 있거나 기업·사번이 중복되면 409 DUPLICATE_RESOURCE다.
role은 MEMBER/ORG_ADMIN만 허용한다. 이름·전화번호·status 등 추가 등록 필드는 400이다.

PATCH는 role/status/departmentSeq를 허용한다. 같은 기업의 실제 부서 번호가 필수이며 기업이 다른 부서는 거절한다. 빈 객체·null·다른 필드는 400이다.
소속 활성화는 기업과 고객이 모두 ACTIVE일 때만 허용한다. 비활성화와 대표자 표시 변경은
기존 데이터를 삭제하지 않는다. DELETE는 memberships 연결 행만 실제 삭제하며 다른 기업으로
재등록할 수 있게 한다. 고객·개인 PIN·주문·기업 공유 PIN은 보존하며 별도 소속 이력 테이블은 두지 않는다.

## CSV 등록·갱신

기업을 먼저 등록하거나 선택한 뒤 해당 기업 경로에 업로드한다. 기존 기업 등록 API는 변경하지 않는다.
UTF-8(BOM 허용), 파일 1개, 최대 1MiB(1,048,576바이트)·1,000개 데이터 레코드다.
파일 이름은 .csv이고 text/csv, application/csv, application/vnd.ms-excel,
application/octet-stream, text/plain MIME을 허용한다. 실제 UTF-8·CSV 구조도 검증한다.
파일 필드 외 multipart 텍스트 필드는 거절한다. 추가 컬럼·빈 중간 레코드·잘못된 따옴표는 400이다.
따옴표 안 쉼표·줄바꿈·이스케이프 따옴표, LF/CRLF를 지원한다.

```csv
employeeNo,name,phoneNumber,departmentSeq
001A,김민수,01012345678,5
002A,이지은,01023456789,6
```

헤더는 위 순서의 네 컬럼과 정확히 일치해야 한다. 사번·이름은 trim하고 빈 값은 거절한다.
전화번호는 숫자 문자열만 허용하며 선행 0을 유지한다. 번호의 공백·하이픈·국가번호 +는 자동 변환하지 않는다.
CSV 편집기에서 이미 잃어버린 선행 0은 복원하지 않는다.

- 같은 기업·사번: customerSeq·membershipSeq를 유지하며 고객 이름·전화번호·소속 부서를 수정한다.
  같은 값이면 갱신하지 않는다. 기존 대표자 표시·소속 상태는 유지한다.
- 새 사번·미등록 번호: ACTIVE 고객과 MEMBER/ACTIVE 소속을 함께 생성한다.
- 새 사번·소속 없는 ACTIVE 고객 번호: 기존 고객을 연결하고 이름을 반영한다.
- 다른 고객이 가진 번호로 기존 직원의 번호를 바꾸지 않는다. 고객을 병합하거나 번호를 빼앗지 않는다.
- 같은 기업의 다른 사번 또는 다른 기업 소속 고객은 자동 변경·이동하지 않는다.
- WITHDRAWN 고객은 신규 연결·갱신하지 않으며 자동 복구하지 않는다. 비활성 기업 업로드도 거절한다.
- 파일에 없는 직원은 삭제하지 않는다. 소속 해제는 DELETE로 명시적으로 수행한다.

파일 내 중복 사번·전화번호는 내용이 같아도 422다. 모든 행을 먼저 검증하고 한 트랜잭션으로
고객·소속·성공 감사를 저장한다. 행 오류나 저장 실패가 하나라도 있으면 전체 롤백한다.
고객 연락처 변경은 이후 고객 조회·발신번호 조회의 원본에 반영되며 과거 주문의 연락처 스냅샷·PIN은 바꾸지 않는다.
고객의 일반 PATCH에서는 전화번호 변경 보류를 유지하고 관리자 CSV에서만 수정한다.
발신번호 식별과 고객·소속·허용 PIN 초기 데이터는 [33번 API](caller-context.md)를 사용한다.

## 오류와 동시성

| HTTP·code | 조건 |
| --- | --- |
| 400 INVALID_REQUEST | 파일 누락·파싱·헤더·DTO 오류 |
| 401 UNAUTHORIZED / 403 FORBIDDEN | 세션·현재 관리자 상태·Origin 거부 |
| 404 NOT_FOUND | 기업·고객·소속 없음 |
| 409 INVALID_STATE | 비활성 기업·탈퇴 고객 등록 또는 소속 활성화 |
| 409 DUPLICATE_RESOURCE | 개별 등록 고유 제약 또는 저장 시점의 고유 제약 충돌 |
| 409 REQUEST_IN_PROGRESS | DB 잠금 획득 대기 2초 초과. 이번 변경 전체 롤백 |
| 413 PAYLOAD_TOO_LARGE | 파일 크기·데이터 행 제한 초과 |
| 415 UNSUPPORTED_MEDIA_TYPE | 지원하지 않는 파일 또는 요청 형식 |
| 422 VALIDATION_FAILED | CSV 행 내용·고객·소속 충돌 |

CSV 행 오류는 `error.details`의 field에 `rows[2].phoneNumber`처럼 헤더를 1로 센 CSV 레코드
번호를 사용한다. 따옴표 내부 줄바꿈은 새 레코드가 아니다. reason은 REQUIRED,
INVALID_PHONE_NUMBER, DUPLICATE_EMPLOYEE_NO, DUPLICATE_PHONE_NUMBER,
EMPLOYEE_NO_CONFLICT, OTHER_COMPANY_MEMBERSHIP, PHONE_NUMBER_CONFLICT,
CUSTOMER_WITHDRAWN이다. 이름·전화번호·CSV 원문은 오류·요청 로그·감사 metadata에 복사하지 않는다.

MVP에서는 트랜잭션 advisory lock으로 모든 구성원 변경을 직렬화한다. 다른 기업의 동시
업로드도 앞선 변경이 끝날 때까지 기다린 뒤 같은 요청을 이어서 처리한다.
등록·수정·소속 해제는 고객을 먼저 잠그고, 필요한 기업·소속을 이후에 잠근다.
CSV는 대상 고객 번호 순으로 잠근 뒤 기업을 확인하고 소속을 저장한다. 주문의 고객 잠금과
반대 순서로 기업·소속을 선점하지 않아 교착을 피한다. 대기 후 최신 상태·중복 조건을 재검사한다.
각 잠금 획득은 최대 2초 기다린다. 초과하면 이번 변경·성공 감사를 모두 롤백하고
409 REQUEST_IN_PROGRESS를 반환한다. 요청 전체의 실행 시간이 2초로 제한되는 것은 아니다.
DB 구조·요청/응답 필드는 바뀌지 않으며 별도 대기 테이블·Redis는 추가하지 않는다.

개별 등록과 CSV는 Idempotency-Key를 요구·검증·저장하지 않는다. 기존 클라이언트가 보내는 헤더도 무시한다.
개별 등록의 중복은 고객당 소속 1개·기업별 사번 UNIQUE로 거절하며 409 DUPLICATE_RESOURCE를 반환한다.
CSV는 기업·사번을 기준으로 기존 고객 정보를 갱신하고 새 직원을 등록한다. 같은 파일을 다시 올려도
고객·소속 행을 중복 생성하지 않으며 성공한 각 업로드는 별도 감사로 기록한다.
최초 요청·응답을 재생하거나 과거 업로드인지 판별하지 않는다. 재업로드는 현재 요청의 내용을 적용한다.
소속 해제 후 재등록도 새 요청 키 없이 처리한다.

## 감사·적용·검증

MEMBERSHIP_CREATED / MEMBERSHIP_UPDATED / MEMBERSHIP_REMOVED는 MEMBERSHIP 대상,
MEMBERS_IMPORTED는 ORGANIZATION 대상으로 기록한다. 성공은 업무와 같은 트랜잭션,
실패·거부는 기존 공통 실패 감사 경로를 사용한다. 감사는 작업 기록이며 완전한 소속 이력은 아니다.

앱은 기존 업무 테이블을 사용하고 별도 구성원 요청 기록에 의존하지 않는다.
이미 적용된 009 파일·체크섬·적용 이력을 보존하고, 새 010-remove-membership-write-requests.sql에서
membership_writes 테이블과 전용 스키마를 제거한다. 009 적용 이력은 삭제하지 않고 010을 추가한다.
010 최초 적용은 기존 백엔드 중지 → DB 백업 → 자동 migration·검증 → 새 앱 실행 순서다.
010이 커밋된 후 요청 기록을 사용하는 구버전 앱으로의 수동·자동 복귀는 차단한다.
내부 Nginx와 호스트 HTTPS 설정의 /api/ 본문 제한을 2MiB로 맞춰 multipart 헤더 공간을 확보한다.
앱은 파일 자체를 1MiB로 제한한다. 호스트 설정은 앱 배포로 자동 갱신되지 않으므로 기존 서버
설정에 해당 제한만 반영하고 nginx -t 후 reload해야 한다. 다른 팀 설정을 전체 덮어쓰지 않는다.

```powershell
cd backend
npm.cmd run check:docker
cd ..
./infra/database/test-monolith.ps1
```

검증은 임시 DB·로컬 Docker에서 수행하며 운영 DB 적용·서버 배포·프론트/AI 실제 호출은 별도다.

### 요청 키 제거 검증

- `node backend/scripts/check.cjs`: 최신 develop-backend의 주문 조회 작업을 포함하여 정적 검사·빌드와
  단위 26개, 인증·DB·PBX 31개, 기업 14개, 주문 31개, 고객 10개, 구성원 22개,
  운영 이미지·Nginx 8개로 총 142개 테스트 통과.
- 키 없는 개별 등록·CSV, 기존 키 헤더 무시, 중복 개별 등록 409, 소속 해제 후 재등록 통과.
- API 통합 테스트는 membership_writes가 없는 DB에서 실행하여 과거 테이블 의존 제거를 검증했다.
- CSV 재업로드의 ID 보존·각 성공 요청의 감사, 동시 요청 제약, 감사 실패 시 전체 롤백 통과.
- 기존 고객·기업·주문 API, 운영 이미지·Nginx 업로드 제한 회귀 검증 통과.
- `infra/database/test-monolith.ps1`: 001~009 원본 보존과 신규 010 적용·기존 이력 보존·업무 데이터 보존·백업 복원·실패 롤백 통과.
- 배포 모의 테스트: 010 최초 적용 시 중지·백업 순서, 백업·SQL 실패 시 기존 앱 복구,
  010 커밋 후 검증·앱 실패 시 구버전 복귀 차단 통과. Linux 패키징에서 009 원본·010 포함과 체크섬 검증 통과.
- 서버에서는 적용 이력과 테이블 존재 여부만 읽었다. 코드 배포·운영 DB 변경은 수행하지 않았다.

### 2026-10-27 호스트 Nginx 후속 반영

- 사용자 요청으로 Lightsail IP HTTPS의 `/etc/nginx/sites-available/dva-ip`에서 `/api/` 블록에만
  `client_max_body_size 2m`을 추가했다. 원본 백업은
  `/etc/nginx/sites-available/dva-ip.backup-upload-limit-20261027T035158Z`다.
- `nginx -t`·reload·서비스 active 확인 통과. HTTPS health 200, backend health 200,
  외부 readiness 404, 미인증 기업 목록 401을 유지했다.
- DB 쓰기가 없는 64KiB OPTIONS 요청이 변경 전 413에서 변경 후 204로 통과했다.
  2MiB 초과 Content-Length 요청은 호스트에서 413으로 거절됨을 확인했다.
- 현재 실행 중인 컨테이너 Nginx는 별도 크기 설정이 없고 1MiB 초과 요청을 413으로 거절한다.
  이 브랜치의 내부 Nginx 2MiB 설정은 37번 배포 시 자동 반영된다. 파일 1MiB에 multipart
  헤더를 더한 실제 최대 크기 업로드는 이 컨테이너 설정도 반영된 뒤 가능하다.
- 이번 후속 작업은 호스트 설정에 한정하며 앱·DB·컨테이너 배포는 수행하지 않았다.


모든 목록 응답의 최상위 total_count는 필수인 0 이상 정수이며 같은 검색·필터·권한 범위의 전체 결과 수다. limit·offset 적용 전 COUNT(*)를 목록 데이터와 같은 SQL 스냅샷에서 계산한다. 검색 결과 없음은 0이며 offset이 전체 건수를 넘어 data가 비어도 total_count는 유지한다. 기존 hasNext는 유지한다.
