#!/usr/bin/env bash
# 빌드 묶음을 서버로 올리고 release.sh로 교체 — 젠킨스(frontend/Jenkinsfile)와 내 PC(deploy.sh)가 같이 씀
#   사용: bash deploy/ci-deploy.sh <묶음.tgz> <판 이름> <ssh 키> [ssh 사용자]
# 서버 호스트 키는 같은 폴더 known_hosts로 확인 (백엔드 배포 infra/deploy/known_hosts와 같은 값). 다르면 연결하지 않음
set -euo pipefail
tgz=${1:?묶음 경로}
name=${2:?판 이름}
key=${3:?ssh 키}
user=${4:-ubuntu}
host=${DEPLOY_HOST:-13.209.59.180}
here=$(cd "$(dirname "$0")" && pwd)

opts=(-i "$key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$here/known_hosts" -o ConnectTimeout=20)
remote=/tmp/dva-fe-$name.tgz
scp -q "${opts[@]}" "$tgz" "$user@$host:$remote"
# 시험용: DVA_RELEASES · DVA_LIVE를 주면 서버의 그 폴더에서 교체 (기본은 /var/www/dva-releases · /var/www/dva)
envs=()
[[ -n ${DVA_RELEASES:-} ]] && envs+=("DVA_RELEASES=$DVA_RELEASES")
[[ -n ${DVA_LIVE:-} ]] && envs+=("DVA_LIVE=$DVA_LIVE")
ssh "${opts[@]}" "$user@$host" "sudo env ${envs[*]} bash -s -- '$name' '$remote'" < "$here/release.sh"
