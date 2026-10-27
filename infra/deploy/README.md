# Lightsail 이미지 파일 배포

## AI 배포 관리 분리

백엔드 패키징(`package.sh`, `package.ps1`)은 Backend·PostgreSQL·Nginx만 포함한다.
AI 이미지 빌드·배포·컨테이너 관리는 AI 팀이 담당한다.
운영 백엔드는 기존 외부 네트워크 `dva-prod_ai_net`에서 `http://ai:8000`으로 연결한다.
AI 팀은 이 네트워크에 AI 컨테이너를 연결하고 `ai` 별칭과 8000 포트, `/health`를 유지해야 한다.
백엔드 readiness의 AI 연결 검사는 유지한다.

기존 `dva-prod-ai-1`은 이 변경으로 중지하거나 삭제하지 않는다.
전환 중 `--remove-orphans` 또는 기존 Compose의 `down`을 실행하지 않는다.
분리 이전 릴리스로 롤백하면 예전 Compose가 AI를 다시 관리할 수 있으므로,
해당 롤백은 AI 팀과 조율해야 한다. 아래 과거 배포 검증 기록은 당시 구성 기준이다.


> 2026-10-25: Jenkins를 기존 Lightsail로 이전하고 Linux 빌드 에이전트를 구성했다.
> 최신 `Jenkinsfile`은 `package.sh`·`upload.sh`를 사용한다.
> [Jenkins 서버 운영·검증·정식 Job 전환 안내](../jenkins/README.md)를 참고한다.
> 아래 PowerShell 스크립트는 Windows에서 수동 패키징·전송할 때 사용할 수 있다.

배포 대상: `ubuntu@13.209.59.180`, Ubuntu 24.04 / linux/amd64.
Jenkins Linux Agent에서 이미지를 만들고 파일로 SSH 전송한다. ECR은 사용하지 않는다.
별도 이미지 저장소 요금은 발생하지 않으며, 기존 서버의 디스크와 전송량을 사용한다.
S3 및 외부 AI API 비용은 이 배포 방식과 별개다.

## 구성과 현재 범위

```text
Jenkins → docker build → docker save → 버전별 배포 폴더
                                         ↓ scp
Lightsail → 체크섬 확인 → docker load → 미적용 DB migration → 스키마 검증 → Compose 실행 → 상태 확인
```

- `package.sh`·`package.ps1`: Backend를 linux/amd64로 빌드한다. Nginx·PostgreSQL 이미지까지
  포함하여 서버에서 이미지를 추가로 내려받지 않고 실행할 수 있는 폴더를 만든다.
- `deploy.sh`: 체크섬·Compose 설정 확인, 이미지 로드, 미적용 migration·스키마 검증, 실행, 내부 readiness와
  Nginx 경유 HTTP 상태를 확인한다. 실패하면 DB와 호환되는 기존 정상 릴리스를 재적용한다.
- Jenkins는 커밋 SHA와 빌드 번호로 버전을 만들고 해당 폴더를 빌드 산출물로 보관한다.
  Windows Agent도 Controller에서 검증한 것과 같은 커밋을 사용한다.
- Jenkins #15에서 SSH 인증·파일 전송·수동 선택 배포를 검증했다.
- 컨테이너 Nginx는 `127.0.0.1:8082`를 유지한다. 호스트 Nginx가 IP HTTPS를 종료하고
  PBX 웹훅과 Swagger 문서 경로를 전달한다. [HTTPS 운영](../https/README.md), [웹훅 규격](../webhooks/PBX-CALL-ENDED.md)을 참고한다.
- 운영 `shared/.env`에는 DB 설정 외에 32바이트 이상의 `PBX_WEBHOOK_TOKEN`이 필요하다.
  기존 서버에는 무작위 토큰을 생성했으며 Git·산출물에 포함하지 않았다.

## 1. Windows에서 배포 폴더 생성

