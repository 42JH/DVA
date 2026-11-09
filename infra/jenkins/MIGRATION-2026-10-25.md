# Jenkins 이전 기록 — 2026-10-25

- Jira: S15P31D109-111
- 작업 브랜치: `ci/jenkins-lightsail`, 기준: `develop-backend` (`5384177`)
- 대상: 기존 Lightsail `13.209.59.180` / Ubuntu / 2 vCPU / 약 8GB
- 새 실행 경로: `/home/ubuntu/dva-jenkins`, Compose 프로젝트: `dva-jenkins`
- 기존 업무 서비스·DB 볼륨 및 운영 배포 릴리스는 변경하지 않았다. 승인 후 Nginx에 Jenkins HTTPS 경로만 추가했다.

## 완료한 작업

- 로컬 Docker Desktop의 `dva-jenkins`를 정지하고 원본 `dva_jenkins_home` 볼륨을 보존했다.
- 전체 백업, 이전용 설정 백업, controller key 백업을 분리해 작성했다.
- 서버에는 이전용 설정과 별도 key 백업을 보호된 경로로 전송·체크섬 확인 후 복원했다.
- Jenkins 버전은 로컬과 동일한 `2.580.1`을 사용했다.
- 사용자·Job·빌드 이력·로그·시스템 Credentials를 복원했다. 옛 빌드 바이너리 산출물은 전체 로컬 백업에 보존한다.
- 요청한 `dva-admin`을 기존 `jlkim909`의 비밀번호 해시로 생성했다. 기존 계정은 삭제하지 않았다.
- 이후 사용자가 `dva-admin`으로 로그인해 Security 메뉴에서 비밀번호 변경을 완료했다고 확인했다.
- controller 실행 슬롯 0개, Linux agent 슬롯 1개, 분리된 TLS Docker daemon을 구성했다.
- Linux agent 온라인, Node.js `24.22.1`, Docker `29.9.2` 연결을 확인했다.
- 기존 Windows 노드는 오프라인 상태로 보존했다.
- Jenkinsfile의 Windows·PowerShell·로컬 NodeJS tool 의존성을 제거했다.
- Linux 패키징·전송·읽기 전용 배포 준비 검사 및 회귀 테스트를 추가했다.
- 실제 Jenkins의 Declarative Pipeline 문법 검사를 통과했다.
- GitLab 소스를 받은 `dva-ci-linux-validation` #1이 SUCCESS로 끝났다. 이미지 빌드·패키징·산출물 보관을 포함한다.
- #2도 SUCCESS(약 80초)로 끝났다. 복원한 배포 Credentials로 SSH 호스트 키·서버 준비 상태를 확인했으며 실제 배포 단계는 건너뛰었다.
- Nginx의 `/jenkins/` 후보 설정을 별도 임시 설정에서 검증한 후, 사용자의 명시적 승인을 받아 2026-10-25 17:16 KST에 반영·reload했다.
- 외부 Windows PC와 서버에서 Jenkins 로그인 화면 HTTP 200을 확인했다. 익명 Jenkins API는 403으로 차단된다.
- 기존 HTTPS health 및 백엔드 health가 정상이며 업무 컨테이너 4개 모두 healthy 상태를 유지한다.
- 임시 migration API token 1개를 폐기하고 인증 파일·일회성 init script를 제거했다. agent secret은 유지한다.

Nginx 적용 전 설정 백업: `/home/ubuntu/dva-jenkins/backups/nginx-dva-ip-20261025T081606Z`.

## 보호된 백업 위치

로컬(모두 Git 제외, 현재 사용자 전용 디렉터리):

```text
.deploy/jenkins-migration-20261025/home/jenkins-home.tar.gz
.deploy/jenkins-migration-20261025/home/jenkins-settings.tar.gz
.deploy/jenkins-migration-20261025/controller-keys/jenkins-keys.tar.gz
```

서버:

```text
/home/ubuntu/jenkins-migration-20261025/jenkins-settings.tar.gz
/home/ubuntu/jenkins-controller-keys-20261025/jenkins-keys.tar.gz
```

설정 백업 SHA-256: `c92171831ef1db9fb2a797e7b4f8bc30648d274fb859395f094f5b5c0a71e81b`

key 백업 SHA-256: `7a5cb45f19d40bdf0cc9cb0b9ca59211184b4dc7c56ebb69c0e42193024cda38`

약 695MB 전체 백업의 전송을 중단한 뒤 약 81MB 설정 백업으로 이전했다. 서버의 `jenkins-home.tar.gz`는
중단된 전송 파일이므로 복원에 사용하지 않는다. 원본 전체 백업은 로컬에 남아 있다.

## 정식 Job 반영

원래 `dva-ci`가 `*/ci/file-transfer-deploy`를 보고 있어 이를 `*/develop-backend`로 정리했다.
새 Linux Jenkinsfile은 아직 원격에 없으므로 정식 Job은 비활성화했다.
검증 Job은 develop-backend 앱 소스에 이번 Linux CI 스크립트만 덮어써 실행한다.
코드의 MR 반영 후 정식 Job을 활성화하고 검증 Job을 정리한다.

## 승인·검증 후 마무리할 항목

- 실제 배포 검증은 별도 승인 전까지 실행하지 않는다. 검증 Job의 DEPLOY_LIGHTSAIL은 false로 실행했다.
- 기존 `jlkim909` 계정의 정리 여부는 별도로 결정한다. 새 계정 로그인·비밀번호 변경은 완료했다.

자동 승인 검토에서 기존 노드 삭제·실제 운영 배포·공유 Nginx 설정 변경의 명시적 승인이 부족하다는
이유로 결합 명령이 거절됐다. 해당 명령은 실행되지 않았다. 이후 빌드와 읽기 전용 접속 검증을 마쳤으며,
사용자가 HTTPS 접속 경로 적용을 명시적으로 승인한 뒤 Nginx 변경만 별도로 실행했다.
실제 운영 배포와 기존 노드 삭제는 실행하지 않았다.
