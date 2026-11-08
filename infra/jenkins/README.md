# Jenkins Lightsail 이전

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

## 변경 범위와 최적화

- 마지막 성공 커밋부터 현재 커밋까지 모든 변경·삭제·이동을 비교한다. 기준 누락·이력 분기·알 수 없는 경로는 전체 검증한다.
- `backend/README.md`·`backend/docs/**/*.md` 등 문서만 변경되면 무거운 검증과 자동 배포를 생략한다. 문서 경로의 SQL·스크립트와 코드가 섞인 변경은 기존대로 검증한다. `DEPLOY_LIGHTSAIL=true`로 명시한 문서 전용 수동 배포는 백엔드 전체 검증 후 진행한다.
- 검증 범위와 배포 여부는 따로 판정한다. 자동·수동 배포 요청도 변경 경로에 따라 검증하며, 배포 요청만으로 관측·결제 데모 검증을 강제하지 않는다.
- FAQ 또는 대시보드 내부 source·기존 전용 test만 바뀌면 해당 기능과 연결된 통합 테스트 그룹을 선택한다. 모든 단위 테스트, DB·웹훅·인증·인증 제한·주소 이력, 운영 이미지·Nginx/HTTPS smoke는 매번 유지한다. 주소 이력 그룹은 운영 smoke의 접수 완료 주문 fixture도 제공한다. FAQ는 미답변·FAQ 이벤트·보존/삭제, 대시보드는 통화 분석·지표 수집·페르소나·보존도 검증한다.
- 공통·인증·주문·결제·모듈 배선·새/공용 test 및 두 기능이 섞인 변경은 백엔드 전체 회귀를 실행한다. 일반 업무·인증 변경은 관측·결제 데모 인프라 검증을 생략한다. 공유 DB를 사용하는 통합 테스트 그룹의 실행 순서는 유지한다.
- 백엔드 관측 모듈·HTTP 공통 처리·health·관측 테스트 변경은 백엔드와 관측 검증을 함께 실행한다. `backend/payment-test/` 변경은 백엔드와 결제 데모 검증을 함께 실행한다.
- migration·의존성·Dockerfile·TypeScript 설정·앱 설정 및 시작 코드, 공용 인프라·파이프라인·알 수 없는 경로 변경은 전체 검증한다. 변경 기준을 판정할 수 없는 경우도 전체 검증한다.
- 관측 인프라만 변경되면 해당 검증만, 결제 데모 인프라만 변경되면 해당 검증만 실행한다.
- 선택된 Backend checks는 배포 여부와 관계없이 운영 이미지·Nginx smoke까지 실행한다. 배포 없는 실행은 릴리스 archive·SSH 접근 단계를 생략한다. 수동 릴리스 파일은 기존 package 스크립트로 만들 수 있다.
- Docker checks는 builder가 컴파일한 결과로 `test:compiled`를 실행한다. 로컬 `npm test`는 컴파일부터 실행하는 기존 동작을 유지한다.
- 배포 빌드는 운영 이미지·Nginx/HTTPS smoke가 모두 통과한 뒤에만 릴리스 태그를 남긴다. 패키징은 이 이미지를 재사용하며 없거나 다른 버전·플랫폼이면 실패한다. 백엔드 검증을 실행하지 않은 인프라 전용 배포와 `package.sh <version>` 수동 실행은 기존처럼 이미지를 빌드한다.
- Docker 29 BuildKit의 `/root/.npm` 다운로드 캐시를 사용한다. `npm ci`·lock 무결성 검사·의존성 audit는 유지한다. `node_modules`는 각 단계에서 설치하며 다운로드 캐시 mount는 운영 이미지에 포함되지 않는다.
- 기본 `node backend/scripts/check.cjs`, Docker checks CMD 및 `npm run test:integration`은 전체 실행이다. 선택 프로필은 Jenkins가 diff로 정하며 `BACKEND_TEST_PROFILE=faq|dashboard`로 로컬 재현할 수 있다. 유효하지 않은 프로필·누락된 필수 테스트·해석 불가능한 테스트 명령은 오류로 종료한다. 테스트 목록의 기준은 기존 `package.json` 하나다.
- 웹훅 경로에 `infra/database`, `infra/observability`, `infra/payment-test`를 포함한다. 저장소의 설정 스크립트 변경과 실제 Jenkins Job 재설정은 별도다.

예를 들어 관리자 상태·인증 API만 바뀐 배포는 Backend checks를 실행하고 Observability checks와 Payment demo checks를 생략한다. 백엔드 검증의 컴파일·정적 검사·단위·DB 통합·운영 이미지/Nginx 검사는 유지한다. 변경한 단계의 실패는 기존대로 배포를 중단하며, 배포 브랜치·웹훅 인증·DB migration·readiness·복구 조건도 유지한다.

선택 규칙 자체를 바꾸는 첫 병합은 CI 코드 변경이므로 전체 검증한다. 이후 일반 백엔드 변경부터 관련 없는 인프라 검증을 생략한다.

