# Jenkins Lightsail 이전

Jira: S15P31D109-111 · 브랜치: `ci/jenkins-lightsail` · MR 대상: `develop-backend`.

## 구성

기존 Lightsail(Ubuntu, 2 vCPU, 8GB)에서 별도 Compose 프로젝트 `dva-jenkins`로 실행한다.
업무 서비스의 Compose 프로젝트와 DB 볼륨을 공유하지 않는다.

| 구성 | 역할 | 자원 제한 |
|---|---|---|
| controller | 관리 화면·설정·빌드 이력, 실행 슬롯 0개 | 1GB / 0.5 CPU, JVM 최대 힙 512MB |
| agent | Linux 빌드 에이전트 `linux-docker-builder`, 실행 슬롯 1개 | 1GB / 0.5 CPU |
| docker | 빌드 전용 Docker daemon | 2GB / 1 CPU |

동일 서버이므로 Jenkins와 서비스가 하드웨어 자원을 공유한다. 별도 CI 서버로 분리한 것과 같은
장애 격리나 성능 보장을 의미하지 않는다. 동시 빌드는 1개로 제한한다.

agent는 `init: true`로 실행하여 빌드 중 부모를 잃은 자식 프로세스를 회수한다.
이 설정이 없으면 종료된 Git·셸 프로세스가 누적되어 `pids_limit: 512`에 도달하고,
`fork: Resource temporarily unavailable` 또는 출력 없는 빌드 정지가 발생할 수 있다.
이미 누적된 경우 실행 중인 빌드를 중단하고 agent만 재생성한다. 설정 반영 후
`docker inspect --format '{{.HostConfig.Init}}' dva-jenkins-agent-1`의 결과가 `true`인지 확인한다.

controller는 Docker 소켓을 마운트하지 않는다. agent는 TLS와 내부 네트워크로 빌드용 Docker에
연결하며 운영 Docker 소켓을 사용하지 않는다. Docker-in-Docker에는 privileged 컨테이너가 필요하다.
신뢰한 프로젝트의 코드만 실행한다. 빌드 daemon의 포트는 호스트에 공개하지 않는다.

## 접속 및 계정

- 주소: `https://13.209.59.180/jenkins/`
- Nginx HTTPS 프록시 → `127.0.0.1:8080`의 Jenkins. 8080·50000 포트를 외부에 개방하지 않는다.
- 기존 사용자·보안 설정·시스템 Credentials를 복원한다. 익명 접근과 회원가입을 허용하지 않는다.
- 요청한 새 ID는 `dva-admin`. 초기 이전에는 `jlkim909`의 비밀번호 해시를 복사했고, 이후 사용자가 새 계정에서 비밀번호를 변경했다.
- 비밀번호는 사용자 메뉴의 Security에서 변경한다. 기존 계정 삭제 여부는 별도로 결정한다.

## 이전 백업과 복원

기존 로컬 Jenkins를 정지하고 `dva_jenkins_home` 볼륨을 읽기 전용으로 백업했다.
일반 설정 백업과 `secrets`·controller key 백업은 별도 보관한다. 파일 내용과 비밀값을 출력하거나 Git에 넣지 않는다.
서버 전송 시 체크섬을 확인하고, 디렉터리는 700·백업 파일은 600으로 보호한다.

전체 로컬 백업에는 기존 빌드 산출물도 보존한다. 서버 이전용 설정 백업은 이전 빌드의 이미지 archive와
재생성 가능한 플러그인 추출 디렉터리·workspace·tools·캐시를 제외한다. Job 설정·빌드 이력·로그·원본 jpi는 유지한다.
따라서 이전 서버의 과거 빌드 페이지에서 옛 바이너리 산출물을 다운로드할 수는 없다.

```sh
sudo bash infra/jenkins/install.sh /보호된경로/jenkins-settings.tar.gz /별도보호경로/jenkins-keys.tar.gz /home/ubuntu/dva-jenkins
```