Docker Desktop을 Linux 컨테이너 모드로 실행하고 프로젝트 루트에서 실행한다.
이미지를 다시 빌드하므로 기존 로컬 `:ci` 태그에 의존하지 않는다.

```powershell
cd C:\Users\SSAFY\dva
$releaseVersion = 'manual-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
& ./infra/deploy/package.ps1 -Version $releaseVersion
```

결과는 `.deploy/<버전>/`에 생성된다. 같은 버전 폴더는 덮어쓰지 않는다.
`release.env`에는 세 이미지의 버전만 포함하며, DB 비밀번호·PEM·AWS 키·로컬 `.env`는
배포 폴더에 복사하지 않는다. `docker save --output`을 사용하여 Windows PowerShell의
바이너리 리다이렉션 문제를 피한다.

배포 폴더에는 `backend/migrations/*.sql`, `infra/database/migrate.sh`, `infra/database/verify.sql`도 포함한다.
`release-files.sha256`은 SQL·실행기·설정 파일을 검증하며 001의 기존 CRLF 바이트는 그대로 보존한다.
업로드 전과 서버 실행 전 모두 이미지/파일 체크섬을 확인한다.

## 2. 서버 최초 준비

SSH 접속 후 Ubuntu에서 실행한다. 실제 운영 설정은 서버에만 생성한다.
기존 환경 파일이 있으면 내용을 덮어쓰지 않는다.

```bash
umask 077
mkdir -p ~/dva-deploy/shared ~/dva-deploy/releases
if [ ! -e ~/dva-deploy/shared/.env ]; then
  {
    printf 'DB_USER=dva\n'
    printf 'DB_PASSWORD='
    openssl rand -hex 32
    printf 'DB_NAME=monolith_db\n'
  } > ~/dva-deploy/shared/.env
fi
chmod 600 ~/dva-deploy/shared/.env
```

기본 `ubuntu` 계정의 `sudo -n docker` 실행 권한이 필요하다.
파일을 출력하거나 Git에 올리지 않는다. DB 최초 생성 이후 비밀번호를 바꿀 때는
환경 파일만 변경하지 말고 PostgreSQL 계정 비밀번호도 함께 변경해야 한다.

## 3. 파일 전송 및 실행

1단계와 같은 Windows PowerShell 창에서 실행한다. `$releaseVersion`은 생성한 폴더명이다.
Jenkins 산출물을 내려받았다면 그 버전과 배포 폴더 경로를 지정한다.

```powershell
$keyPath = 'C:\Users\SSAFY\Desktop\기업연계\dva-monolith.pem'
scp -i $keyPath -r ".deploy/$releaseVersion" ubuntu@13.209.59.180:./dva-deploy/releases/
if ($LASTEXITCODE -ne 0) { throw '전송 실패: 배포를 실행하지 마세요.' }
ssh -i $keyPath ubuntu@13.209.59.180 "bash ~/dva-deploy/releases/$releaseVersion/deploy.sh"
if ($LASTEXITCODE -ne 0) { throw '배포 실패: 서버 상태를 확인하세요.' }
```

최초 SSH 연결 시 서버 호스트 키 지문을 확인한다. 호스트 키 검증을 비활성화하지 않는다.
이미지 전송이 끝난 뒤 배포를 실행한다. 동시 배포는 서버 파일 잠금으로 차단한다.
서버에서는 `--pull never --no-build`로 실행하며, 기존 DB 볼륨은 유지한다.
정상 배포만 `current-release`에 기록하고 직전 버전은 `previous-release`에 기록한다.

일반 개발 배포는 migration runner의 `--no-backup`을 사용한다. 다만 생성 요청 테이블을 제거하는
`008-simplify-creation-requests.sql` 최초 적용은 기존 백엔드를 중지하고
`shared/db-backups`에 백업·체크섬을 만든 뒤 실행한다. 이 전환에는 API 중단 시간이 있다.
기존 DB가 있으면 새 앱을 교체하기 전에 미적용 SQL만 실행한다. 최초 배포에서는 DB만 먼저 시작한다.
SQL은 기존 advisory lock과 하나의 트랜잭션을 사용하며 실패하면 신규 SQL/이력은 함께 롤백된다.
SQL 또는 적용 후 스키마 검증이 실패하면 앱 배포와 버전 기록 갱신을 중단한다.

