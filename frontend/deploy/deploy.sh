#!/usr/bin/env bash
# 디버 관리자 웹 배포 — 내 PC Git Bash 에서 실행, 몇 번 돌려도 같은 결과
#   사용: frontend/deploy/deploy.sh <pem 키>            (서버는 백엔드와 같은 Lightsail 13.209.59.180)
#   하는 일: npm run build → dist 를 서버로 복사 → /var/www/dva 교체 → nginx reload
#   nginx 설정은 안 건드림 — 서버의 /etc/nginx/sites-available/dva-ip(인프라 담당) 에 nginx-dva.conf 블록이 이미 들어가 있음
set -euo pipefail
KEY=${1:?Lightsail pem 키 경로}
HOST=${2:-13.209.59.180}
cd "$(dirname "$0")/.."

npm run build
rm -f dist/mockServiceWorker.js                       # 개발용 가짜 API 워커는 서버에 안 올림
ssh -i "$KEY" ubuntu@"$HOST" 'rm -rf ~/dva-dist'
scp -i "$KEY" -q -r dist ubuntu@"$HOST":~/dva-dist
ssh -i "$KEY" ubuntu@"$HOST" 'set -e
sudo mkdir -p /var/www/dva && sudo rm -rf /var/www/dva/* && sudo cp -r ~/dva-dist/* /var/www/dva/
sudo nginx -t && sudo systemctl reload nginx'
echo "done → https://$HOST/   (reload 직후 1초쯤은 옛 worker 가 404 를 줄 수 있음 — 새로고침)"
