#!/usr/bin/env bash
# Exercise release state and failure handling with fake Docker/curl, without containers or a server.
set -euo pipefail
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/site/shared" "$test_root/site/releases"
printf 'DB_USER=test\nDB_PASSWORD=test-only\nDB_NAME=test\n' > "$test_root/site/shared/.env"
export TEST_DOCKER_LOG="$test_root/docker.log"
export PATH="$test_root/bin:$PATH"
cat > "$test_root/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$TEST_DOCKER_LOG"
if [[ "$*" == *' ps -q db' ]]; then
    if [[ "${TEST_FRESH_DB:-}" != 1 || -f "${TEST_DB_STARTED:-/nonexistent}" ]]; then printf 'test-db\n'; fi
fi
if [[ "$*" == *' up '* && "${!#}" == db && -n "${TEST_DB_STARTED:-}" ]]; then touch "$TEST_DB_STARTED"; fi
if [[ "$1" == exec && "$*" == *psql* && "${TEST_VERIFY_FAIL:-}" == 1 ]]; then exit 1; fi
if [[ "$*" == *' up '* && -n "${TEST_FAIL_VERSION:-}" && "$*" == *"/releases/$TEST_FAIL_VERSION/"* ]]; then
    exit 1
fi
# Compose exec attaches stdin by default; emulate its consumption of a streamed SSH script.
if [[ "$*" == *' exec '* ]]; then cat >/dev/null; fi
MOCK
cat > "$test_root/bin/curl" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
cat > "$test_root/bin/sudo" <<'MOCK'
#!/usr/bin/env bash
[[ "${1:-}" == -n ]] && shift
exec "$@"
MOCK
chmod +x "$test_root/bin/"*

make_release() {
    local version="$1" directory="$test_root/site/releases/$1"
    mkdir -p "$directory/infra/database"
    cp "$(dirname -- "${BASH_SOURCE[0]}")/deploy.sh" "$directory/deploy.sh"
    printf 'services: {}\n' > "$directory/compose.prod.yaml"
    printf 'BACKEND_IMAGE=test:%s\n' "$version" > "$directory/release.env"
    printf 'test image archive %s\n' "$version" > "$directory/images.tar"
    (cd "$directory" && sha256sum images.tar > images.tar.sha256)
    cat > "$directory/infra/database/migrate.sh" <<'MOCK'
#!/bin/sh
set -eu
test "$1" = --no-backup
test "$2" = test-db
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
printf 'MIGRATE %s\n' "$root" >> "$TEST_DOCKER_LOG"
test "$(basename "$root")" != "${TEST_MIGRATION_FAIL_VERSION:-}"
MOCK
    printf 'SELECT 1;\n' > "$directory/infra/database/verify.sql"
    (cd "$directory" && sha256sum deploy.sh compose.prod.yaml release.env infra/database/migrate.sh infra/database/verify.sql > release-files.sha256)
}

assert_current() {
    [[ "$(cat "$test_root/site/current-release")" == "$1" ]]
}

make_release first
bash "$test_root/site/releases/first/deploy.sh"
assert_current first
[[ ! -e "$test_root/site/previous-release" ]]
[[ "$(grep -n 'MIGRATE ' "$TEST_DOCKER_LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n ' up ' "$TEST_DOCKER_LOG" | head -1 | cut -d: -f1)" ]]

make_release second
bash "$test_root/site/releases/second/deploy.sh"
assert_current second
[[ "$(cat "$test_root/site/previous-release")" == first ]]

make_release migration-failure
if TEST_MIGRATION_FAIL_VERSION=migration-failure bash "$test_root/site/releases/migration-failure/deploy.sh"; then
    echo 'Migration failure was accepted.' >&2; exit 1
fi
assert_current second
if grep -F '/releases/migration-failure/compose.prod.yaml up ' "$TEST_DOCKER_LOG"; then
    echo 'New app started after migration failure.' >&2; exit 1
fi
make_release verification-failure
if TEST_VERIFY_FAIL=1 bash "$test_root/site/releases/verification-failure/deploy.sh"; then
    echo 'Schema verification failure was accepted.' >&2; exit 1
fi
assert_current second
if grep -F '/releases/verification-failure/compose.prod.yaml up ' "$TEST_DOCKER_LOG"; then
    echo 'New app started after schema verification failure.' >&2; exit 1
fi

make_release broken
export TEST_FAIL_VERSION=broken
if bash "$test_root/site/releases/broken/deploy.sh"; then
    echo 'Expected failing deployment to report failure.' >&2
    exit 1
fi
assert_current second
[[ "$(cat "$test_root/site/previous-release")" == first ]]
# Both the failed rollout and automatic restore must have been attempted.
grep -F '/releases/broken/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
[[ "$(grep -Fc '/releases/second/compose.prod.yaml up ' "$TEST_DOCKER_LOG")" -eq 2 ]]
unset TEST_FAIL_VERSION

migrations_before="$(grep -c '^MIGRATE ' "$TEST_DOCKER_LOG")"
bash "$test_root/site/releases/second/deploy.sh" --rollback
[[ "$(grep -c '^MIGRATE ' "$TEST_DOCKER_LOG")" == "$migrations_before" ]]
assert_current first
[[ "$(cat "$test_root/site/previous-release")" == second ]]

make_release corrupt
printf 'changed\n' >> "$test_root/site/releases/corrupt/images.tar"
if bash "$test_root/site/releases/corrupt/deploy.sh"; then
    echo 'Expected corrupt transfer to be rejected.' >&2
    exit 1
fi

make_release corrupt-sql
printf 'tampered\n' >> "$test_root/site/releases/corrupt-sql/infra/database/verify.sql"
if bash "$test_root/site/releases/corrupt-sql/deploy.sh"; then echo 'Corrupt SQL accepted.' >&2; exit 1; fi
assert_current first
if grep -F '/releases/corrupt-sql/images.tar' "$TEST_DOCKER_LOG"; then echo 'Corrupt release was loaded.' >&2; exit 1; fi
assert_current first
if grep -F '/releases/corrupt/images.tar' "$TEST_DOCKER_LOG" >/dev/null; then
    echo 'Corrupt image must not be loaded.' >&2
    exit 1
fi

stream_output="$(printf 'bash %q\nprintf "STREAM_CONTINUES\\n"\n' "$test_root/site/releases/first/deploy.sh" | bash)"
[[ "$stream_output" == *STREAM_CONTINUES ]] || { echo 'Deployment consumed following SSH commands.' >&2; exit 1; }

make_release fresh
TEST_FRESH_DB=1 TEST_DB_STARTED="$test_root/db-started" bash "$test_root/site/releases/fresh/deploy.sh"
assert_current fresh
test -f "$test_root/db-started"
db_line="$(grep -n '/releases/fresh/compose.prod.yaml up .* db$' "$TEST_DOCKER_LOG" | cut -d: -f1)"
migration_line="$(grep -n '^MIGRATE .*releases/fresh$' "$TEST_DOCKER_LOG" | cut -d: -f1)"
[[ "$db_line" -lt "$migration_line" ]]
echo 'PASS: migration before app, failure gating, fresh DB startup, update restore, rollback without SQL replay, corrupt transfer rejection and SSH stdin isolation.'
