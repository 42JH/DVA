#!/usr/bin/env bash
set -euo pipefail
baseline=${1:-}
git rev-parse --verify HEAD >/dev/null
# Missing history must run CI, never silently skip unverified changes.
if [[ ! "$baseline" =~ ^[0-9a-f]{40}$ ]] ||
   ! git merge-base --is-ancestor "$baseline" HEAD; then
  echo true
  exit 0
fi
status=0
git diff --quiet "$baseline" HEAD -- msa/ || status=$?
case "$status" in
  0) echo false ;;
  1) echo true ;;
  *) echo 'Cannot compare MSA changes.' >&2; exit "$status" ;;
esac
