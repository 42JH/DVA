#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo"
: "${SOURCE_COMMIT:?}" "${BUILD_NUMBER:?}" "${DB_IMAGE:?}"
release="${SOURCE_COMMIT}-${BUILD_NUMBER}"
[[ "$release" =~ ^[0-9a-f]{40}-[0-9]+$ ]] || exit 2
[[ "$DB_IMAGE" == "docker.io/library/dva-liquibase:$release" ]] || exit 2

# Bind the package to the image actually tested, not just a mutable tag.
image_id=$(docker image inspect "$DB_IMAGE" --format '{{.Id}}')
python3 - "$image_id" "$DB_IMAGE" <<'PY'
import json, sys
from pathlib import Path
report = json.loads(Path('msa/liquibase/verification.json').read_text())
if report.get('passed') is not True or report.get('imageId') != sys.argv[1] or report.get('image') != sys.argv[2]:
    raise SystemExit('The current image does not match a successful CI verification.')
PY
mkdir -p msa-release
dest="msa-release/$release"
mkdir "$dest"
docker save --output "$dest/liquibase-image.tar" "$DB_IMAGE"
[[ $(docker image inspect "$DB_IMAGE" --format '{{.Id}}') == "$image_id" ]] || exit 1
printf '%s\n' "$DB_IMAGE" > "$dest/image-name.txt"
printf '%s\n' "$image_id" > "$dest/image-id.txt"
cp msa/liquibase/run-service.sh "$dest/"
cp msa/deploy/remote.sh "$dest/"
cp msa/deploy/prepare-cutover.py "$dest/"
cp msa/liquibase/verification.json "$dest/"
cd "$dest"
sha256sum liquibase-image.tar image-name.txt image-id.txt run-service.sh remote.sh prepare-cutover.py verification.json > SHA256SUMS
