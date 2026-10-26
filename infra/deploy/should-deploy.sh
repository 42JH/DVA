#!/usr/bin/env bash
# A manual parameter or the existing protected-branch webhook may request deployment.
set -euo pipefail
[[ "${SOURCE_BRANCH:-}" == origin/develop-backend ]] || exit 1
[[ "${1:-false}" == true ]] && exit 0
[[ "${monolith_event:-}" == push &&
   "${monolith_project:-}" == 1462697 &&
   "${monolith_ref:-}" == refs/heads/develop-backend ]]
