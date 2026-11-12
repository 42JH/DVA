#!/bin/sh
set -eu
umask 077

export KICK_BACKEND_IMAGE="kick-backend:${GIT_COMMIT:?Git commit is required}"
export KICK_BACKEND_PORT=3010
state_dir="${JENKINS_HOME:?Jenkins home is required}/kick-backend"
env_file="$state_dir/.env"

mkdir -p "$state_dir"
if [ ! -s "$env_file" ]; then
  if docker volume inspect kick-backend_postgres-data >/dev/null 2>&1; then
    printf '%s\n' 'The Kick PostgreSQL volume already exists. Restore its .env before deploying.' >&2
    exit 1
  fi
  password=$(openssl rand -hex 32)
  (set -C; printf 'POSTGRES_PASSWORD=%s\n' "$password" > "$env_file")
fi

cp compose.yaml "$state_dir/compose.yaml"
docker compose -p kick-backend --env-file "$env_file" -f "$state_dir/compose.yaml" \
  up -d --no-build --wait --wait-timeout 90
