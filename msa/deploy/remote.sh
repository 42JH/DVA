#!/usr/bin/env bash
# Runs on the MSA server from the transferred release directory.
set -euo pipefail
action=${1:?Specify prepare, preview or apply}
service=${2:-}
expected=${3:-}
case "$action" in prepare|preview|apply|prepare-cutover|restore-cutover) ;; *) exit 2 ;; esac
if [[ "$action" != prepare ]]; then
  case "$service" in customer|operations|order|consultation|delivery) ;; *) exit 2 ;; esac
fi
if [[ "$action" == apply && ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then exit 2; fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
release=$(basename -- "$PWD")
[[ "$PWD" == "/home/ubuntu/msa-deploy/releases/$release" && "$release" =~ ^[0-9a-f]{40}-[0-9]+$ ]] || exit 2
sha256sum --check --strict SHA256SUMS
image=$(cat image-name.txt)
image_id=$(cat image-id.txt)
[[ "$image" == "docker.io/library/dva-liquibase:$release" && "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 2
exec 9>/home/ubuntu/msa-deploy/deploy.lock
flock -n 9 || { echo 'Another MSA DB operation is running.' >&2; exit 1; }

# Local import is supported only for the agreed single-node setup.
sudo -n k3s kubectl get nodes -o json | python3 -c '
import json,sys
nodes=json.load(sys.stdin)["items"]
if len(nodes)!=1: raise SystemExit("Expected exactly one k3s node.")
n=nodes[0]
info=n["status"]["nodeInfo"]
ready=any(c["type"]=="Ready" and c["status"]=="True" for c in n["status"]["conditions"])
if not ready or n.get("spec",{}).get("unschedulable") or info["architecture"]!="amd64" or info["operatingSystem"]!="linux":
    raise SystemExit("Expected a schedulable Ready linux/amd64 node.")
'
sudo -n k3s kubectl get namespace dva -o name
if [[ "$action" == prepare ]]; then
  sudo -n k3s ctr -n k8s.io images import "$PWD/liquibase-image.tar"
fi
sudo -n k3s ctr -n k8s.io images ls | python3 -c '
import sys
rows=[line.split() for line in sys.stdin if line.split() and line.split()[0]==sys.argv[1]]
if len(rows)!=1 or len(rows[0])<3 or rows[0][2]!=sys.argv[2]:
    raise SystemExit("Imported image digest does not match the CI image.")
' "$image" "$image_id"
if [[ "$action" == prepare-cutover || "$action" == restore-cutover ]]; then
  [[ "$service" == order && -z "$expected" ]] || exit 2
  mode=prepare
  if [[ "$action" == restore-cutover ]]; then mode=restore; fi
  python3 ./prepare-cutover.py "$mode" "$release"
  exit 0
fi
if [[ "$action" != prepare ]]; then
  sudo -n k3s kubectl -n dva get secret "$service-db" -o name
  if [[ "$action" == preview ]]; then
    bash ./run-service.sh "$service" preview "$image" | tee "$service-preview.log"
    exit 0
  fi
  [[ -f "$service-preview.log" ]] || { echo 'A release-bound preview is required.' >&2; exit 1; }
  grep -Fx "DVA_PENDING_SHA256=$expected" "$service-preview.log"
  if [[ "$action" == apply && ( "$service" == order || "$service" == consultation ) ]]; then
    if grep -Fxq 'DVA_QUIESCENT_CUTOVER_REQUIRED=055' "$service-preview.log"; then
      # Both snapshots must be taken at one quiescent business epoch, as in source 055.
      python3 ./prepare-cutover.py verify "$release"
      # Fence old releases before DDL, including an ambiguous migration/annotation response.
      sudo -n k3s kubectl annotate namespace dva 'dva.ssafy.io/parcel-drafts-schema=055' --overwrite
    fi
  fi
  bash ./run-service.sh "$service" "$action" "$image" "$expected"
fi

# Record only a successfully applied and verified migration, never a CI-only success.
if [[ "$action" == apply ]]; then
  sudo -n k3s kubectl annotate namespace dva \
    "dva.ssafy.io/db-$service-commit=${release%-*}" --overwrite
fi