008 전환 중 백업/SQL이 실패해 DB가 구버전 구조를 유지하면 기존 백엔드를 다시 시작한다.
DB 전환이 커밋된 뒤 스키마 검증이나 새 앱 실행이 실패하면 구버전 자동 복귀를 차단한다.
이미 전환된 DB에는 008이 포함된 앱만 배포·복구할 수 있으며 DB 상태 조회 실패도 배포 중단으로 처리한다.

## 4. 브라우저에서 연결 확인

Windows의 별도 PowerShell 창에서 터널을 열고 유지한다.

```powershell
ssh -i 'C:\Users\SSAFY\Desktop\기업연계\dva-monolith.pem' -N -L 18082:127.0.0.1:8082 ubuntu@13.209.59.180
```

- `http://127.0.0.1:18082/nginx-health` → `ok`
- `http://127.0.0.1:18082/api/health` → Backend 상태 응답
- 공개 프록시의 `/api/health/ready` → 의도적으로 404. 상세 의존성 상태는 배포 스크립트가 내부에서 확인한다.

## 5. 롤백과 보관

서버에서 `<현재버전>`을 실제 폴더명으로 바꿔 실행한다.

```bash
bash ~/dva-deploy/releases/<현재버전>/deploy.sh --rollback
```

직전 정상 버전의 이미지·설정으로 돌아간다. 최초 배포에는 이전 버전이 없으며,
실패한 컨테이너는 로그를 조사할 수 있도록 남긴다. 이전 버전 복구도 실패하면
명령은 실패를 반환하고 수동 점검이 필요하다.

이 롤백은 DB 데이터를 복원하지 않는다. 008 적용 이후에는 해당 migration이 없는 릴리스로
앱만 되돌리는 수동 롤백도 차단한다. 실패한 신규 릴리스의 최신 `deploy.sh`로 재시도하거나 복구해야 하며,
보호 로직이 없는 과거 `deploy.sh`를 직접 실행하지 않는다.
호환되는 수정 앱 배포를 우선하고, DB 복원이 필요하면 서비스를 중지한 상태에서 백업을 별도 DB에
복원·검증한 뒤 전환한다. 자동 DB 복원은 하지 않는다. [DB 복구 절차](../../docs/database/README.md)를 참고한다.
`--rollback`과 앱 실패 시 자동 복구는 migration을 다시 실행하지 않고 앱 이미지·설정만 복원한다.
`docker compose down -v`, 전체 이미지·볼륨 prune은 사용하지 않는다.

현재·직전 정상 버전의 폴더와 이미지를 보관한다. 오래된 버전 삭제는 해당 두 버전과
실행 중 컨테이너를 확인한 뒤 명시적으로 수행한다. 빌드 PC의 `.deploy`와 Docker
이미지도 쌓일 수 있다. Jenkins 산출물은 최근 2개 빌드만 보관하도록 설정했지만,
이 설정은 Windows 작업 폴더와 Docker 이미지까지 정리하지는 않는다.

```bash
df -h /
sudo docker system df
```

## Jenkins 자동 배포와 수동 선택

이 절의 Windows Agent 설정은 이전 구성 기록이다. 서버 이전 후의 실행 환경과
정식 Job 활성화 절차는 [Jenkins 운영 안내](../jenkins/README.md)를 따른다.

프로젝트 `1462697`의 `develop-backend` Push 웹훅으로 시작되고 실제로 해당 브랜치를 체크아웃한 빌드는
검증 성공 후 `Deploy to Lightsail` 단계로 자동 진행한다. 수동 빌드의 `DEPLOY_LIGHTSAIL` 기본값은 false이며,
체크하면 같은 브랜치에서 배포한다. 빌드·패키징·배포는 동일한 Linux agent와 작업 폴더를 사용한다.
배포 직전에 migration을 실행하고 스키마를 검증한다. 실제 운영 반영은 이 변경의 MR 병합 이후 빌드에서 확인한다.

