#!/usr/bin/env bash
set -euo pipefail
release_dir=${1:?Usage: bash upload.sh RELEASE_DIR SSH_KEY}
identity_file=${2:?Specify SSH private key}
source "$(dirname -- "${BASH_SOURCE[0]}")/ssh-common.sh"
cd "$release_dir"
release=$(basename -- "$PWD")
[[ "$release" =~ ^[0-9a-f]{40}-[0-9]+$ ]] || exit 2
for file in liquibase-image.tar image-name.txt image-id.txt run-service.sh remote.sh verification.json SHA256SUMS; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "Missing/linked release file: $file" >&2; exit 1; }
done
sha256sum --check --strict SHA256SUMS
remote_dir="$remote_root/$release"
# Atomic mkdir refuses duplicate releases. A failed transfer requires a new build.
ssh "${ssh_options[@]}" "$server" "umask 077; mkdir -p '$remote_root' && mkdir '$remote_dir'"
scp "${ssh_options[@]}" liquibase-image.tar image-name.txt image-id.txt run-service.sh remote.sh verification.json SHA256SUMS "$server:$remote_dir/"
ssh "${ssh_options[@]}" "$server" "cd '$remote_dir' && sha256sum --check --strict SHA256SUMS && bash remote.sh prepare"
echo "Release uploaded and image verified: $remote_dir"
