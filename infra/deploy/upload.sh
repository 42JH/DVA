#!/usr/bin/env bash
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
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
release_dir="$repo_root/.deploy/$version"
server="$ssh_user@13.209.59.180"
remote_root=/home/ubuntu/dva-deploy
for file in images.tar images.tar.sha256 deploy.sh compose.prod.yaml release.env infra/nginx/default.prod.conf; do
 [[ -f "$release_dir/$file" ]] || { echo "Missing release file: $file" >&2; exit 1; }
done
(cd "$release_dir" && sha256sum --check --status images.tar.sha256)
key_dir="$(mktemp -d)"
trap 'rm -f -- "$key_dir/identity"; rmdir -- "$key_dir"' EXIT
install -m 600 "$identity_file" "$key_dir/identity"
options=(-i "$key_dir/identity" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
 -o "UserKnownHostsFile=$repo_root/infra/deploy/known_hosts" -o ConnectTimeout=15)
ssh "${options[@]}" "$server" "test -f $remote_root/shared/.env && sudo -n docker info >/dev/null" </dev/null
if [[ "$mode" == --verify-only ]]; then
 echo 'SSH credential, pinned host key and server prerequisites verified. No release transfer or deployment.'
 exit 0
fi
ssh "${options[@]}" "$server" "test ! -e $remote_root/releases/$version && mkdir -p $remote_root/releases" </dev/null
scp "${options[@]}" -r "$release_dir" "$server:./dva-deploy/releases/"
ssh "${options[@]}" "$server" "bash $remote_root/releases/$version/deploy.sh" </dev/null
