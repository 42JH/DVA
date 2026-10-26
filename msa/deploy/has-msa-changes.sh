#!/usr/bin/env bash
set -euo pipefail

baseline=${1:-}
if (( $# > 0 )); then
  shift
fi

# 경로를 생략하면 기존처럼 msa 전체를 검사한다.
if (( $# == 0 )); then
  set -- msa/
fi

git rev-parse --verify HEAD >/dev/null

# 비교 이력이 없거나 현재 브랜치의 조상이 아니면 검사한다.
if [[ ! "$baseline" =~ ^[0-9a-f]{40}$ ]] ||
   ! git merge-base --is-ancestor "$baseline" HEAD; then
  echo true
  exit 0
fi

status=0
git diff --quiet "$baseline" HEAD -- "$@" || status=$?

case "$status" in
  0) echo false ;;
  1) echo true ;;
  *) echo 'Cannot compare changes.' >&2; exit "$status" ;;
esac