### SSH 인증 정보 등록

Jenkins 관리 → Credentials → System → Global credentials → Add Credentials에서 등록한다.

| 필드 | 값 |
|---|---|
| Kind | SSH Username with private key |
| ID | `dva-lightsail-ssh` |
| Username | `ubuntu` |
| Private Key | Enter directly → 로컬 PEM 파일의 전체 내용을 직접 입력 |
| Passphrase | 현재 제공된 PEM은 접속 시 암호를 요구하지 않으므로 비워 둠 |

개인 키는 Jenkins Credentials에만 등록한다. Git·빌드 매개변수·채팅·콘솔 로그에는
붙여넣지 않는다. Pipeline은 withCredentials로 임시 키 경로만 받아 사용한다.

`known_hosts`는 서버의 공개 호스트 키이며 개인 키가 아니다. 확인한 지문은
`SHA256:W9suR7/VFXc7he/VDB6jFvQcnJJXrlTkykWFZL/hjhU`다.
업로드 스크립트는 이 키로 접속 대상을 검증하고 호스트 키 확인을 우회하지 않는다.
Windows SSH 권한 문제를 피하도록 실행 계정만 접근할 수 있는 임시 키 사본을
작업 폴더 밖에 만들고, 성공·실패 여부와 관계없이 정리한다. 원본 키의 권한은 변경하지 않는다.

### 실행 순서

1. Jenkins가 변경된 Jenkinsfile을 읽을 수 있도록 해당 브랜치를 원격에 반영한다. Push·MR은 사용자가 수행한다.
2. 기존 `dva-ci` Job의 Branch Specifier를 배포할 브랜치로 지정한다.
   CI/CD 검증 당시에는 `*/ci/file-transfer-deploy`를 사용했다. 해당 작업은 `develop-backend`에
   병합됐으며, Job 설정 변경과 Push·MR은 사용자가 수행한다. 새 Job을 만들 필요는 없다.
3. 최초 빌드는 배포를 선택하지 않고 실행해 파이프라인과 매개변수를 등록한다.
4. Build with Parameters에서 `DEPLOY_LIGHTSAIL`을 체크해 실행한다.
5. Backend 검증 → 이미지 빌드·파일 생성 → 산출물 보관 → SCP 전송 → 서버 deploy.sh → 상태 확인 순서로 실행한다.

기존 릴리스 폴더는 덮어쓰지 않는다. 전송이 끊겼다면 실패 폴더를 임의로 덮어쓰지 말고
새 빌드 번호로 다시 실행한다. 서버 환경 파일이 없는 경우 배포를 중단하며,
이 스크립트가 기존 DB 설정을 생성하거나 교체하지 않는다.

직접 접속 검증만 할 때는 아래처럼 `-VerifyOnly`를 사용한다. 이 모드는 서버 배포를 하지 않는다.

```powershell
& ./infra/deploy/upload.ps1 -Version '383f3cc5be57-first-20261022' `
    -IdentityFile 'C:\Users\SSAFY\Desktop\기업연계\dva-monolith.pem' -VerifyOnly
