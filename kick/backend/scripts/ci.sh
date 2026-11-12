#!/bin/sh
set -eu
umask 077

export KICK_BACKEND_IMAGE="kick-backend:${GIT_COMMIT:?Git commit is required}"
export KICK_BACKEND_PORT=0
project="kick-backend-ci-${BUILD_NUMBER:?Build number is required}"
env_file=$(mktemp)

cleanup() {
  status=$?
  trap - EXIT
  if [ -s "$env_file" ] && ! docker compose -p "$project" --env-file "$env_file" down --volumes; then
    status=1
  fi
  rm -f "$env_file"
  exit "$status"
}

trap cleanup EXIT
password=$(openssl rand -hex 32)
printf 'POSTGRES_PASSWORD=%s\n' "$password" > "$env_file"

docker build --tag "$KICK_BACKEND_IMAGE" .
docker compose -p "$project" --env-file "$env_file" up -d --no-build --wait --wait-timeout 90
