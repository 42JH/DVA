# 모놀리식 DB 마이그레이션

Jira: S15P31D109-129 · 브랜치: `feature/monolith-db` · MR 대상: `develop-backend`.

## 적용 기준

`monolith.dbml`은 사용자가 전달한 2026-10-25 최신 ERD 원본이다. 단일 PostgreSQL DB,
업무 테이블 18개, FK 17개를 사용한다. 원본의 `service` 표기는 업무 영역을 구분하는 주석이다.
실제 모놀리식 배포 원본은 `backend/migrations/`이며 `msa/`는 적용하지 않는다.

- `001-pbx-call-ended.sql`: 기존 PBX 웹훅 수신 테이블. 기존 앱 시작 시의 생성 동작을 유지한다.
- `002-monolith-initial.sql`: 업무 테이블·제약·특수 인덱스·함수·생성 컬럼·트리거.
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

- 테이블 18개·FK 17개·트리거 9개, 기존 PBX 데이터 보존.
- 고객·기업·관리자 상태값, 기업별 사번 중복·공백·NULL.
- 주소 검증·정규화된 PIN 중복 방지·검색용 생성 컬럼·PIN 소유권 및 버전.
- 주문 헤더·상세 변경 버전, 접수 후 상세 복사본 수정 방지.
- 통화 시각 제약, 녹취 객체 경로, 배송 참조 무결성·작업 주체 제약.
- 활성 프롬프트 최대 1개·기존 본문 수정 방지, FAQ 수정 시각·감사 JSON 객체.
- 마이그레이션 전 백업의 별도 DB 복원, 재실행 건너뛰기, 적용 파일 변조 거부.
- 후속 SQL 실패 시 신규 변경 전체 롤백, 최초 적용 실패 시 테이블·이력 전체 롤백.

검증 스크립트는 Docker 호스트용 runner를 테스트 컨테이너 안에서 실행하기 위해
`backend/database-tests/docker`를 해당 컨테이너의 임시 PATH에만 넣는다. 실제 서버에서는
실제 Docker CLI를 사용한다. 다른 환경의 PATH에 이 테스트 파일을 추가하지 않는다.

## 서버 적용

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

백엔드는 여전히 시작 시 001만 실행한다. 신규 migration을 자동 적용하도록 앱을 변경하지 않았다.
새 서버에서도 업무 API 실행 전에 이 runner를 별도로 실행해야 한다.

## 이후 변경 및 복구

이미 적용한 SQL 파일을 수정하지 않고 `003-설명.sql`부터 순서대로 추가한다.
체크섬은 파일의 실제 바이트를 사용한다. `.gitattributes`로 신규 migration의 줄바꿈을 LF로 고정하고,
기존 001은 최초 서버 적용 바이트와 같은 CRLF로 유지한다. 플랫폼 간 줄바꿈 변환으로 인한
허위 체크섬 불일치를 방지하기 위한 설정이다.
기존 데이터가 있는 필수 컬럼 추가는 nullable 추가 → 데이터 보완 → 제약 적용 순으로 진행한다.
상태 축소는 제거될 값의 현황과 변환 정책을 먼저 확인한다.

적용 중 실패하면 트랜잭션 롤백 후 원인을 수정한다. 성공 후에는 앱 이미지 롤백만으로 DB가
되돌아가지 않는다. 보완 migration을 우선 고려하고, 백업 복원이 필요하면 서비스를 정지하고
별도 DB에 복원·검증한 뒤 전환한다. 운영 DB에 `--clean`, 테이블 삭제 또는 볼륨 초기화를 실행하지 않는다.

```sh
# 별도 복구 DB를 먼저 생성한 뒤 실행. BACKUP은 서버 적용 기록의 경로로 지정한다.
sudo docker exec -i dva-prod-db-1 pg_restore --exit-on-error --no-owner -U dva -d monolith_restore_check < "$BACKUP"
```

## 업무 기능 구현과의 경계

이번 작업은 스키마 구축이다. 주문의 허용 상태 전이·접수 시 필수 내용 검증, 디버 접수 재시도,
배송 상태와 이력의 원자적 저장, 인증·권한, CSV 업로드, 녹취 보관·삭제 작업은 관련 API에서 구현한다.
DB의 CHECK와 FK만으로 전체 업무 흐름이 완성되는 것은 아니다.

통화 `provider_call_id` 계약과 주문 저장 방식에 관한 기존 Jira 설명과 ERD 차이도 별도 합의가 필요하다.
이 작업에서 새로운 상태나 중도 종료 상담 테이블을 임의로 추가하지 않는다.
