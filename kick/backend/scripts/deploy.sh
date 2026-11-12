#!/bin/sh
set -eu
umask 077

export KICK_BACKEND_IMAGE="kick-backend:${GIT_COMMIT:?Git commit is required}"
export KICK_BACKEND_PORT=3010
state_dir="${JENKINS_HOME:?Jenkins home is required}/kick-backend"
env_file="$state_dir/.env"
accounts_file="$state_dir/test-accounts.env"

mkdir -p "$state_dir"
if [ ! -s "$env_file" ]; then
  if docker volume inspect kick-backend_postgres-data >/dev/null 2>&1; then
    printf '%s\n' 'The Kick PostgreSQL volume already exists. Restore its .env before deploying.' >&2
    exit 1
  fi
  password=$(openssl rand -hex 32)
  (set -C; printf 'POSTGRES_PASSWORD=%s\n' "$password" > "$env_file")
fi

if [ ! -s "$accounts_file" ]; then
  first_token=$(openssl rand -hex 32)
  second_token=$(openssl rand -hex 32)
  (set -C; printf 'KICK_TEST_ACCOUNT_1_TOKEN=%s\nKICK_TEST_ACCOUNT_2_TOKEN=%s\n' \
    "$first_token" "$second_token" > "$accounts_file")
fi

cp compose.yaml "$state_dir/compose.yaml"
docker compose -p kick-backend --env-file "$env_file" --env-file "$accounts_file" \
  -f "$state_dir/compose.yaml" \
  up -d --no-build --wait --wait-timeout 90
