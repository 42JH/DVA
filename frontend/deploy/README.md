# 관리자 웹 배포 — https://13.209.59.180/

백엔드가 도는 Lightsail 서버(13.209.59.180)의 호스트 nginx 가 정적 빌드(`dist/`)를 서빙합니다.
`/api` 는 같은 nginx 가 백엔드(127.0.0.1:8082)로 넘기므로 화면과 API 가 같은 주소 → 세션 쿠키 · Origin 검사가 개발 서버(프록시)와 똑같이 동작하고, HTTPS(Let's Encrypt)도 이미 있습니다.

## 배포 (누구나) — 내 PC Git Bash, Node 24

```bash
cd frontend && npm ci                       # 처음 한 번 (빌드에 필요)
bash deploy/deploy.sh <pem 키 경로>          # 예: ~/Downloads/dva-monolith.pem
```

하는 일: `npm run build` → `dist/` 를 서버 `~/dva-dist` 로 복사 → `/var/www/dva` 교체 → `nginx reload`. 1분 안 걸림.
pem 키(`dva-monolith.pem`)는 서버 담당에게 DM 으로 받음 — **git 에 올리지 않음**.

## 확인

- https://13.209.59.180/ → 로그인 화면 → 로그인 → F12 Network 에서 `/api/auth/login` 200 · `/api/auth/me` 200
- 서버에서: `sudo nginx -t` · `sudo tail -f /var/log/nginx/error.log`

## 서버 쪽 (한 번만, 11/01 완료)

- `/etc/nginx/sites-available/dva-ip` 443 서버 블록의 `location / { return 404; }` 를 `nginx-dva.conf` 의 블록으로 교체 (백업 `dva-ip.before-admin-web-20261101T100227Z`)
- `/var/www/dva` 생성. BE 는 `https://13.209.59.180` Origin 을 이미 허용(401 ≠ 403 확인)

## 안 될 때

| 증상 | 원인 | 조치 |
|---|---|---|
| 배포 직후 404 | reload 중 옛 worker 가 응답 | 1~2초 뒤 새로고침 |
| 새로고침하면 404 (모든 경로) | `dva-ip` 의 관리자 웹 블록이 빠짐 (인프라 변경) | `nginx-dva.conf` 블록을 다시 넣고 `sudo nginx -t && sudo systemctl reload nginx` |
| `/api/*` 403 | BE Origin 허용 목록 | BE 에 `https://13.209.59.180` 확인 요청 |
| 화면이 옛 버전 | 브라우저 캐시 (index.html 은 캐시 안 함, assets 만 30일) | 강력 새로고침(Ctrl+Shift+R) |
