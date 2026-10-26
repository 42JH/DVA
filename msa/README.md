# MSA CI/CD

Jenkins의 Linux 빌드 노드에서 검증하고, MSA 서버 `k15d109.p.ssafy.io`의 k3s에 배포한다. 모놀리식 `backend/`와 루트 `Jenkinsfile`은 별개다.

현재 구현 범위는 5개 서비스 DB의 Liquibase CI/CD와 customer NestJS 서비스의 테스트·이미지 빌드다. 애플리케이션의 k3s 배포는 아직 연결하지 않았다.

자동 실행에서는 마지막 성공 빌드의 커밋과 비교해 검사 범위를 결정한다. `msa/liquibase/` 변경은 전체 DB 검사와 이미지 패키징을 실행하고, `msa/services/<서비스>/` 변경은 해당 서비스의 테스트와 이미지 빌드만 실행한다. 두 경로 외의 MSA 변경은 공통 변경으로 취급해 전체 검사한다. 수동 실행, 명시적 DB 배포 실행, 비교 이력이 없는 경우에도 전체 검사한다.

서비스별 테스트는 각 Dockerfile에서 실행한다. 서비스 폴더 전체 삭제에 따른 기존 배포 리소스 제거는 자동 처리하지 않는다.

## 실행 흐름

```text
Checkout → 환경·스크립트 검사 → 임시 PostgreSQL 통합 검사 → 검증 이미지 패키징
  → DEPLOY_MSA=false: 종료 (기본값)
  → DEPLOY_MSA=true: MSA 서버 전송 → 이미지 검증 → DB 변경 SQL 확인
    → 담당자 승인 → 선택 DB 적용 → 적용 결과 확인
```

DB 검사가 선택되면 전체 5개 DB를 검사한다. CD는 `DB_SERVICE`로 선택한 하나만 적용한다. 여러 DB를 변경하면 서비스별로 실행하고 결과를 확인한다. CD는 MR/작업 브랜치에서는 차단되며 `develop-backend` 체크아웃에서만 허용한다.

## CI 검사

GitLab Webhook 실행에서는 마지막 성공 빌드의 커밋과 현재 checkout의 `msa/` 내용을 비교한다. 변경이 없으면 환경·DB 검사와 이미지 패키징을 생략하며, 빌드 기록에 `MSA 변경 없음: CI 생략`을 남긴다. 최초 실행이나 비교 이력이 없거나 분기된 경우에는 전체 CI를 실행한다. 실패한 빌드의 MSA 변경도 다시 검사하도록 직전 빌드가 아닌 마지막 성공 빌드를 기준으로 한다. 수동 실행과 명시적 배포 실행은 변경 여부와 관계없이 전체 CI를 수행한다.

자동 실행은 GitLab의 Push events Webhook을 사용한다. Jenkins 트리거는 Push Events만 활성화하고 Allowed branches를 `develop-backend`로 제한한다. GitLab Webhook 주소는 `https://13.209.59.180/jenkins/project/dva-msa`, 브랜치 필터는 `develop-backend`이며 Jenkins에서 생성한 Secret token을 등록하고 SSL 검증을 유지한다. Poll SCM과 별도 주기 빌드는 끈다. Git의 Included Regions 설정은 Webhook 직접 실행에 적용되지 않으므로 파이프라인에서 경로를 검사한다. 자동 실행은 기본값 `DEPLOY_MSA=false`를 유지한다.

Webhook을 켜기 전에 이 Jenkinsfile이 대상 브랜치에 반영되어야 한다. 반영 후 MSA 변경과 다른 폴더 변경을 각각 검증한다. 코드 checkout과 빌드 기록 생성은 MSA 변경이 없어도 발생하며, 동시에 여러 푸시가 들어오면 checkout 시점의 최신 코드 기준으로 비교한다.

