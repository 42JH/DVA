# 모놀리식 DB 마이그레이션

Jira: S15P31D109-129 · 브랜치: `feature/monolith-db` · MR 대상: `develop-backend`.

## 적용 기준

`monolith.dbml`은 사용자가 전달한 2026-10-25 최신 ERD 원본이다. 단일 PostgreSQL DB,
업무 테이블 18개와 관리자 세션 테이블 1개, FK 18개를 사용한다. 원본의 `service` 표기는 업무 영역을 구분하는 주석이다.
실제 모놀리식 배포 원본은 `backend/migrations/`이며 `msa/`는 적용하지 않는다.

- `001-pbx-call-ended.sql`: 기존 PBX 웹훅 수신 테이블. 기존 앱 시작 시의 생성 동작을 유지한다.
- `002-monolith-initial.sql`: 업무 테이블·제약·특수 인덱스·함수·생성 컬럼·트리거.
- `003-admin-auth-sessions.sql`: 관리자 이름과 PostgreSQL 세션 저장소. 기존 관리자 데이터가 있다면 이름 보완 정책이 필요하며 자동 채우지 않는다.
- `004-organization-creation-requests.sql`, `005-customer-creation-requests.sql`, `007-order-creation-requests.sql`: 과거 기업·고객·주문 생성 요청 기록. 적용 이력과 체크섬 보존을 위해 파일을 유지한다.
- `008-simplify-creation-requests.sql`: orders.creation_request_id UUID UNIQUE 추가 → 기존 주문 요청 키 이전 → 기업·고객·주문 요청 기록 테이블 및 api_idempotency 스키마 제거. 업무 데이터·주문 version·updated_at·감사·통화 연결·PBX 기록은 보존한다.
- `009-membership-write-requests.sql`: 과거 구성원 등록·CSV 처리 기록. 이미 적용된 원본·체크섬·이력을 그대로 보존한다.
- `010-remove-membership-write-requests.sql`: 구성원 요청 기록 테이블과 전용 스키마를 제거한다. 009를 포함한 기존 적용 이력과 고객·기업·소속·주문·감사·PBX 데이터는 보존한다.
- `011-call-recording-correlation.sql`: `call_sessions.incoming_at`에 OpenAI 이벤트 시각을 보관하고, 기존 PBX 수신함에 `call_session_seq`·`last_attempt_at`을 추가한다. 녹취 연결 고정과 재처리에 필요한 변경이며 테이블은 추가하지 않는다. 기존 행은 새 컬럼을 NULL로 유지한다.
- 과거 actor별 키가 서로 다른 주문에서 중복되거나 한 주문에 여러 키가 있으면 008 전체를 롤백하고 중단한다. 임의 키 재발급이나 주문 병합은 하지 않는다. 기존 생성 키가 없는 주문은 NULL을 유지하고 신규 API 생성은 키를 필수로 저장한다.
- 미완료 주문은 기존 orders·order_parcels의 COLLECTING 상태다. 별도 상담 테이블은 추가하지 않는다. MR 초안의 미배포 006-incomplete-consultations.sql은 제외했으며 운영 DROP/초기화는 수행하지 않는다.
- `db_migrations.applied_versions`: 파일명·SHA-256·적용 시각. 업무 테이블 18개와 별도다.
- `pbx_webhooks.call_ended_events`: 기존 연동 수신 테이블이며 업무 테이블 18개와 별도다.

고객 상태는 ACTIVE/WITHDRAWN, 기업 상태는 ACTIVE/INACTIVE, 관리자 상태는 ACTIVE/PENDING이다.
사번은 TEXT NOT NULL이며 기업별로 고유하다. 문자열 그대로 비교하므로 공백 제거·대소문자 통합,
CSV 갱신 방식은 API 구현 시 결정한다. `auth_version`과 기본 관리자 계정은 생성하지 않는다.

## 검증

Docker Desktop의 Linux 컨테이너 모드와 `postgres:17-alpine` 이미지가 필요하다.

```powershell
./infra/database/test-monolith.ps1
```

포트·호스트 볼륨·외부 네트워크 없이 tmpfs 기반 임시 DB를 사용한다. 기존 동명 검증 컨테이너가
있으면 중단한다. 검증 종료 시 이번 실행에서 만든 컨테이너만 정리한다. SQL 검증 데이터는 롤백한다.

