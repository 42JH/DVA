#!/usr/bin/env bash
set -euo pipefail
identity_file=${1:?Specify SSH private key}
[[ "${RELEASE_NAME:?}" =~ ^[0-9a-f]{40}-[0-9]+$ ]] || exit 2
mapfile -t services < msa-release/databases.txt
(( ${#services[@]} > 0 )) || exit 0
for service in "${services[@]}"; do
  case "$service" in customer|operations|order|consultation|delivery) ;; *) exit 2 ;; esac
done
mkdir -p msa-release/db-logs
bash msa/deploy/upload.sh "msa-release/$RELEASE_NAME" "$identity_file"
for service in "${services[@]}"; do
  log="msa-release/db-logs/$service"
  bash msa/deploy/run-remote.sh "$RELEASE_NAME" "$service" preview "$identity_file" 2>&1 | tee "$log-preview.log"
  mapfile -t fingerprints < <(sed -n 's/^DVA_PENDING_SHA256=\([0-9a-f]\{64\}\)$/\1/p' "$log-preview.log")
  (( ${#fingerprints[@]} == 1 )) || { echo 'Expected one pending changeset fingerprint.' >&2; exit 1; }
  bash msa/deploy/run-remote.sh "$RELEASE_NAME" "$service" apply "$identity_file" "${fingerprints[0]}" 2>&1 | tee "$log-apply.log"
  grep -Fx "DVA_MIGRATION_COMPLETE=$service" "$log-apply.log"
done
