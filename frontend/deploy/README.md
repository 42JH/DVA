# 관리자 웹 배포 — AWS Lightsail

정적 빌드(`dist/`)를 Lightsail 인스턴스의 nginx가 서빙하고, `/api`는 같은 nginx가 백엔드(EC2)로 넘깁니다.
브라우저에서는 화면과 API가 같은 주소라 세션 쿠키 · Origin 검사가 개발 서버(프록시)와 똑같이 동작합니다.

## 준비 (한 번)

1. **Lightsail 인스턴스**: 리전 서울 · Linux/Unix · OS 전용 **Ubuntu 24.04** · $5 요금제 → 생성 후 **고정 IP 연결**, 방화벽에 HTTP 80 (HTTPS면 443도).
2. **SSH 키(.pem)**: Lightsail 계정 페이지 → SSH 키 다운로드. 팀 공유는 DM으로 — **git에 올리지 않음**.
3. **BE 요청**: Origin 허용 목록에 `http://<고정IP>` 추가 (지금은 `http://localhost:5173`만).

## 배포 (매번) — 내 PC Git Bash, Node 24

```bash
cd frontend && npm ci            # 처음 한 번 (빌드에 필요)
bash deploy/deploy.sh <고정IP> <pem 경로>
```

하는 일: `npm run build` → `dist/`와 `nginx-dva.conf`를 서버로 복사 → (처음이면 nginx 설치) → `/var/www/dva` 교체 → `nginx reload`. 몇 번 돌려도 같은 결과. 끝나면 `http://<고정IP>`.

## 확인

- `http://<고정IP>/` 로그인 화면 → 로그인 → F12 Network에서 `/api/auth/login` 200, `/api/auth/me` 200
- 서버에서: `sudo nginx -t` · `sudo tail -f /var/log/nginx/error.log`

## 안 될 때

| 증상 | 원인 | 조치 |
|---|---|---|
| 로그인 200인데 바로 로그인 화면으로 돌아옴 | 세션 쿠키에 `Secure`가 있어 http에서 버려짐 | `nginx-dva.conf`의 `proxy_cookie_flags` 주석 해제 후 재배포, 또는 아래 HTTPS |
| `/api/*` 401 · 403 | BE Origin 허용 목록에 이 주소가 없음 | BE에 추가 요청. 급하면 `proxy_set_header Origin` 주석 해제(임시) |
| 새로고침하면 404 | nginx 설정이 안 들어감 | `ls /etc/nginx/sites-enabled/` 에 `dva`만 있는지, `sudo nginx -t` |

## HTTPS (선택, 도메인 없어도 됨)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo sed -i 's/server_name _;/server_name <IP를 -로>.sslip.io;/' /etc/nginx/sites-available/dva   # 예: 3-35-1-2.sslip.io
sudo certbot --nginx -d <IP를 -로>.sslip.io
```

이후 주소는 `https://<IP를 -로>.sslip.io` — BE Origin 허용 목록도 이 주소로. (재배포하면 `server_name`이 `_`로 돌아가니 `nginx-dva.conf`를 그 도메인으로 바꿔 두는 게 편함)

## 다른 방법 (지금은 안 씀)

- 도커: Lightsail 컨테이너 서비스($7~)에 멀티스테이지 Dockerfile(node 빌드 → nginx) — 저장소 `compose.yaml`(EC2용)과 합칠 때 같이 결정.
