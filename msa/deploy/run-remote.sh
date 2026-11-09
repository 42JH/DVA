#!/usr/bin/env bash
set -euo pipefail
release=${1:?Specify release}
service=${2:?Specify DB service}
action=${3:?Specify preview or apply}
identity_file=${4:?Specify SSH private key}
expected=${5:-}
[[ "$release" =~ ^[0-9a-f]{40}-[0-9]+$ ]] || exit 2
case "$service" in customer|operations|order|consultation|delivery) ;; *) exit 2 ;; esac
case "$action" in preview|apply) ;; prepare-cutover|restore-cutover) [[ "$service" == order && -z "$expected" ]] || exit 2 ;; *) exit 2 ;; esac
if [[ "$action" == apply && ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then exit 2; fi
if [[ "$action" == preview && -n "$expected" ]]; then exit 2; fi
source "$(dirname -- "${BASH_SOURCE[0]}")/ssh-common.sh"
ssh -n "${ssh_options[@]}" "$server" \
  "cd '$remote_root/$release' && sha256sum --check --strict SHA256SUMS && bash remote.sh '$action' '$service' '$expected'"
