#!/usr/bin/env bash
# Jenkins(빌더 노드)에서 실행: 빌드한 이미지와 릴리스 파일을 대상 서버로 보내고 deploy.sh를 부른다.
# 백엔드 infra/deploy/upload.sh와 같은 방식(호스트 키 고정, --verify-only).
# 사용: upload.sh <version> <ssh 개인 키 파일> <ssh 사용자> [--verify-only]
set -euo pipefail
umask 077
version="${1:-}"
identity_file="${2:-}"
ssh_user="${3:-ubuntu}"
mode="${4:-}"
[[ -z "$mode" || "$mode" == --verify-only ]] || { echo 'Unknown upload mode.' >&2; exit 1; }
[[ "$version" =~ ^[a-z0-9][a-z0-9.-]{0,79}$ ]] || { echo 'Invalid release version.' >&2; exit 1; }
[[ "$ssh_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 1
[[ -f "$identity_file" ]] || { echo 'Missing SSH credential file.' >&2; exit 1; }
ai_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
server="$ssh_user@${DEPLOY_HOST:?Set DEPLOY_HOST}"
remote_root=/home/ubuntu/dva-ai
image="dva-ai-server:$version"

key_dir="$(mktemp -d)"
trap 'rm -rf -- "$key_dir"' EXIT
install -m 600 "$identity_file" "$key_dir/identity"
options=(-i "$key_dir/identity" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
 -o "UserKnownHostsFile=$ai_root/deploy/known_hosts" -o ConnectTimeout=15)
ssh "${options[@]}" "$server" "test -f $remote_root/shared/.env && sudo -n docker info >/dev/null" </dev/null
if [[ "$mode" == --verify-only ]]; then
 echo 'SSH credential, pinned host key and server prerequisites verified. No release transfer or deployment.'
 exit 0
fi

docker image inspect "$image" >/dev/null
ssh "${options[@]}" "$server" "test ! -e $remote_root/releases/$version && mkdir -p $remote_root/releases/$version" </dev/null
docker save "$image" | gzip | ssh "${options[@]}" "$server" 'gunzip | sudo -n docker image load >/dev/null'
printf 'AI_IMAGE=%s\n' "$image" > "$key_dir/release.env"
tar -C "$ai_root" -cf - compose.yaml config prompts \
 -C "$ai_root/deploy" deploy.sh compose.deploy.yaml -C "$key_dir" release.env \
 | ssh "${options[@]}" "$server" "tar -xf - -C $remote_root/releases/$version"
ssh "${options[@]}" "$server" "bash $remote_root/releases/$version/deploy.sh" </dev/null