검증 범위:

- public 테이블 19개·FK 18개·트리거 9개, 기존 PBX 데이터 보존.
- 고객·기업·관리자 상태값, 기업별 사번 중복·공백·NULL.
- 주소 검증·정규화된 PIN 중복 방지·검색용 생성 컬럼·PIN 소유권 및 버전.
- 주문 헤더·상세 변경 버전, 접수 후 상세 복사본 수정 방지, 주문 생성 UUID 유일성, 기존 요청 키 이전·업무 데이터 보존·키 충돌 거절·테이블 삭제 롤백.
- 통화 시각 제약, 녹취 객체 경로, 배송 참조 무결성·작업 주체 제약.
- 활성 프롬프트 최대 1개·기존 본문 수정 방지, FAQ 수정 시각·감사 JSON 객체.
- 마이그레이션 전 백업의 별도 DB 복원, 재실행 건너뛰기, 적용 파일 변조 거부.
- 후속 SQL 실패 시 신규 변경 전체 롤백, 최초 적용 실패 시 테이블·이력 전체 롤백.

검증 스크립트는 Docker 호스트용 runner를 테스트 컨테이너 안에서 실행하기 위해
`backend/database-tests/docker`를 해당 컨테이너의 임시 PATH에만 넣는다. 실제 서버에서는
실제 Docker CLI를 사용한다. 다른 환경의 PATH에 이 테스트 파일을 추가하지 않는다.

## 서버 적용

008·010은 구버전 앱이 사용하는 요청 기록 테이블을 삭제한다. 이 전환은 [릴리스 배포 절차](../../infra/deploy/README.md)에 따라
기존 백엔드 중지 → DB 백업 → migration/검증 → 새 앱 실행 순서로 적용한다. 아래 수동 runner만 실행해
구버전 앱을 계속 켜 두면 등록 API가 실패할 수 있다. 직접 적용할 때도 같은 중지·백업·앱 교체 순서를 지킨다.

서버에는 다음 구조를 가진 전용 적용 폴더를 전송한다. 앱 이미지·배포 릴리스는 변경하지 않는다.

```text
backend/migrations/*.sql
infra/database/migrate.sh
infra/database/verify.sql
docs/database/monolith.dbml
SHA256SUMS
```

전송 파일의 체크섬과 기존 서버 테이블을 먼저 확인한 뒤 실행한다. 비밀번호는 서버 DB 컨테이너의
환경변수를 사용하며 출력하지 않는다. DB 포트를 외부에 개방하지 않는다.

```sh
sha256sum -c SHA256SUMS
sudo sh infra/database/migrate.sh dva-prod-db-1 /home/ubuntu/dva-deploy/shared/db-backups
sudo docker exec -i dva-prod-db-1 sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < infra/database/verify.sql
```

runner는 먼저 권한 600인 PostgreSQL custom-format 백업과 SHA-256 파일을 만든다.
archive 목록 확인 후 advisory lock과 하나의 트랜잭션으로 미적용 migration을 실행한다.
동일 파일은 건너뛰고 이미 적용한 파일의 체크섬이 다르면 중단한다. SQL 오류 시 미커밋 변경은
전체 롤백된다. 기존 업무 테이블과 충돌하면 자동 삭제·덮어쓰기하지 않고 실패한다.

백엔드 자체는 시작 시 001만 실행한다. Jenkins 배포는 릴리스에 포함된 runner를 앱 교체 전에 실행한다.
일반 개발 배포는 `--no-backup`으로 DB 백업을 생략하며, 적용 이력·체크섬·트랜잭션은 유지한다.
008과 010의 최초 전환은 예외로 기존 백엔드를 중지하고 `shared/db-backups`에 백업한 뒤 실행한다.
마이그레이션 이후 `verify.sql` 검증까지 성공해야 새 앱을 시작한다. 앱을 직접 실행하는 경우에는 runner를 별도로 실행한다.

```sh
# 중지·백업이 필요한 008·010 전환을 제외한 개발 DB 적용
sudo sh infra/database/migrate.sh --no-backup dva-prod-db-1
```

위의 기존 수동 명령처럼 `--no-backup`을 생략하면 백업을 만드는 동작은 유지된다.

## 생성 중복 처리 기준

