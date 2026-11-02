#!/usr/bin/env bash
# 관리자 웹 손 배포 — 젠킨스(frontend/Jenkinsfile)와 같은 방식. 젠킨스가 멈췄거나 급할 때 내 PC Git Bash에서
#   사용: bash frontend/deploy/deploy.sh <pem 키>
#   하는 일: npm run build → 묶음 → ci-deploy.sh로 서버에 올려 release.sh로 교체 (판 보관 · 되돌리기도 같음)
# 되돌리기: ssh로 서버에 들어가 sudo bash release.sh --rollback  (또는 아래 한 줄)
#   ssh -i <pem 키> ubuntu@13.209.59.180 'sudo bash -s -- --rollback' < frontend/deploy/release.sh
set -euo pipefail
key=${1:?Lightsail pem 키 경로}
cd "$(dirname "$0")/.."

npm run build
rm -f dist/mockServiceWorker.js # 개발용 가짜 API 워커는 서버에 안 올림
name="$(git rev-parse --short=12 HEAD)-local-$(date +%Y%m%d%H%M%S)"
tar -czf "dva-fe-$name.tgz" -C dist .
bash deploy/ci-deploy.sh "dva-fe-$name.tgz" "$name" "$key"
rm -f "dva-fe-$name.tgz"
echo "done → https://dva-d109.duckdns.org/ · https://13.209.59.180/"