| 검사 | 내용 |
|---|---|
| 실행 환경 | Linux amd64, Docker 엔진, Python 3, Bash, SSH/SCP 및 체크섬 도구 |
| 배포 스크립트 | Bash 구문과 Python unittest; 손상된 패키지, 잘못된 승인, 실패한 Job 등 실패 경로 포함 |
| 이미지 빌드 | 버전·체크섬을 고정한 Liquibase/JDBC 이미지 빌드, 실제 이미지 ID 기록 |
| 신규 설치 | 임시 PostgreSQL 17.11에 5개 스키마 설치, 테이블·제약·인덱스·함수·트리거 등 검증 |
| 업무 규칙 | 서비스별 SQL 테스트, 참조 무결성 및 상태·사번 등 제약 검사 |
| 반복 실행 | 재적용 시 중복 변경 없이 Liquibase 이력 유지 |
| 업그레이드 | customer/operations의 001 → 002, 기존 데이터 보존과 부적합 데이터 차단 |
| 실패 처리 | 초기 설치/후속 changeset 실패 시 해당 트랜잭션 롤백 |
| 승인 연결 | 미리보기·적용 명령 실행, 잘못되거나 오래된 대기 changeset 해시 차단 |
| 배포 산출물 | 성공 보고서의 이미지 ID와 현재 이미지 ID가 일치해야 패키징 |

테스트 DB는 전용 임시 Docker 네트워크에 만들며 호스트 DB 포트를 공개하지 않는다. 종료 시 해당 컨테이너와 네트워크를 제거한다. 실제 서버 DB는 CI에서 사용하지 않는다.

## CD 검사와 적용

1. 커밋 SHA와 Jenkins 빌드 번호로 릴리스를 식별한다. CI에서 검사한 이미지를 다시 빌드하지 않고 tar로 저장한다.
2. 고정된 SSH 호스트 키로 서버를 확인한다. 이미지·실행 스크립트·보고서의 SHA-256을 전송 전후 검사한다. 기존 릴리스 디렉터리를 덮어쓰지 않는다.
3. k3s가 단일 Linux amd64 Ready 노드인지, 스케줄 가능한지, `dva` 네임스페이스가 있는지 검사한다. 이미지를 containerd에 가져온 뒤 CI 이미지 ID와 대조한다.
4. 선택 서비스의 DB Secret 존재를 검사하고 일회성 Job에서 `validate`, 상세 `status`, `update-sql`을 실행한다. SQL과 대기 changeset 목록은 `preview.log`로 보관한다.
5. 승인자가 SQL과 복구 가능한 최신 백업을 확인하고 승인한다. **백업은 파이프라인이 생성하지 않는다.** 승인 대기는 최대 30분이다.
6. 적용 직전에 다시 검증하고 대기 changeset 목록의 해시를 승인 당시와 비교한다. 달라지면 적용하지 않는다.
7. `update` 후 `validate`와 `status`를 다시 실행한다. 미적용 changeset이 없고 Job이 성공한 경우에만 완료로 처리한다.

미리보기는 배포용 SQL 확인 단계다. 별도 프리뷰 웹사이트를 생성하지 않는다. `update-sql`만으로 실제 DDL 성공을 보장하지 않으므로 CI에서 SQL을 실제 실행하고 CD에서도 적용 결과를 검사한다. Liquibase 조회 과정에서 관리 테이블이 만들어질 수 있다.

대기 목록 해시는 changeset 식별자에 대한 승인 연결이다. 임의의 데이터 변경이나 수동 DDL까지 감지하는 스키마 비교 기능은 아니다. 승인 중에는 별도 수동 마이그레이션을 수행하지 않는다. Jenkins 전체 DB 배포 잠금과 서버 작업 잠금을 사용하며, Liquibase DB 잠금도 유지한다.

## Jenkins 설치 후 연결할 설정

이번 구현에서는 Jenkins 설치, 모놀리식 서버 연결, 실제 MSA 서버 접속·배포를 수행하지 않았다.

