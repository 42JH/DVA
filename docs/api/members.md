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

## HTTP 계약

| 메서드·경로 | 요청 | 성공 |
| --- | --- | --- |
| GET /api/companies/{id}/members | status, limit, offset | 200, `{ data: MemberView[], hasNext }` |
| POST /api/companies/{id}/members | `{ employeeNo, customerSeq, role }`, Idempotency-Key UUID | 204 |
| POST /api/companies/{id}/members/import | multipart/form-data의 file 1개, Idempotency-Key UUID | 204 |
| PATCH /api/members/{id} | role 또는 status 중 한 개 이상 | 204 |
| DELETE /api/members/{id} | 본문 없음 | 204 |

204 응답은 본문이 없다. ID는 양의 PostgreSQL integer 범위다. 목록은 membershipSeq 내림차순,
limit 기본 20·범위 1~100, offset 기본 0이다. 존재하지 않는 기업은 404이고 빈 기업은 빈 배열이다.
status는 ACTIVE/INACTIVE이며 활성·비활성 기업과 탈퇴 고객의 기존 소속도 관리자가 조회할 수 있다.

MemberView는 다음 형태다. 고객 이름·전화번호를 직접 변경하면 이후 목록에도 반영된다.

```json
{
  "membership": { "membershipSeq": 1, "customerSeq": 2, "organizationSeq": 3, "employeeNo": "001A", "role": "MEMBER", "status": "ACTIVE" },
  "customer": { "customerSeq": 2, "name": "예시 직원", "phoneNumber": "01012345678", "status": "ACTIVE" }
}
```

개별 등록은 ACTIVE 기업에 기존 ACTIVE 고객을 연결하고 소속 상태를 ACTIVE로 만든다.
고객 또는 기업이 없으면 404, 비활성 기업·탈퇴 고객은 409 INVALID_STATE다.
기존 소속이 있거나 기업·사번이 중복되면 409 DUPLICATE_RESOURCE다.
role은 MEMBER/ORG_ADMIN만 허용한다. 이름·전화번호·status 등 추가 등록 필드는 400이다.

