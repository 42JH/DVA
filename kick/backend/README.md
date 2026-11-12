# Kick 백엔드

NestJS 모놀리스와 PostgreSQL 17을 Docker Compose로 실행합니다. 기본 API 주소는
`http://127.0.0.1:3010/health`입니다. DB 질의가 성공하면 200, DB 연결이 실패하면 503을 반환합니다.

로컬에서 `.env.example`을 `.env`로 복사하고 `POSTGRES_PASSWORD`에 로컬 DB 비밀번호를 넣습니다.

```sh
docker compose up --build -d --wait
curl -f http://127.0.0.1:3010/health
docker compose down
```

PostgreSQL은 Compose 내부 네트워크에서 접근합니다. DB 볼륨은 일반적인 `docker compose down` 후에도
보존됩니다. 로컬 포트가 겹치면 `.env`의 `KICK_BACKEND_PORT`를 바꿉니다.

Jenkins Pipeline Job은 GitLab의 배포 대상 브랜치에서 `kick/backend/Jenkinsfile`을 읽습니다.
Jenkins가 브랜치 변경을 주기적으로 확인하고 CI를 실행합니다.
빌드는 린트, 포맷 검사, 컴파일을 실행하고 별도 Compose 프로젝트에서 앱과 PostgreSQL을 띄워 검증합니다.
`DEPLOY_KICK=true`로 실행하면 검증한 커밋 이미지가 같은 서버의 `kick-backend` 프로젝트에 배포됩니다.
배포용 DB 비밀번호는 Jenkins 홈의 `kick-backend/.env`에 첫 배포 때 생성하고 이후 재사용합니다.
`3010`은 서버의 루프백에서 접근합니다.

## Jenkins 연결

| 항목 | 설정 |
| --- | --- |
| Job | `kick-backend` (Pipeline) |
| Definition | Pipeline script from SCM / Git |
| Repository URL | `https://lab.ssafy.com/s15-final/S15P31D109.git` |
| Credentials | `gitlab-ssafy` |
| Branch Specifier | `*/chore/kick-backend-bootstrap` |
| Script Path | `kick/backend/Jenkinsfile` |

Lightsail의 Jenkins `built-in` 노드는 Docker를 실행할 수 있습니다. 별도 노드가 필요할 때는
**Manage Jenkins → Nodes → New Node → Permanent Agent**에서 이름·작업 경로·라벨을 등록하고
SSH 연결을 설정합니다. 이 Job의 배포 단계가 실행되는 노드는 Kick 스택이 위치한 Lightsail의
Docker에 접근할 수 있어야 합니다. [Jenkins 에이전트 설정](https://www.jenkins.io/doc/book/using/using-agents/)

CLI용 API 토큰은 Jenkins에 로그인한 후 우측 상단 사용자 메뉴의 **Security → API Token →
Add new Token**에서 발급합니다. CLI에는 저장소 밖에 둔 `사용자명:토큰` 파일을
`-auth @파일경로`로 전달합니다. Job 생성과 빌드 권한은 토큰을 발급한 계정의 권한을 따릅니다.
[Jenkins CLI 인증](https://www.jenkins.io/doc/book/managing/cli/)