1. Linux amd64 빌드 노드에 `msa-builder` 라벨을 지정한다. Docker 데몬 사용 권한과 `git`, `python3`, `bash`, `ssh`, `scp`, `sha256sum`, `realpath`가 필요하다. 빌드는 이 서버 노드에서 실행한다.
2. Pipeline/Declarative, Git, Credentials Binding, SSH Credentials, Lockable Resources, Timestamper 플러그인을 준비한다.
3. 신뢰할 수 있는 배포용 Pipeline Job을 만들고 Git SCM 브랜치는 `*/develop-backend`, Script Path는 `msa/Jenkinsfile`로 설정한다. 저장소 접근용 credential은 팀 설정을 사용한다. 설치 후 webhook 또는 수동 실행을 설정한다.
4. 해당 배포 Job/폴더에만 SSH private key credential `dva-msa-ssh`를 등록한다. 접속 사용자는 스크립트에 `ubuntu`로 고정되어 있다. PEM은 Git에 넣지 않는다. MR 등 비신뢰 코드 실행 Job에 배포 credential을 공유하지 않는다. 브랜치 조건만으로 악의적인 Jenkinsfile을 방어할 수는 없다.
5. 승인 가능한 사용자/그룹 `msa-deployers`를 Jenkins 인증 체계에 구성한다. 해당 그룹을 제공하지 않는 환경은 `submitter`를 실제 승인자 ID 목록으로 변경한다. Jenkins 관리자의 승인 권한도 고려한다.
6. MSA 서버는 `python3`, `flock`, `sha256sum`, Bash, SCP를 제공하고 ubuntu가 비밀번호 없이 `sudo -n k3s kubectl`, `ctr`, `crictl`을 실행할 수 있어야 한다. `/home/ubuntu/msa-deploy`에 쓸 수 있어야 한다.
7. `dva` 네임스페이스와 DB, DB 사용자를 준비한다. 각 `<service>-db` Secret에는 `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`가 필요하다. 생성/복원은 이 파이프라인 범위가 아니다.
8. 먼저 `DEPLOY_MSA=false`로 Jenkins 자체 실행을 확인한다. 실제 적용 시 `DEPLOY_MSA=true`, `DB_SERVICE`를 선택하고 미리보기 산출물을 확인한 뒤 승인한다.

`known_hosts`에는 사용자가 서버에서 확인한 ED25519 공개키를 고정했다. 서버 교체로 키가 바뀌면 새 지문을 별도로 확인한 뒤 갱신한다. 호스트 키 검사를 끄지 않는다.

## 파일과 산출물

| 파일 | 역할 |
|---|---|
| `Jenkinsfile` | CI/CD 단계, 브랜치 제한, credential, 승인과 로그 보관 |
| `liquibase/verify.py` | 이미지 빌드와 실제 PostgreSQL 통합 검사 |
| `liquibase/ci-command.sh` | 컨테이너 내부 미리보기·승인 비교·적용 후 검증 |
| `liquibase/run-service.sh` | Kubernetes Job 생성, 성공/실패/시간 초과 확인 |
| `deploy/package.sh` | 검증한 이미지 패키징과 체크섬 생성 |
| `deploy/upload.sh`, `ssh-common.sh` | SSH 검증과 산출물 전송 |
| `deploy/run-remote.sh`, `remote.sh` | 원격 이미지 준비, k3s 검사와 Job 실행 |
| `deploy/tests/test_deploy.py` | 외부 통신 없이 배포 제어·실패 경로 검사 |

Jenkins에서 `verification.json`, `verification-logs/`, `msa-release/<커밋>-<빌드>/`, `preview.log`, `approval.txt`, `apply.log`를 보관한다. 최근 빌드 10개, 산출물은 2개 빌드분을 보관한다. 이미지 tar가 커질 수 있으므로 디스크 용량을 확보한다. 서버 릴리스와 containerd 이미지의 자동 삭제는 하지 않으며 사용 중인 이미지 확인 후 별도로 정리한다.

## 실패·복구 및 검증 범위

- Job은 자동 재시도하지 않으며 실행 제한은 10분, 완료 후 TTL은 1일이다. Jenkins 단계 재시작도 막았다.
- Jenkins 중단/SSH 단절이 이미 시작한 Job의 중단을 보장하지 않는다. 재실행 전 `kubectl -n dva get jobs,pods`, 해당 Job 로그, Liquibase 이력을 확인한다. 잠금을 무조건 해제하지 않는다.
- 실패한 changeset은 트랜잭션으로 되돌리지만 이전에 성공한 changeset까지 자동 복구하지 않는다. 복구는 검토한 후속 changeset 또는 검증된 백업으로 처리한다.
- 현재 단일 노드에서 로컬 이미지 import를 사용한다. 노드가 늘면 이미지 저장소 또는 노드별 배포 방식을 먼저 설계한다.
- 로컬 Docker PostgreSQL 통합 검사와 격리된 배포 스크립트 테스트는 실제 Jenkins 플러그인 조합, SSH 네트워크, 운영 k3s Job의 종단간 검증을 대체하지 않는다. 서버 연결 후 첫 실행에서 이를 확인해야 한다.

검사 실행(저장소 루트, Linux 빌드 환경):

```bash
python3 -m unittest discover -s msa/deploy/tests -v
python3 msa/liquibase/verify.py
```