기업 등록은 독립 요청이며 같은 이름을 허용한다. 고객은 phone_number UNIQUE, 직원은 기업+사번, PIN은 기존 주소 UNIQUE를 사용한다. 기업·고객·구성원 개별 등록·CSV는 별도 요청 기록을 사용하지 않는다. 구성원 기록은 010으로 제거하며 개별 등록 중복은 고유 제약, CSV 재업로드는 기업·사번 기준 갱신으로 처리한다.
주문은 orders.creation_request_id와 통화 연결을 사용한다. 재시도는 기존 주문의 현재 버전을 반환하며 최초 본문·응답은 보관하지 않는다.
배송 상태 이력의 request_id, PBX 수신 기록, 기존 version·감사·세션 테이블은 유지한다.
57번 최종 접수는 기존 orders의 order_seq·status·version·updated_at을 사용한다. 주문 행을 잠근 뒤 SUBMITTING을 커밋한 요청만 외부로 전송한다. 재호출은 상태만 반환하며 별도 접수 키·컬럼·테이블·migration을 추가하지 않는다. 과거 cat 결제도 일괄 변경하지 않는다. 상세 계약은 [ORD-06](../api/order-submit.md)을 따른다.

## 이후 변경 및 복구

이미 적용한 SQL 파일을 수정하지 않고 다음 migration은 `012-설명.sql`부터 순서대로 추가한다.
체크섬은 파일의 실제 바이트를 사용한다. `.gitattributes`로 신규 migration의 줄바꿈을 LF로 고정하고,
기존 001은 최초 서버 적용 바이트와 같은 CRLF로 유지한다. 플랫폼 간 줄바꿈 변환으로 인한
허위 체크섬 불일치를 방지하기 위한 설정이다.
기존 데이터가 있는 필수 컬럼 추가는 nullable 추가 → 데이터 보완 → 제약 적용 순으로 진행한다.
상태 축소는 제거될 값의 현황과 변환 정책을 먼저 확인한다.

적용 중 실패하면 트랜잭션 롤백 후 원인을 수정한다. 성공 후에는 앱 이미지 롤백만으로 DB가
되돌아가지 않는다. 보완 migration을 우선 고려하고, 백업 복원이 필요하면 서비스를 정지하고
별도 DB에 복원·검증한 뒤 전환한다. 운영 DB에 `--clean`, 테이블 삭제 또는 볼륨 초기화를 실행하지 않는다.
008·010 적용 후에는 삭제된 테이블을 요구하는 구버전 앱 자동 복귀와 수동 롤백을 배포 스크립트에서 차단한다.
백업/SQL 실패로 해당 전환이 커밋되지 않았으면 중지한 기존 앱을 다시 시작한다. 전환이 커밋된 뒤 실패하면
API가 중지된 상태로 남을 수 있으므로 호환되는 앱을 재배포하거나 위 복구 절차를 수행한다.

```sh
# 별도 복구 DB를 먼저 생성한 뒤 실행. BACKUP은 서버 적용 기록의 경로로 지정한다.
sudo docker exec -i dva-prod-db-1 pg_restore --exit-on-error --no-owner -U dva -d monolith_restore_check < "$BACKUP"
```

## 업무 기능 구현과의 경계

주문의 허용 상태 전이·접수 시 필수 내용 검증, 디버 접수 재시도, 배송 상태와 이력의 원자적 저장,
인증·권한, CSV 업로드, 녹취 보관·삭제 작업은 관련 API에서 구현한다. 57번은 접수 결과·초기 배송·이력·감사를 함께 저장하며 결과 불명인 요청을 자동 재전송하지 않는다.
DB의 CHECK와 FK만으로 전체 업무 흐름이 완성되는 것은 아니다.

주문 저장 방식은 사용자가 재확정한 ORD-01 → ORD-04 → ORD-06 계약을 따른다. Jira 55의 별도 상담 스냅샷 설명과는 충돌하며, 구현 기준은 docs/api/orders.md에 명시한다. 통화 식별자 연결은 AI 연동에서 확인해야 한다.

관리자 세션 검증은 이름 필수·공백 거절, 토큰 해시·만료 시각·FK 제약, 관리자별 세션 삭제와 계정 삭제 cascade를 포함한다.
003은 기존 관리자 행이 없는 DB를 전제로 한다. 운영 데이터가 있으면 사전 검토 후 이름 보완 migration으로 조정해야 한다.
