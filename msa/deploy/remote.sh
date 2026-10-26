#!/usr/bin/env bash
# Runs on the MSA server from the transferred release directory.
set -euo pipefail
action=${1:?Specify prepare, preview or apply}
service=${2:-}
expected=${3:-}
case "$action" in prepare|preview|apply) ;; *) exit 2 ;; esac
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
sudo -n k3s crictl inspecti "$image" | python3 -c '
import json,sys
if json.load(sys.stdin)["status"]["id"] != sys.argv[1]:
    raise SystemExit("Imported image ID does not match the CI image.")
' "$image_id"
if [[ "$action" != prepare ]]; then
  sudo -n k3s kubectl -n dva get secret "$service-db" -o name
  bash ./run-service.sh "$service" "$action" "$image" "$expected"
fi

# Record only an approved, successfully verified DB apply; app delivery does not infer approval from CI.
if [[ "$action" == apply ]]; then
  sudo -n k3s kubectl annotate namespace dva \
    "dva.ssafy.io/db-$service-commit=${release%-*}" --overwrite
fi
