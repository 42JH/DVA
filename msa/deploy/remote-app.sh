#!/usr/bin/env bash
set -euo pipefail

service=${1:?Specify service}
release=${2:?Specify release}

[[ "$service" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || exit 2
[[ "$release" =~ ^[0-9a-f]{40}-[0-9]+$ ]] || exit 2

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
expected_dir="/home/ubuntu/msa-deploy/apps/$release/$service"
[[ "$(pwd -P)" == "$expected_dir" ]] || {
  echo 'Unexpected deployment directory.' >&2
  exit 1
}

sha256sum --check --strict SHA256SUMS

image=$(cat image-name.txt)
image_id=$(cat image-id.txt)
[[ "$image" == "docker.io/library/dva-$service:$release" ]] || exit 2
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 2

# DB 배포와 앱 배포가 서버에서 동시에 진행되지 않도록 한다.
exec 9>/home/ubuntu/msa-deploy/deploy.lock
flock -n 9 || {
  echo 'Another MSA deployment is running.' >&2
  exit 1
}

# 이미지를 한 서버에 직접 등록하므로 단일 노드인지 확인한다.
sudo -n k3s kubectl get nodes -o json | python3 -c '
import json, sys

nodes = json.load(sys.stdin)["items"]
if len(nodes) != 1:
    raise SystemExit("Expected exactly one k3s node.")

node = nodes[0]
info = node["status"]["nodeInfo"]
ready = any(
    c["type"] == "Ready" and c["status"] == "True"
    for c in node["status"]["conditions"]
)
if (
    not ready
    or node.get("spec", {}).get("unschedulable")
    or info["architecture"] != "amd64"
    or info["operatingSystem"] != "linux"
):
    raise SystemExit("Expected a schedulable Ready linux/amd64 node.")
'

sudo -n k3s kubectl get namespace dva -o name

sudo -n k3s ctr -n k8s.io images import "$PWD/image.tar"

sudo -n k3s ctr -n k8s.io images ls | python3 -c '
import sys

expected_name, expected_digest = sys.argv[1:]
matches = [
    line.split()
    for line in sys.stdin
    if line.split() and line.split()[0] == expected_name
]

if len(matches) != 1 or len(matches[0]) < 3:
    raise SystemExit("Expected exactly one imported image.")

actual_digest = matches[0][2]
if actual_digest != expected_digest:
    raise SystemExit(
        f"Image digest mismatch: CI={expected_digest}, "
        f"containerd={actual_digest}"
    )

print(f"Verified imported image: {expected_name} {actual_digest}")
' "$image" "$image_id"

# 적용 전 서버의 Kubernetes API로 설정을 검증한다.
sudo -n k3s kubectl apply --dry-run=server -f k8s.yaml

# 장애 조사와 복구 판단에 사용할 기존 상태를 남긴다.
sudo -n k3s kubectl -n dva get deployment "$service" \
  --ignore-not-found -o yaml > previous-deployment.yaml

sudo -n k3s kubectl apply -f k8s.yaml

if ! sudo -n k3s kubectl -n dva rollout status \
  "deployment/$service" --timeout=240s; then
  sudo -n k3s kubectl -n dva get pods -o wide || true
  sudo -n k3s kubectl -n dva describe deployment "$service" || true
  echo 'Rollout failed. Inspect the deployment before retrying.' >&2
  exit 1
fi

actual_image=$(sudo -n k3s kubectl -n dva get deployment "$service" \
  -o jsonpath='{.spec.template.spec.containers[0].image}')
[[ "$actual_image" == "$image" ]] || {
  echo 'Deployment image changed unexpectedly.' >&2
  exit 1
}

echo "DVA_APP_ROLLOUT_COMPLETE=$service"