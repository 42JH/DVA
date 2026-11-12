#!/usr/bin/env bash
# Jenkins(빌더 노드)에서 실행: 소스를 대상 서버로 보내 이미지를 빌드하고 릴리스 파일을 올린 뒤 deploy.sh를 부른다.
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
# 비밀값은 Jenkins Secret file credential(dva-ai)로 받아 배포 때 shared/.env로 올린다
[[ -s "${AI_ENV_FILE:?Set AI_ENV_FILE}" ]] || { echo 'Empty or missing AI env credential file.' >&2; exit 1; }
ai_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
server="$ssh_user@${DEPLOY_HOST:?Set DEPLOY_HOST}"
remote_root=/home/ubuntu/dva-ai
image="dva-ai-server:$version"
check_image="dva-persona-check:$version"

key_dir="$(mktemp -d)"
trap 'rm -rf -- "$key_dir"' EXIT
install -m 600 "$identity_file" "$key_dir/identity"
options=(-i "$key_dir/identity" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
 -o "UserKnownHostsFile=$ai_root/deploy/known_hosts" -o ConnectTimeout=15)
ssh "${options[@]}" "$server" "test -d $remote_root/shared -a -w $remote_root/shared && sudo -n docker info >/dev/null" </dev/null \
 || { echo "Server check failed: $remote_root/shared must be a writable directory and sudo docker must work." >&2; exit 1; }
if [[ "$mode" == --verify-only ]]; then
 echo 'SSH credential, pinned host key and server prerequisites verified. No release transfer or deployment.'
 exit 0
fi

ssh "${options[@]}" "$server" "umask 077 && cat > $remote_root/shared/.env.tmp && mv $remote_root/shared/.env.tmp $remote_root/shared/.env" < "$AI_ENV_FILE"

docker image inspect "$image" >/dev/null
ssh "${options[@]}" "$server" "test ! -e $remote_root/releases/$version && mkdir -p $remote_root/releases/$version $remote_root/shared/data" </dev/null
# 2GB 이미지를 통째로 보내지 않고 소스(수 MB)만 보내 대상 서버에서 다시 빌드한다. 서버의 레이어 캐시로 바뀐 층만 빌드된다
tar -C "$ai_root" --exclude=.venv -cf - . \
 | ssh "${options[@]}" "$server" "sudo -n docker build --quiet --pull --platform linux/amd64 --tag $image - >/dev/null"
# 시험 창구(persona_check) 이미지는 방금 빌드한 AI 서버 이미지 위에 얹는다(같은 커밋의 통화 코드). 운영 통화와 무관하므로
# 빌드가 실패해도 AI 서버 배포는 계속한다(deploy.sh가 이미지가 없으면 시험 창구만 건너뛴다)
tar -C "$ai_root" --exclude=.venv -cf - . \
 | ssh "${options[@]}" "$server" "sudo -n docker build --quiet --platform linux/amd64 --build-arg AI_IMAGE=$image --file persona_check/Dockerfile --tag $check_image - >/dev/null" \
 || echo 'Persona check image build failed. The AI server deployment continues.' >&2
# 주소DB는 릴리스마다 보내지 않고 서버의 shared/data에 한 번 올려 둔다(spec/address.md)
printf 'AI_IMAGE=%s\nADDRESS_DATA_DIR=%s\nPERSONA_CHECK_IMAGE=%s\n' "$image" "$remote_root/shared/data" "$check_image" > "$key_dir/release.env"
tar -C "$ai_root" -cf - compose.yaml config prompts \
 -C "$ai_root/deploy" deploy.sh apply-faq-runtime.py compose.deploy.yaml compose.persona-check.yaml -C "$key_dir" release.env \
 | ssh "${options[@]}" "$server" "tar -xf - -C $remote_root/releases/$version"
ssh "${options[@]}" "$server" "bash $remote_root/releases/$version/deploy.sh" </dev/null
