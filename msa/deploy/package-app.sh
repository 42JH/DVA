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

ingress_host=${MSA_INGRESS_HOST:-}
cors_origins=${MSA_CORS_ORIGINS:-}
filters=(-e "s/:RELEASE_TAG/:$release/g")
if grep -Fq '__MSA_INGRESS_HOST__' "$manifest"; then
  [[ "$ingress_host" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || {
    echo 'Set MSA_INGRESS_HOST to the public Ingress hostname.' >&2
    exit 2
  }
  filters+=(-e "s|__MSA_INGRESS_HOST__|$ingress_host|g")
fi
if grep -Fq '__MSA_CORS_ORIGINS__' "$manifest"; then
  origin='https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]+)?'
  [[ "$cors_origins" =~ ^$origin(,$origin)*$ ]] || {
    echo 'Set MSA_CORS_ORIGINS to a comma-separated list of HTTPS origins.' >&2
    exit 2
  }
  filters+=(-e "s|__MSA_CORS_ORIGINS__|$cors_origins|g")
fi

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

sed "${filters[@]}" "$manifest" > "$dest/k8s.yaml"

if grep -Eq 'RELEASE_TAG|__MSA_(INGRESS_HOST|CORS_ORIGINS)__' "$dest/k8s.yaml"; then
  echo 'Unresolved deployment value in manifest.' >&2
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
