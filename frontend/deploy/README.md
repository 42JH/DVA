# 관리자 웹 배포

주소: https://dva-d109.duckdns.org/ (DuckDNS) · https://13.209.59.180/ (IP, 같은 화면)

백엔드가 도는 Lightsail 서버(13.209.59.180)의 호스트 nginx가 정적 빌드를 내주고, `/api`는 같은 nginx가 백엔드(127.0.0.1:8082)로 넘깁니다.
화면과 API가 같은 주소라서 세션 쿠키와 Origin 검사가 개발 서버(프록시)와 똑같이 동작합니다.

## 자동 배포 (기본)

develop-fe에 머지되면 젠킨스 `dva-fe` 작업이 2분 안에 알아채고 아래 순서로 배포합니다. 단계는 `frontend/Jenkinsfile`에 있습니다.

1. `npm ci` → `npm run lint` → `npm run build`(타입 검사 포함)
2. 빌드 묶음을 서버에 올려 `release.sh`로 교체
3. 서버가 방금 만든 번들을 내주는지 확인

중간에 하나라도 실패하면 서버는 이전 판 그대로입니다. 작업 화면: https://dva-d109.duckdns.org/jenkins/job/dva-fe/

백엔드 파이프라인과 같은 에이전트(`linux-docker-builder`, Node 24)와 같은 배포 키(`dva-lightsail-ssh`)를 씁니다.
서버 확인 값은 `known_hosts`(백엔드 `infra/deploy/known_hosts`와 같은 값)이고, 다르면 연결하지 않습니다.

### 서버의 판 보관과 되돌리기

판마다 `/var/www/dva-releases/<커밋-빌드번호>`에 따로 풀고, `/var/www/dva`는 지금 판을 가리키는 링크입니다. 링크만 바꾸므로 교체 순간에 반쯤 바뀐 파일이 나가지 않습니다.
최근 5개 판을 남깁니다. 바로 전 판으로 되돌리기는 빌드 없이 몇 초면 됩니다.

```bash
ssh -i <pem 키> ubuntu@13.209.59.180 'sudo bash -s -- --rollback' < frontend/deploy/release.sh
```

## 손 배포 (젠킨스가 멈췄을 때)

내 PC Git Bash, Node 24. 자동 배포와 같은 교체 방식입니다.

```bash
cd frontend && npm ci
bash deploy/deploy.sh <pem 키 경로>
```

pem 키는 서버 담당에게 따로 받습니다. git에 올리지 않습니다.

## 젠킨스 작업 만들기 (처음 한 번)

젠킨스 관리 → Script Console에서 `jenkins-fe-job.groovy` 내용을 붙여 넣고 실행합니다.
`dva-fe` 작업이 생기고 첫 빌드가 돌며, 그때 `Jenkinsfile`의 2분 확인(pollSCM)이 등록됩니다. 깃랩 웹훅은 필요 없습니다.

## 도메인 (DuckDNS)

- `dva-d109.duckdns.org` → 13.209.59.180. DuckDNS 계정(h202407)에서 관리합니다. 서버 IP가 고정이라 토큰 갱신은 쓰지 않습니다.
- 인증서: 서버 certbot의 `dva-duckdns`. 다른 인증서와 같은 갱신 타이머(`dva-certbot-renew`)가 자동으로 갱신합니다.
- nginx: `/etc/nginx/sites-available/dva-ip`에 도메인용 80(https로 넘김) · 443 서버 블록이 있고, 경로는 IP 서버 블록과 함께 `/etc/nginx/snippets/dva-routes.conf` 한 파일을 씁니다. 경로를 바꿀 땐 그 파일만 고칩니다.
- 백엔드 `CORS_ORIGINS`에 `https://dva-d109.duckdns.org`가 들어 있어야 로그인됩니다.
- 관리자 웹 블록(`dva-routes.conf` 맨 아래)의 사본은 `nginx-admin-web.conf`입니다. 배포 스크립트는 nginx를 바꾸지 않으니, 서버에서 고치면 이 사본도 맞춥니다. 11/12에 JS · CSS 압축 3줄을 넣었습니다(`docs/fe-gzip-results.md`).

## 확인

- https://dva-d109.duckdns.org/ → 로그인 → F12 Network에서 `/api/auth/login` 200 · `/api/auth/me` 200
- 서버에서 지금 판: `readlink /var/www/dva`

## 안 될 때

| 증상 | 원인 | 조치 |
|---|---|---|
| 새로고침하면 404 (모든 경로) | `dva-routes.conf`의 관리자 웹 줄(`root /var/www/dva` · `try_files`)이 빠짐 | 그 줄을 다시 넣고 `sudo nginx -t && sudo systemctl reload nginx` |
| 도메인에서만 로그인 403 | 백엔드 `CORS_ORIGINS`에 도메인이 없음 | 백엔드 담당에게 추가 요청 |
| 화면이 옛 버전 | 브라우저 캐시 (index.html은 캐시 안 함, assets만 30일) | 강력 새로고침(Ctrl+Shift+R) |
| 젠킨스 배포 단계에서 host key 오류 | 서버 확인 값이 바뀜 | 백엔드 `infra/deploy/known_hosts`와 이 폴더 `known_hosts`를 같이 갱신 |
| 배포 뒤 화면이 깨짐 | 새 판 문제 | 위 되돌리기 한 줄 실행 후 원인 확인 |
