#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?Specify app package directory}
identity_file=${2:?Specify SSH private key}
action=${3:-deploy}
case "$action" in prepare|apply|deploy) ;; *) exit 2 ;; esac

source "$(dirname -- "${BASH_SOURCE[0]}")/ssh-common.sh"

cd "$release_dir"
service=$(basename -- "$PWD")
release=$(basename -- "$(dirname -- "$PWD")")

[[ "$service" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || exit 2
[[ "$release" =~ ^[0-9a-f]{40}-[0-9]+$ ]] || exit 2

files=(
  image.tar
  image-name.txt
  image-id.txt
  k8s.yaml
  remote-app.sh
  app-release.py
  SHA256SUMS
)

for file in "${files[@]}"; do
  [[ -f "$file" && ! -L "$file" ]] || {
    echo "Missing or linked package file: $file" >&2
    exit 1
  }
done

sha256sum --check --strict SHA256SUMS

remote_parent="/home/ubuntu/msa-deploy/apps/$release"
remote_dir="$remote_parent/$service"

# 동일 빌드의 기존 패키지를 덮어쓰지 않는다.
if [[ "$action" != apply ]]; then
  ssh -n "${ssh_options[@]}" "$server" \
    "umask 077; mkdir -p '$remote_parent' && mkdir '$remote_dir'"
  scp "${ssh_options[@]}" "${files[@]}" "$server:$remote_dir/"
fi

ssh -n "${ssh_options[@]}" "$server" \
  "cd '$remote_dir' && sha256sum --check --strict SHA256SUMS && bash remote-app.sh '$service' '$release' '$action'"
