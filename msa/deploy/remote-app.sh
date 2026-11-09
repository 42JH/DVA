#!/usr/bin/env bash
set -euo pipefail
service=${1:?Specify service}
release=${2:?Specify release}
action=${3:-deploy}
case "$action" in prepare|apply|deploy) ;; *) exit 2 ;; esac
[[ "$service" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || exit 2
[[ "$release" =~ ^[0-9a-f]{40}-[0-9]+$ ]] || exit 2
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
[[ "$(pwd -P)" == "/home/ubuntu/msa-deploy/apps/$release/$service" ]] || exit 2
sha256sum --check --strict SHA256SUMS
# Shared with approved DB deployments.
exec 9>/home/ubuntu/msa-deploy/deploy.lock
flock -n 9 || { echo 'Another MSA deployment is running.' >&2; exit 1; }
python3 ./app-release.py "$service" "$release" "$action"