PATCH는 role/status만 허용한다. 빈 객체·null·다른 필드는 400이다.
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
employeeNo,name,phoneNumber
001A,김민수,01012345678
002A,이지은,01023456789
```

헤더는 위 순서의 세 컬럼과 정확히 일치해야 한다. 사번·이름은 trim하고 빈 값은 거절한다.
전화번호는 숫자 문자열만 허용하며 선행 0을 유지한다. 번호의 공백·하이픈·국가번호 +는 자동 변환하지 않는다.
CSV 편집기에서 이미 잃어버린 선행 0은 복원하지 않는다.

- 같은 기업·사번: customerSeq·membershipSeq를 유지하며 고객 이름·전화번호를 수정한다.
  같은 값이면 갱신하지 않는다. 기존 대표자 표시·소속 상태는 유지한다.
- 새 사번·미등록 번호: ACTIVE 고객과 MEMBER/ACTIVE 소속을 함께 생성한다.
- 새 사번·소속 없는 ACTIVE 고객 번호: 기존 고객을 연결하고 이름을 반영한다.
- 다른 고객이 가진 번호로 기존 직원의 번호를 바꾸지 않는다. 고객을 병합하거나 번호를 빼앗지 않는다.
- 같은 기업의 다른 사번 또는 다른 기업 소속 고객은 자동 변경·이동하지 않는다.
- WITHDRAWN 고객은 신규 연결·갱신하지 않으며 자동 복구하지 않는다. 비활성 기업 업로드도 거절한다.
- 파일에 없는 직원은 삭제하지 않는다. 소속 해제는 DELETE로 명시적으로 수행한다.

파일 내 중복 사번·전화번호는 내용이 같아도 422다. 모든 행을 먼저 검증하고 한 트랜잭션으로
고객·소속·성공 감사·멱등 기록을 저장한다. 행 오류나 저장 실패가 하나라도 있으면 전체 롤백한다.
고객 연락처 변경은 이후 고객 조회·발신번호 조회의 원본에 반영되며 과거 주문의 연락처 스냅샷·PIN은 바꾸지 않는다.
고객의 일반 PATCH에서는 전화번호 변경 보류를 유지하고 관리자 CSV에서만 수정한다.
33번 발신번호 식별/초기 데이터 제공 API 자체는 별도 범위다.

## 오류와 동시성

| HTTP·code | 조건 |
| --- | --- |
| 400 INVALID_REQUEST | 파일 누락·파싱·헤더·DTO 오류 |
| 401 UNAUTHORIZED / 403 FORBIDDEN | 세션·현재 관리자 상태·Origin 거부 |
| 404 NOT_FOUND | 기업·고객·소속 없음 |
| 409 INVALID_STATE | 비활성 기업·탈퇴 고객 등록 또는 소속 활성화 |
| 409 DUPLICATE_RESOURCE | 개별 등록 고유 제약 또는 저장 시점의 고유 제약 충돌 |
| 409 REQUEST_IN_PROGRESS | 같은 키 또는 다른 구성원 변경 작업 처리 중 |
| 413 PAYLOAD_TOO_LARGE | 파일 크기·데이터 행 제한 초과 |
| 415 UNSUPPORTED_MEDIA_TYPE | 지원하지 않는 파일 또는 요청 형식 |
| 422 VALIDATION_FAILED | CSV 행 내용·고객·소속 충돌 |
| 422 IDEMPOTENCY_KEY_REUSED | 같은 키에 다른 기업·작업·내용 |

CSV 행 오류는 `error.details`의 field에 `rows[2].phoneNumber`처럼 헤더를 1로 센 CSV 레코드
번호를 사용한다. 따옴표 내부 줄바꿈은 새 레코드가 아니다. reason은 REQUIRED,
INVALID_PHONE_NUMBER, DUPLICATE_EMPLOYEE_NO, DUPLICATE_PHONE_NUMBER,
EMPLOYEE_NO_CONFLICT, OTHER_COMPANY_MEMBERSHIP, PHONE_NUMBER_CONFLICT,
CUSTOMER_WITHDRAWN이다. 이름·전화번호·CSV 원문은 오류·요청 로그·감사 metadata에 복사하지 않는다.

MVP에서는 트랜잭션 advisory try-lock으로 모든 구성원 변경을 직렬화한다. 다른 기업의
동시 업로드도 409 REQUEST_IN_PROGRESS가 될 수 있으며 잠시 후 재시도한다.
이 방식은 회사 간 동일 고객 연결·CSV 번호 변경 경합을 단순하게 처리한다. 대규모 동시 처리의
최적화는 이번 범위가 아니다. 기업·고객 행도 잠가 비활성화·탈퇴와 경합할 때 상태를 재검사한다.

개별 등록과 CSV는 관리자별 UUID 키 공간을 공유한다. 작업 종류·기업·정규화 본문 또는
CSV 파일 바이트의 해시를 비교하며 파일 이름·multipart boundary는 비교하지 않는다.
같은 키·같은 내용은 원래 204를 반환하고 성공 감사를 추가하지 않는다. 다른 관리자는 독립된 키 공간이다.
CSV 바이트가 다르면 줄바꿈/BOM 차이도 다른 내용이다. 다른 키로 같은 CSV를 재업로드해도
기업·사번 기준으로 갱신하여 중복 생성하지 않는다. 완료 기록은 재시작과 소속 해제 후에도 유지한다.
해제 후 과거 성공 키를 재시도해도 소속을 다시 만들지 않는다. 재등록에는 새 키를 사용한다.
자동 만료는 없다. api_idempotency.membership_writes에는 관리자·UUID·기업·작업·해시·시각만 저장한다.

## 감사·적용·검증

MEMBERSHIP_CREATED / MEMBERSHIP_UPDATED / MEMBERSHIP_REMOVED는 MEMBERSHIP 대상,
MEMBERS_IMPORTED는 ORGANIZATION 대상으로 기록한다. 성공은 업무와 같은 트랜잭션,
실패·거부는 기존 공통 실패 감사 경로를 사용한다. 감사는 작업 기록이며 완전한 소속 이력은 아니다.

기존 001~005·007·008은 변경하지 않고 009-membership-write-requests.sql을 기존 runner로 적용한다.
미배포 구성원용 006은 최신 develop-backend 병합 시 009로 이동했다. 008이 과거 생성 요청
스키마를 정리한 다음 009가 구성원 등록·CSV 전용 스키마와 테이블을 생성한다.
public 테이블 변경은 없다. 자동 배포의 migration·스키마 검증에 새 기록 테이블을 포함한다.
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

### 2026-10-27 검증 결과

- 최초 구성원 개발 검증의 `node backend/scripts/check.cjs`: Linux Node.js 24에서 ESLint·Prettier·TypeScript 빌드 및
  공통/CSV 17개, 인증·DB·PBX 31개, 기업 17개, 고객 10개, 구성원 22개,
  운영 이미지/Nginx 7개로 총 104개 테스트 통과.
- 구성원 검증: 관리자 인증·Origin·대표자 표시, 검색/페이지, 입력·상태 검증,
  소속 해제 후 타 기업 등록·원본 보존, CSV 번호 수정·기존 ID/표시/상태 보존,
  전체 검증·중복·소속/번호 충돌·동시 업로드·재시작·감사/멱등 실패 롤백,
  고객 탈퇴와의 경합 시 잠금 후 상태 재검사, Swagger 계약 통과.
- CSV 단위 검증: BOM·CRLF·따옴표·쉼표·필드 내 줄바꿈·오류 레코드 번호·원문 비노출,
  1MiB/1,000행 경계 통과. 실제 운영 이미지·Nginx에서도 정확히 1MiB 파일 성공 및 초과 거부 통과.
- `infra/database/test-monolith.ps1`: 009 제약·관리자별 키·소속 삭제 후 기록 보존·
  재실행·기존 데이터 보존·백업 복원·체크섬 변경 거부·최초/후속 실패 롤백 통과.
- 최신 develop-backend 병합 후 같은 두 검증 명령을 다시 실행하여 주문 생성·입력·최종 접수 준비
  검증을 포함한 전체 API 테스트와 운영 이미지·Nginx 검증 통과. 기존 007·008 SQL은 원본과 동일하게
  유지했으며, 008의 과거 요청 기록 제거 이후 009 구성원 기록 생성 순서도 임시 PostgreSQL에서 검증했다.
- 백엔드 운영 배포·DB 적용·프론트/AI 실제 연동은 수행하지 않았다. 호스트 Nginx 반영은 아래 후속 기록을 참고한다.

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