`install.sh`는 기존 home이 있으면 중단한다. controller 0 executors, 기존 Job 비활성화 상태로 복원한다.
한 번 실행할 `bootstrap.groovy`는 Linux agent를 등록하고, 새 관리자 계정을 구성하고,
검증용 임시 API token과 agent secret을 보호된 파일에 쓴다. 비밀값은 로그에 쓰지 않는다.

`bootstrap-output/migration-auth`는 이전 검증용 파일이다. 검증 종료 후 token을 폐기하고 파일을 제거한다.
`home/init.groovy.d/lightsail-migration.groovy`도 제거하여 재시작 시 계정·Job 설정을 다시 적용하지 않는다.
agent-secret은 에이전트 실행에 필요하므로 유지한다.

## 파이프라인 변경

`Jenkinsfile`은 Windows `docker-builder` 및 PowerShell 단계 대신 Linux agent 하나를 사용한다.
Node.js 24와 Docker CLI는 agent 이미지에 포함한다. Backend 컴파일은 backend Docker build stage에서 실행한다.

1. GitLab Checkout
2. 셸 구문 및 배포 회귀 테스트
3. Backend·AI·PostgreSQL·Nginx 이미지 패키징
4. 이전한 SSH credential·호스트 키·서버 준비 상태를 읽기 전용으로 검증
5. `DEPLOY_LIGHTSAIL=true`인 경우에만 SSH 파일 전송·배포

기존 전체 서비스 파이프라인의 동작 범위를 유지한다. AI 파트의 별도 자동 배포 작업은 이 변경에 포함하지 않는다.
기존 Windows용 package.ps1·upload.ps1은 수동 사용을 위해 보존한다.
새 Linux package.sh·upload.sh도 서버의 환경 파일·DB 볼륨을 초기화하지 않는다.

Job의 GitLab credential ID는 `gitlab-dva-readonly`, 배포 credential ID는 `dva-lightsail-ssh`를 유지한다.
배포 시 SSH 호스트 키를 `infra/deploy/known_hosts`로 검증한다.

## 코드 반영 전 검증

새 Jenkinsfile은 아직 GitLab에 없으므로 정식 `dva-ci`를 구형 Windows Jenkinsfile로 실행하지 않는다.
`configure-jobs.groovy`는 정식 Job의 대상 브랜치를 `develop-backend`로 정리하고 비활성화한다.
별도 `dva-ci-linux-validation`은 GitLab develop-backend의 앱 코드를 받고 현재 Linux CI 스크립트만 덮어써 검증한다.
변경한 앱 코드를 검증하는 것으로 오해하지 않도록 산출물 이름에 `jenkins-linux-` 접두사를 붙인다.

코드가 MR로 develop-backend에 반영된 뒤, 정식 Job의 Jenkinsfile 로딩과 Linux agent 배정을 확인하고 활성화한다.
검증 Job은 비활성화 또는 제거한다. 이 문서가 아직 수행하지 않은 서버 검증 결과를 뜻하지는 않는다.

## 점검·복구

```sh
cd /home/ubuntu/dva-jenkins
sudo docker compose ps
sudo docker compose logs --tail 80 controller
sudo docker compose logs --tail 80 agent
sudo docker compose stop
```

Jenkins 중지로 업무 서비스와 DB를 중지하지 않는다. 이전 자체를 취소해야 하면 Jenkins만 중지하고
별도 보관한 이전 Nginx 설정을 복원한 뒤 `nginx -t` 통과 후 reload한다. 로컬 Jenkins 원본 볼륨은 유지한다.
복구 검증 없이 `docker compose down -v`, 전체 Docker prune, 기존 DB 볼륨 삭제를 실행하지 않는다.

Jenkins home과 controller key는 별도 백업 대상으로 관리한다. 같은 서버의 파일만으로 서버 손실에 대비하는
백업이 완성되는 것은 아니며, 정기·외부 백업은 별도 설정이 필요하다.