2026-11-01 [Jenkins #70](https://13.209.59.180/jenkins/job/dva-ci-linux-validation/70/)에서 선택 규칙 커밋 `3b5072e`를 검증했다. 백엔드는 `6bcacce5b14d`로 고정하고, #69의 실제 변경 범위 `8f06f67c3d88..6bcacce5b14d`에 대해 배포 선택값을 `true`로 둔 기존·개선 규칙을 비교했다. 두 방식 모두 컴파일·정적 검사·단위 테스트 캐시를 재사용했고, DB 통합·운영 이미지 검증은 각각 530개를 실행해 통과했다. 선택 규칙 회귀 테스트 5개와 배포 조건 회귀도 통과했다.

| 검증 구간 | 기존 전체 검증 | 변경 범위 선택 |
| --- | ---: | ---: |
| 백엔드 전체 검증 | 259.049초 | 256.317초 |
| 관측 환경 검증 | 269.966초 | 생략 |
| 결제 데모 인프라 검증 | 9.591초 | 생략 |
| 검증 구간 합계 | 538.628초 | 256.374초 |

이번 한 쌍의 비교에서 282.254초(52.4%) 단축됐다. 이미지 패키징·전송·실제 배포는 측정에서 제외했고 운영 DB에도 접근하지 않았다. 모든 빌드의 단축률을 뜻하지 않으며, 공용 설정 변경이나 변경 이력 누락 시에는 전체 검증을 유지한다.

## 파이프라인 변경

`Jenkinsfile`은 Windows `docker-builder` 및 PowerShell 단계 대신 Linux agent 하나를 사용한다.
Node.js 24와 Docker CLI는 agent 이미지에 포함한다. Backend 컴파일은 backend Docker build stage에서 실행한다.

1. GitLab Checkout
2. 셸 구문 및 배포 회귀 테스트
3. Backend·PostgreSQL·Nginx 이미지와 모놀리식 migration SQL/실행기 패키징
4. 이전한 SSH credential·호스트 키·서버 준비 상태를 읽기 전용으로 검증
5. `develop-backend` Push 웹훅은 자동 배포, 수동 빌드는 `DEPLOY_LIGHTSAIL=true`일 때 배포
6. 서버에서 SQL/이미지 체크섬 확인 → 미적용 migration → 스키마 검증 → 앱 교체 → 상태 확인

기존 전체 서비스 파이프라인의 동작 범위를 유지한다. AI 파트의 별도 자동 배포 작업은 이 변경에 포함하지 않는다.
기존 Windows용 package.ps1·upload.ps1은 수동 사용을 위해 보존한다.
새 Linux package.sh·upload.sh도 서버의 환경 파일·DB 볼륨을 초기화하지 않는다.

Job의 GitLab credential ID는 `gitlab-dva-readonly`, 배포 credential ID는 `dva-lightsail-ssh`를 유지한다.
배포 시 SSH 호스트 키를 `infra/deploy/known_hosts`로 검증한다.

## 모놀리식 웹훅 경로 필터

`dva-ci-linux-validation`은 Generic Webhook Trigger로 프로젝트 `1462697`의
`develop-backend` Push 중 `backend/`, 루트 `Jenkinsfile`, `compose.yaml`, `compose.prod.yaml`,
`infra/deploy/`, `infra/nginx/`, `infra/https/`, `infra/jenkins/`, `infra/database/`, `infra/observability/`, `infra/payment-test/`, `.gitattributes` 변경만 선택한다.
일반적인 `msa/` 단독 변경·다른 브랜치·MR 이벤트·브랜치 삭제는 선택하지 않는다.
[GitLab Push payload](https://docs.gitlab.com/user/project/integrations/webhook_events/#push-events)가
commits를 최대 20개만 제공하므로, 총 커밋이 20개를 넘으면
누락된 backend 변경을 놓치지 않도록 보수적으로 실행한다. 이 경우 MSA 단독 Push도 선택될 수 있다.

`configure-monolith-trigger.groovy`를 인증된 관리 콘솔에서 실행한다. 기존 웹훅 토큰을 재사용하고,
Job 설정을 보호된 서버 디렉터리에 백업하며 MSA Job은 변경하지 않는다. 토큰과 payload를 로그에 출력하지 않는다.
호스트 Nginx는 기존 `/jenkins/project/dva-ci-linux-validation`을 Generic Trigger에 전달한다.
따라서 GitLab 웹훅 URL·Secret token을 바꾸지 않는다. Jenkins 재시작이나 앱 재배포도 필요 없다.

서버에서 `sudo python3 test-monolith-trigger.py`로 실제 HTTPS 경로의 dry run을 실행한다.
인증·포함/제외 경로·이벤트·브랜치를 검증하고 모놀리식/MSA의 빌드 번호가 증가하지 않는지 확인한다.
수동 Build 실행은 웹훅 필터를 거치지 않으며 `DEPLOY_LIGHTSAIL=false` 기본값을 유지한다.
자동 배포는 `should-deploy.sh`가 확인한 프로젝트 `1462697`의 `push`, ref `refs/heads/develop-backend`,
실제 체크아웃 브랜치 `origin/develop-backend`일 때만 실행한다. 다른 프로젝트·이벤트·브랜치는 배포하지 않는다.
첫 반영 빌드는 기존 Job 매개변수가 false여도 웹훅 조건으로 자동 배포된다. Job 설정을 별도로 바꿀 필요가 없다.

개발 단계의 자동 배포는 DB 백업을 만들지 않는다. 기존 runner의 `--no-backup` 모드를 사용하며,
체크섬·적용 이력·advisory lock·트랜잭션 롤백은 유지한다. SQL/스키마 검증 실패 시 새 앱을 실행하지 않는다.
커밋된 DB 변경은 앱 롤백으로 취소되지 않으므로 migration은 기존 앱과 호환되도록 작성한다.

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