```

## 남은 작업

- 실제 장애를 주입한 서버 자동 복구 검증 (현재 자동 복구 분기는 모의 환경에서 검증)
- 디버 PBX의 인증 헤더·재전송·녹취 다운로드 규격 확정 및 실제 통화 수신 검증
- 저장된 웹훅과 업무 통화 데이터·S3·AI 후속 처리 연결, 정기 DB 백업·모니터링

Jenkins가 개인 PC에 있으므로 PC 또는 Windows Agent가 꺼지면 새 빌드는 중단된다.
이미 서버에서 실행 중인 앱은 이와 별개로 계속 실행된다.

## 2026-10-22 로컬 검증 결과

- PowerShell 패키징 스크립트 구문 검사 통과
- 실제 Backend·AI 이미지 빌드 및 네 이미지의 linux/amd64 확인
- `manual-20261022-file-deploy-01` 배포 폴더 생성, `images.tar` 273,550,848 bytes, SHA-256 일치
- 별도 Compose 프로젝트·임시 DB·임의 localhost 포트에서 네 서비스 healthy 확인
- Nginx 경유 `/api/health` 정상, Backend 내부 readiness에서 DB·AI 모두 up 확인
- 모의 Docker를 이용한 최초 배포·갱신·실패 시 이전 버전 재적용·수동 롤백·전송 손상 거부 검사 통과
- 검증용 컨테이너·네트워크·볼륨 정리 완료

## 2026-10-22 Lightsail 검증 결과

- 서버: `13.209.59.180`, x86_64, Docker Compose v5.6.1
- 로컬 패키징 파일을 SCP 전송한 뒤 서버에서 SHA-256 검증·이미지 로드·Compose 기동 성공
- 서버 환경 파일은 `/home/ubuntu/dva-deploy/shared/.env`, 파일 권한 600으로 생성
- 최종 실행 릴리스: `383f3cc5be57-first-20261022` (배포 스크립트 수정 커밋 `383f3cc` 기준)
- Nginx·Backend·AI·PostgreSQL 모두 healthy 확인
- `/api/health` 정상, 내부 `/health/ready`에서 DB·AI 모두 up 확인
- Nginx는 `127.0.0.1:8082`에만 바인딩, Backend·AI·DB의 호스트 포트 매핑 없음
- DB 네트워크 internal 확인, Nginx의 상세 readiness 경로는 404 확인
- 동일 앱 이미지를 사용하는 릴리스 간 실제 롤백 후 최신 릴리스 재배포 성공
- DB 볼륨은 유지했으며 DB 데이터 백업·복원을 검증한 것은 아님
- 최종 디스크 사용량 약 5.1GB / 154GB, 여유 약 149GB

검증 중 Docker Compose exec가 SSH로 전달한 후속 입력을 소비하는 문제가 확인되어
readiness 확인 명령의 stdin을 `/dev/null`로 분리했다. 해당 상황을 재현하는 회귀 테스트를
추가했고 기존 배포·실패 복구·손상 거부 테스트와 함께 통과했다.

현재는 기본 Health Check 앱의 인프라 검증 결과다. Jenkinsfile의 수동 선택 배포와 전송
스크립트를 추가하고 Groovy·PowerShell 구문 및 실제 SSH 인증·임시 키 정리를 확인했다.
Jenkins Credentials에는 현재 GitLab 읽기용 ID만 있어 SSH 키 등록이 필요하다.
변경된 Jenkins Job의 실제 파일 전송·배포, 도메인·HTTPS,
실제 관리자 웹·AI·S3·전화 업무 연동은 아직 검증하지 않았다.
ECR 등 신규 유료 AWS 리소스는 생성하지 않았다. 이전 검증 릴리스 폴더는 복구 확인용으로 보관했다.

## 2026-10-23 갱신

위 10월 22일 기록 이후 Jenkins #15의 실제 선택 배포가 성공했고, CI/CD 변경은
`100faa4`로 `develop-backend`에 병합됐다.

현재 릴리스는 `pbx-ip-20261023-01`이다. 이 버전은 웹훅 작업 브랜치의 로컬 검증 소스로
수동 패키징·배포했으며, 해당 브랜치의 GitLab 반영은 아직 수행하지 않았다.
네 서비스 healthy, 내부 readiness, 외부 IP HTTPS 웹훅의 인증·저장·재전송 처리를 확인했다.
신규 모놀리식 웹훅 테이블은 백엔드 시작 시 추가되며 기존 MSA migration은 적용하지 않는다.
DB 변경 전 서버에 dump를 만들고 archive index를 검사했다. 정기 백업·복원 시험은 별도다.
