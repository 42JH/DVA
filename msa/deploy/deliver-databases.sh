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
declare -A approved
cutover=false
prepared=false
recover() {
  result=$?
  trap - EXIT
  if (( result != 0 )) && [[ "$prepared" == true ]]; then
    if ! bash msa/deploy/run-remote.sh "$RELEASE_NAME" order restore-cutover "$identity_file"; then
      echo 'Cutover recovery was blocked; keep writers stopped if the 055 DDL fence is set.' >&2
    fi
  fi
  exit "$result"
}
trap recover EXIT
# Check every target before changing any DB, including the coupled 055 snapshots.
for service in "${services[@]}"; do
  log="msa-release/db-logs/$service"
  bash msa/deploy/run-remote.sh "$RELEASE_NAME" "$service" preview "$identity_file" 2>&1 | tee "$log-preview.log"
  mapfile -t fingerprints < <(sed -n 's/^DVA_PENDING_SHA256=\([0-9a-f]\{64\}\)$/\1/p' "$log-preview.log")
  (( ${#fingerprints[@]} == 1 )) || { echo 'Expected one pending changeset fingerprint.' >&2; exit 1; }
  approved[$service]=${fingerprints[0]}
  if grep -Fxq 'DVA_QUIESCENT_CUTOVER_REQUIRED=055' "$log-preview.log"; then cutover=true; fi
done
if [[ "$cutover" == true ]]; then
  [[ -v approved[order] && -v approved[consultation] ]] || { echo '055 requires both order and consultation DB targets.' >&2; exit 1; }
  prepared=true
  bash msa/deploy/run-remote.sh "$RELEASE_NAME" order prepare-cutover "$identity_file" 2>&1 | tee msa-release/db-logs/cutover.log
  grep -Fx 'DVA_QUIESCENT_CUTOVER_READY=055' msa-release/db-logs/cutover.log
fi
for service in "${services[@]}"; do
  log="msa-release/db-logs/$service"
  bash msa/deploy/run-remote.sh "$RELEASE_NAME" "$service" apply "$identity_file" "${approved[$service]}" 2>&1 | tee "$log-apply.log"
  grep -Fx "DVA_MIGRATION_COMPLETE=$service" "$log-apply.log"
done
