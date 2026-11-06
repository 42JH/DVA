# DVA MSA 초기 Liquibase 마이그레이션

Jenkins 자동화의 실행 흐름과 연결 설정은 [MSA CI/CD](../README.md)를 따른다. 아래 서버 명령은 수동 운영 경로이며 CI/CD 실행과 동시에 사용하지 않는다.

2026-10-22 확정 MSA SQL을 기준으로 한 서비스별 초기 마이그레이션이다. 원본 경로와 체크섬은 source-manifest.json에 출처 기록으로 보존한다.
기존 backend/ 모놀리식과 독립적으로 관리한다. 관련 이슈: [S15P31D109-125](https://ssafy.atlassian.net/browse/S15P31D109-125).

| 서비스 | DB | Secret | 업무·이벤트·준비 테이블 | Liquibase 포함 |
|---|---|---|---:|---:|
| customer | customer_db | customer-db | 8 | 10 |
| order | order_db | order-db | 4 | 6 |
| consultation | consultation_db | consultation-db | 7 | 9 |
| delivery | delivery_db | delivery-db | 4 | 6 |
| operations | operations_db | operations-db | 13 | 15 |

현재 public 업무·보관 테이블 23개 + outbox/inbox 10개 + customer/consultation 감사 준비 2개 = 35개. Liquibase의 DATABASECHANGELOG와
DATABASECHANGELOGLOCK이 DB마다 추가되어 전체 public 테이블은 45개가 된다.
consultation의 비공개 `pbx_webhooks.call_ended_events` 1개를 포함하면 전체 46개다. 위 consultation 수는 이 수신함도 포함한다.
테이블뿐 아니라 원본의 인덱스, FK, CHECK, 함수, 트리거와 운영 초기 데이터도 포함한다.
초기 페르소나 2개와 편집용 프롬프트는 operations 007에서 legacy 테이블에 그대로 보존한다. 새 API의 설정 이력·초안과 ACTIVE/PENDING은 비어 있으며 구 프롬프트를 실제 상담 설정으로 자동 선택하지 않는다.

## 변경 관리

- operations `007`은 기존 identity/prompt·시퀀스·설정·불변 이력과 기존 SQL 활성화 함수를 legacy 이름으로 보존하고 새 페르소나 identity/불변 버전/초안 3개 테이블을 추가한다. 이전 001~006 이력·대기 이벤트와 행 값을 보존한다. 초기·업그레이드 제약 및 후반 SQL 실패 시 rename/함수/DDL/데이터/이력 전체 롤백을 검사한다. 과거의 전체 설정을 추정하거나 구 프롬프트를 자동 publish하지 않는다.

- consultation `003`은 PBX 수신함/claim과 통화 도착·등록·삭제 필드 및 활성 집계 인덱스를 추가한다. 기존 데이터/이력/대기 이벤트를 보존하고 실제 PBX 시작 시각만 누락된 도착 시각으로 사용한다. 근거 없는 과거 등록 시각은 NULL로 남긴다. 원본 047에서 폐기된 종료 사유는 새 API에서 사용하지 않지만 MSA의 과거 값은 보존하며 이관/실패 rollback을 검사한다.
- consultation `004`는 customer 소유 고객의 양수 논리 참조와 인덱스를 추가한다. 기존 통화의 고객은 추정하지 않고 NULL로 보존한다. 기존 통화·수신함·이벤트·이력과 후반 SQL 실패 시 롤백을 확인한다.

- 서비스별 초기 changeset 1개. 각 서비스 DB 안에서 원자적으로 실행한다.
- customer와 operations는 기존 `002`와 이벤트 전달용 `003`, 나머지는 이벤트 전달용 `002`도 포함한다. 각 changeset은 별도 트랜잭션이다.
- operations `004`는 관리자 이름·soft delete·9시간 세션·감사 이름 스냅샷과 INACTIVE 상태를 모놀리식 계약에 맞춘다. 이름 없는 기존 관리자 행이 있으면 데이터를 보존하고 적용을 중단한다. 실제 이름을 확인한 별도 마이그레이션 전에는 인증 앱을 배포하지 않는다.
- customer `004`는 기본 주소·월결제 자격·soft delete·부서·선택 부서 소속과 제약을 추가한다. 기존 고객/기업/소속/PIN/이벤트는 보존하며 근거 없는 과거 기업 생성 시각·기본 주소·부서 배정은 NULL로 남긴다. PIN 주소 규칙·버전은 변경하지 않는다. 003의 기존 데이터 업그레이드와 후속 SQL 실패 롤백도 검증한다.
- customer `005`는 기업 PIN의 부서·soft delete와 변경 시 버전 규칙을 추가한다. 원본 043처럼 양쪽 PIN 주소에서 latitude/longitude를 제거하므로 운영 적용 전 별도 백업이 필요하다. 변환 시 PIN 버전·소유권을 보존하고 유일하게 일치하는 부서명만 연결한다. SQL 후반 실패 시 주소·스키마·이력 전체 rollback도 검사한다.
- customer `006`은 개인 PIN의 soft delete·활성 주소 유일성과 보관 인덱스를 원본 045처럼 추가한다. 기존 PIN 소유권·주소·버전은 보존하고 삭제 시각을 추정하지 않는다. 이관 후반 실패 시 컬럼·인덱스·이력을 함께 롤백한다.
- customer `007`은 퇴역한 company_pins의 기존 행과 구버전 앱 호환성을 유지하며 보관 용도 주석만 추가한다. 새 앱은 기업 PIN을 읽거나 수정하지 않는다. DROP/rename하지 않으며 주석 처리 실패의 트랜잭션 롤백·기존 행/이력 보존도 검증한다.
- operations `005`는 customer 업무와 감사 확정을 연결하는 비공개 `customer_audit_preparations`를 추가한다. `006`은 consultation만 사용하는 별도 `consultation_audit_preparations`를 추가한다. customer 7개·operations 7개·consultation 4개 changeset이며 기존 적용 이력은 수정하지 않는다. customer의 기존 미확정 감사와 이력을 보존하고 006 후반 실패 시 전체 롤백을 검사한다.
- SQL의 바깥 BEGIN/COMMIT만 제거하고 runInTransaction=true로 Liquibase가 트랜잭션을 관리한다.
- splitStatements=false로 PostgreSQL 함수 본문의 세미콜론을 보존한다.
- 기존 업무 테이블이 있으면 초기 changeset을 HALT한다. 자동 삭제/덮어쓰기하지 않는다.
- 한번 적용한 changelog/SQL은 수정하지 않는다. 후속 변경은 새 changeset으로 추가한다.
- 자동 DROP rollback은 제공하지 않는다. 실패한 changeset은 DB 트랜잭션으로 되돌리고,
  이미 성공한 변경의 복구는 새 changeset 또는 검증된 백업 복원으로 처리한다.
- 서비스 5개를 묶는 분산 트랜잭션은 없다. 하나씩 결과를 확인한다.
- 원본 설계의 미확정 업무 정책과 앱 구현 과제는 architecture-contracts.txt에 남아 있다.

## 로컬 검증

Docker와 Python 3가 있는 PC에서 `msa/liquibase`로 이동한 뒤 `python verify.py`를 실행한다. 업무 검증 SQL은 tests/에 포함되어 있다.
임시 Docker network와 PostgreSQL 17.11 컨테이너만 만들며 기존 DB에 접속하지 않는다.
호스트 DB 포트를 공개하지 않고, 종료 시 해당 테스트 컨테이너와 네트워크를 제거한다.
검증 결과는 verification.json 및 verification-logs/에 저장된다.
SQL 원본 체크섬은 source-manifest.json에 기록했다.
운영 적용 이후 기존 SQL을 재생성하거나 수정하지 않는다.

## 이벤트 전달 후속 changeset

[S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)에서 기존 changeset을 보존하고 `shared/001-event-transport.sql`을 서비스별 새 changeset으로 참조한다. customer 메시지 테이블 2개와 전체 서비스의 outbox 순번·재시도 시각·시도 횟수·HTTP 상태·인덱스를 추가한다. 기존 대기 이벤트의 ID·본문·전달 상태와 적용 이력은 보존한다.

앱의 새 이벤트 런타임을 연결하기 전에 적용한다. 기존 앱은 추가 컬럼을 무시하며 이번 기반 MR은 업무 앱에 publisher/consumer를 등록하지 않는다. [런타임과 검증](../shared/events/README.md)을 참고한다. 새 설치뿐 아니라 5개 기존 서비스 DB의 업그레이드, customer/order의 신규 변경 실패 시 전체 changeset 롤백을 `verify.py`가 검사한다.

## 서버 준비 (운영 적용 전에 먼저 수행)

이 폴더의 Dockerfile, .dockerignore, changelog/, run-service.sh, ci-command.sh를
서버의 `/home/ubuntu/infra/liquibase/`로 복사한다. 비밀번호는 파일에 넣지 않는다.

```bash
cd ~/infra/liquibase
image=docker.io/library/dva-liquibase:5.0.4-pg42.7.14
sudo docker build --platform linux/amd64 -t "$image" .
(
  set -euo pipefail
  sudo docker save "$image" |
    sudo k3s ctr -n k8s.io images import -
)
bash -n run-service.sh
```

Liquibase Community 5.0.4와 PostgreSQL JDBC 42.7.14를 고정했다.
Community 5에는 JDBC 드라이버가 포함되지 않으므로 공식 Maven 배포본을 다운로드하고
공식 pgJDBC 다운로드에서 확인한 SHA-256과 대조한다. 이미지는 저장소에 업로드하지 않는다.

## 적용 순서

먼저 최근 S3 백업을 확인하고 서버의 업무 테이블 목록이 비어 있는지 확인한다.
기존 테이블이 있다면 changelog-sync나 DROP으로 우회하지 말고 별도 baseline 절차를 검토한다.

```bash
cd ~/infra/liquibase
image=docker.io/library/dva-liquibase:5.0.4-pg42.7.14
bash run-service.sh customer validate "$image"
bash run-service.sh customer update-sql "$image"
# SQL 검토 후 실제 적용:
bash run-service.sh customer update "$image"
bash run-service.sh customer status "$image"
```

customer 성공 후 order, consultation, delivery, operations를 각각 같은 순서로 진행한다.
update-sql은 변경 SQL 미리보기이며 실제 DDL 성공 검증을 대체하지 않는다.
validate도 변경 SQL 자체를 PostgreSQL에서 실행해 보는 검사는 아니다.
Liquibase 조회/잠금 관리 과정에서 관리 테이블이 생성될 수 있다.

각 실행은 dva 네임스페이스의 일회성 Job이다. service-db Secret의
PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD로 접속한다.
현재 DB 소유자인 service_app 계정을 사용하여 객체 소유권을 유지한다.
향후 런타임 계정에서 DDL 권한을 분리할 경우 소유권/GRANT 설계를 별도로 바꿔야 한다.
Job에는 Kubernetes API 권한을 주지 않고, 비밀번호를 명령 인자나 SQL에 기록하지 않는다.
Job은 자동 재시도하지 않고, 10분 제한과 완료 후 1일 TTL을 갖는다.

```bash
sudo k3s kubectl -n dva exec deployment/postgres -- \
  psql -U postgres -d customer_db -c \
  "SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public' ORDER BY tablename;"
```

## 범위 제한

실제 서버 적용, K3s Job 실행, 전체 서버 복구, Jenkins 연결은 로컬 통합 검증에 포함되지 않는다.
DB/사용자/Secret 생성과 데이터 복원은 이 마이그레이션이 담당하지 않는다.
K3s 노드가 늘어나면 같은 이미지를 각 대상 노드에 등록하거나 이미지 저장소를 도입해야 한다.
