#!/usr/bin/env bash
set -euo pipefail

service=${1:?Specify service}
action=${2:?Specify preview or apply}
expected=${3:-}
case "$service" in customer|order|consultation|delivery|operations) ;; *) exit 2 ;; esac
case "$action" in preview|apply) ;; *) exit 2 ;; esac
if [[ "$action" == apply && ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Apply requires the approved pending-changeset fingerprint.' >&2
  exit 2
fi

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/changelog"
lb=(liquibase --show-banner=false --log-level=warning "--changelog-file=$service/db.changelog.xml")

pending() {
  "${lb[@]}" "--output-file=$work/status.txt" status --verbose
  cat "$work/status.txt"
  # Pinned Liquibase 5.0.4 status format; fail closed if its format changes.
  if grep -q '::' "$work/status.txt"; then
    grep '::' "$work/status.txt" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | LC_ALL=C sort > "$work/pending.txt"
    if grep -Ev '^dva/[a-z]+/db\.changelog\.xml::[^[:space:]]+::[^[:space:]]+$' "$work/pending.txt"; then
      echo 'Unrecognized pending changeset output.' >&2; exit 1
    fi
  elif grep -qi 'is up to date' "$work/status.txt"; then
    : > "$work/pending.txt"
  else
    echo 'Unrecognized Liquibase status output.' >&2; exit 1
  fi
  fingerprint=$(sha256sum "$work/pending.txt" | cut -d ' ' -f 1)
}

"${lb[@]}" validate
pending
if [[ "$action" == preview ]]; then
  "${lb[@]}" update-sql
  printf '\nDVA_PENDING_SHA256=%s\n' "$fingerprint"
else
  if [[ "$fingerprint" != "$expected" ]]; then
    echo 'Pending changes changed after preview. Run a new preview and approval.' >&2
    exit 1
  fi
  "${lb[@]}" update
  "${lb[@]}" validate
  pending
  if [[ -s "$work/pending.txt" ]]; then
    echo 'Unapplied changesets remain after update.' >&2; exit 1
  fi
  printf '\nDVA_MIGRATION_COMPLETE=%s\n' "$service"
fi
