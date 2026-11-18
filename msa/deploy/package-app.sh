#!/usr/bin/env bash
set -euo pipefail

service=${1:?Specify service}
release=${RELEASE_NAME:?Specify RELEASE_NAME}

[[ "$service" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || exit 2
[[ "$release" =~ ^[0-9a-f]{40}-[0-9]+$ ]] || exit 2

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo"

manifest="msa/services/$service/k8s.yaml"
[[ -f "$manifest" ]] || {
  echo "Missing deployment manifest: $manifest" >&2
  exit 1
}

image="docker.io/library/dva-$service:$release"
image_id=$(docker image inspect "$image" --format '{{.Id}}')

# 기존 패키지를 덮어쓰지 않는다.
parent="msa-release/apps/$release"
dest="$parent/$service"
mkdir -p "$parent"
mkdir "$dest"

docker save --output "$dest/image.tar" "$image"

[[ $(docker image inspect "$image" --format '{{.Id}}') == "$image_id" ]] || {
  echo 'Image changed while packaging.' >&2
  exit 1
}

printf '%s\n' "$image" > "$dest/image-name.txt"
printf '%s\n' "$image_id" > "$dest/image-id.txt"

sed "s/:RELEASE_TAG/:$release/g" "$manifest" > "$dest/k8s.yaml"

if grep -q RELEASE_TAG "$dest/k8s.yaml"; then
  echo 'Unresolved image tag in manifest.' >&2
  exit 1
fi
grep -Fq "image: $image" "$dest/k8s.yaml" || {
  echo 'Deployment image does not match packaged image.' >&2
  exit 1
}

cp msa/deploy/remote-app.sh msa/deploy/app-release.py "$dest/"

cd "$dest"
sha256sum image.tar image-name.txt image-id.txt k8s.yaml remote-app.sh app-release.py > SHA256SUMS
sha256sum --check --strict SHA256SUMS

echo "Packaged: $service ($release)"