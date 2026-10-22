# Lightsail 이미지 파일 배포

배포 대상: `ubuntu@13.209.59.180`, Ubuntu 24.04 / linux/amd64.
Jenkins Windows Agent에서 이미지를 만들고 파일로 SSH 전송한다. ECR은 사용하지 않는다.
별도 이미지 저장소 요금은 발생하지 않으며, 기존 서버의 디스크와 전송량을 사용한다.
S3 및 외부 AI API 비용은 이 배포 방식과 별개다.

## 구성과 현재 범위

```text
Jenkins → docker build → docker save → 버전별 배포 폴더
                                         ↓ scp
Lightsail → 체크섬 확인 → docker load → Compose 실행 → 상태 확인
```

- `package.ps1`: Backend·AI를 linux/amd64로 빌드한다. Nginx·PostgreSQL 이미지까지
  포함하여 서버에서 이미지를 추가로 내려받지 않고 실행할 수 있는 폴더를 만든다.
- `deploy.sh`: 체크섬·Compose 설정 확인, 이미지 로드, 실행, 내부 readiness와
  Nginx 경유 HTTP 상태를 확인한다. 실패하면 기존 정상 릴리스를 재적용한다.
- Jenkins는 커밋 SHA와 빌드 번호로 버전을 만들고 해당 폴더를 빌드 산출물로 보관한다.
  Windows Agent도 Controller에서 검증한 것과 같은 커밋을 사용한다.
- 서버 전송·실행은 첫 배포에서 수동으로 검증한다. Jenkins의 자동 SSH 배포는
  서버 설정과 Jenkins용 SSH 인증 정보를 준비한 뒤 연결한다.
- 도메인·HTTPS 준비 전에는 Nginx를 `127.0.0.1:8082`에서 검증한다.
  `/`는 프론트엔드 미구현으로 404이며, 외부 전화 웹훅은 아직 연결되지 않는다.

## 1. Windows에서 배포 폴더 생성

Docker Desktop을 Linux 컨테이너 모드로 실행하고 프로젝트 루트에서 실행한다.
이미지를 다시 빌드하므로 기존 로컬 `:ci` 태그에 의존하지 않는다.

```powershell
cd C:\Users\SSAFY\dva
$releaseVersion = 'manual-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
& ./infra/deploy/package.ps1 -Version $releaseVersion
```

결과는 `.deploy/<버전>/`에 생성된다. 같은 버전 폴더는 덮어쓰지 않는다.
`release.env`에는 네 이미지의 버전만 포함하며, DB 비밀번호·PEM·AWS 키·로컬 `.env`는
배포 폴더에 복사하지 않는다. `docker save --output`을 사용하여 Windows PowerShell의
바이너리 리다이렉션 문제를 피한다.

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

이 롤백은 DB 데이터를 복원하지 않는다. 스키마 변경이 들어오면 호환 가능한
마이그레이션과 별도 복구 절차가 필요하다. DB 백업은 현재 인계 범위에서 보류 상태다.
`docker compose down -v`, 전체 이미지·볼륨 prune은 사용하지 않는다.

현재·직전 정상 버전의 폴더와 이미지를 보관한다. 오래된 버전 삭제는 해당 두 버전과
실행 중 컨테이너를 확인한 뒤 명시적으로 수행한다. 빌드 PC의 `.deploy`와 Docker
이미지도 쌓일 수 있다. Jenkins 산출물은 최근 2개 빌드만 보관하도록 설정했지만,
이 설정은 Windows 작업 폴더와 Docker 이미지까지 정리하지는 않는다.

```bash
df -h /
sudo docker system df
```

## 배포 전 남은 확인

- 변경한 Jenkinsfile·스크립트·운영 Compose를 GitLab에 반영하고 CI 실행 검증
- 서버 최초 환경 파일 생성, 실제 파일 전송, 컨테이너 기동·실패 복구 검증
- Jenkins 자동 전송을 위한 SSH 자격 증명 등록 및 Agent 계정의 known_hosts 준비
- 도메인·HTTPS·외부 접근·실제 AI API·S3·PBX·웹훅 연동

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

실제 Lightsail 전송·기동과 Jenkins에서 변경한 파이프라인 실행은 아직 검증하지 않았다.
