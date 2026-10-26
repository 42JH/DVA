#!/usr/bin/env bash
set -euo pipefail
umask 077
version="${1:-}"
[[ "$version" =~ ^[a-z0-9][a-z0-9.-]{0,79}$ ]] || { echo 'Usage: package.sh <release-version>' >&2; exit 1; }
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
release_dir="$repo_root/.deploy/$version"
[[ ! -e "$release_dir" ]] || { echo 'Release already exists.' >&2; exit 1; }
cd "$repo_root"
docker info >/dev/null
docker build --platform linux/amd64 -t "dva-backend:$version" ./backend
docker pull --platform linux/amd64 postgres:17-alpine
docker pull --platform linux/amd64 nginx:stable-alpine
docker tag postgres:17-alpine "dva-postgres:$version"
docker tag nginx:stable-alpine "dva-nginx:$version"
images=("dva-backend:$version" "dva-postgres:$version" "dva-nginx:$version")
for image in "${images[@]}"; do
 [[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" == linux/amd64 ]] || exit 1
done
mkdir -p "$release_dir/infra/nginx" "$release_dir/infra/database" "$release_dir/backend/migrations"
docker image save --output "$release_dir/images.tar" "${images[@]}"
(cd "$release_dir" && sha256sum images.tar > images.tar.sha256)
printf 'BACKEND_IMAGE=dva-backend:%s\nPOSTGRES_IMAGE=dva-postgres:%s\nNGINX_IMAGE=dva-nginx:%s\n' \
 "$version" "$version" "$version" > "$release_dir/release.env"
cp compose.prod.yaml "$release_dir/"
cp infra/nginx/default.prod.conf "$release_dir/infra/nginx/"
cp infra/deploy/deploy.sh "$release_dir/deploy.sh"
cp infra/database/{migrate.sh,verify.sql} "$release_dir/infra/database/"
cp backend/migrations/[0-9][0-9][0-9]-*.sql "$release_dir/backend/migrations/"
(cd "$release_dir" && sha256sum compose.prod.yaml release.env deploy.sh infra/nginx/default.prod.conf \
 infra/database/migrate.sh infra/database/verify.sql backend/migrations/[0-9][0-9][0-9]-*.sql > release-files.sha256)
echo "Release ready: $release_dir"
