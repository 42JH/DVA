#!/usr/bin/env bash
# 디버 관리자 웹을 Lightsail 서버(Ubuntu 24.04)에 올림 — 내 PC Git Bash 에서 실행, 몇 번 돌려도 같은 결과
#   사용: frontend/deploy/deploy.sh <서버 IP> <Lightsail 키 .pem>
#   하는 일: npm run build → dist 와 nginx 설정을 서버로 복사 → (처음이면 nginx 설치) → /var/www/dva 교체 → nginx reload
set -euo pipefail
IP=${1:?서버 IP}
KEY=${2:?Lightsail 키 .pem}
cd "$(dirname "$0")/.."

npm run build
scp -i "$KEY" -r dist deploy/nginx-dva.conf ubuntu@"$IP":~/
ssh -i "$KEY" ubuntu@"$IP" bash -s <<'EOF'
set -e
command -v nginx >/dev/null || (sudo apt-get update -q && sudo apt-get install -y -q nginx)
sudo mkdir -p /var/www/dva && sudo rm -rf /var/www/dva/* && sudo cp -r ~/dist/* /var/www/dva/
sudo cp ~/nginx-dva.conf /etc/nginx/sites-available/dva
sudo ln -sf /etc/nginx/sites-available/dva /etc/nginx/sites-enabled/dva && sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
EOF
echo "done → http://$IP"
