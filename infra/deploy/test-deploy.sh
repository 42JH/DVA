#!/usr/bin/env bash
# Exercise release state and failure handling with fake Docker/curl, without containers or a server.
set -euo pipefail
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/site/shared" "$test_root/site/releases"
printf 'DB_USER=test\nDB_PASSWORD=test-only\nDB_NAME=test\nSECURITY_LOG_HMAC_KEY=abababababababababababababababababababababababababababababababab\n' > "$test_root/site/shared/.env"
export TEST_DOCKER_LOG="$test_root/docker.log"
export TEST_CREATION_SCHEMA="$test_root/creation-schema"
export TEST_MEMBERSHIP_TABLE="$test_root/membership-table"
export TEST_BILLING_SCHEMA="$test_root/billing-schema"
export TEST_COMPANY_HISTORY_SCHEMA="$test_root/company-history-schema"
export TEST_CALL_ANALYSIS_SCHEMA="$test_root/call-analysis-schema"
export TEST_ADDRESS_SCHEMA="$test_root/address-schema"
export TEST_RETENTION_SCHEMA="$test_root/retention-schema"
export TEST_UNUSED_SCHEMA="$test_root/unused-schema"
export TEST_COMPANY_PIN_SCHEMA="$test_root/company-pin-schema"
export TEST_RECORDING_RETRY_SCHEMA="$test_root/recording-retry-schema"
export TEST_PARCEL_DRAFT_SCHEMA="$test_root/parcel-draft-schema"
export TEST_PAYMENT_CARD_SCHEMA="$test_root/payment-card-schema"
export PATH="$test_root/bin:$PATH"
cat > "$test_root/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$TEST_DOCKER_LOG"
if [[ "$*" == *' ps -q db' ]]; then
    if [[ "${TEST_FRESH_DB:-}" != 1 || -f "${TEST_DB_STARTED:-/nonexistent}" ]]; then printf 'test-db\n'; fi
fi
if [[ "$*" == *' up '* && "${!#}" == db && -n "${TEST_DB_STARTED:-}" ]]; then touch "$TEST_DB_STARTED"; fi
if [[ "$1" == exec && "$*" == *creation_request_id* ]]; then
    [[ "${TEST_SCHEMA_QUERY_FAIL:-}" != 1 ]] || exit 1
    if [[ -f "$TEST_CREATION_SCHEMA" ]]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
fi
if [[ "$1" == exec && "$*" == *membership_writes* ]]; then
    [[ "${TEST_MEMBERSHIP_QUERY_FAIL:-}" != 1 ]] || exit 1
    if [[ -f "$TEST_MEMBERSHIP_TABLE" ]]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
fi
if [[ "$1" == exec && "$*" == *public.departments* ]]; then
    [[ "${TEST_BILLING_QUERY_FAIL:-}" != 1 ]] || exit 1
    if [[ -f "$TEST_BILLING_SCHEMA" ]]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
fi
if [[ "$1" == exec && "$*" == *billing_organization_name* ]]; then
    [[ "${TEST_COMPANY_HISTORY_QUERY_FAIL:-}" != 1 ]] || exit 1
    if [[ -f "$TEST_COMPANY_HISTORY_SCHEMA" ]]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
fi
if [[ "$1" == exec && "$*" == *public.call_analyses* ]]; then
    [[ "${TEST_CALL_ANALYSIS_QUERY_FAIL:-}" != 1 ]] || exit 1
    if [[ -f "$TEST_CALL_ANALYSIS_SCHEMA" ]]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
fi
if [[ "$1" == exec && "$*" == *origin_latitude* ]]; then
    [[ "${TEST_ADDRESS_QUERY_FAIL:-}" != 1 ]] || exit 1
    if [[ -f "$TEST_ADDRESS_SCHEMA" ]]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
fi
if [[ "$1" == exec && "$*" == *"table_name='customers' AND column_name='deleted_at'"* ]]; then
    [[ "${TEST_RETENTION_QUERY_FAIL:-}" != 1 ]] || exit 1
    if [[ -f "$TEST_RETENTION_SCHEMA" ]]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
fi
if [[ "$1" == exec && "$*" == *public.handoff_requests* ]]; then
    [[ "${TEST_UNUSED_QUERY_FAIL:-}" != 1 ]] || exit 1
    if [[ -f "$TEST_UNUSED_SCHEMA" ]]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
fi
if [[ "$1" == exec && "$*" == *"to_regclass('public.company_pins') IS NULL"* ]]; then
    [[ "${TEST_COMPANY_PIN_QUERY_FAIL:-}" != 1 ]] || exit 1
    if [[ -f "$TEST_COMPANY_PIN_SCHEMA" ]]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
fi
if [[ "$1" == exec && "$*" == *"column_name='requires_review'"* ]]; then
    [[ "${TEST_RECORDING_RETRY_QUERY_FAIL:-}" != 1 ]] || exit 1
    if [[ -f "$TEST_RECORDING_RETRY_SCHEMA" ]]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
fi
if [[ "$1" == exec && "$*" == *"to_regclass('public.order_parcel_drafts')"* ]]; then
    [[ "${TEST_PARCEL_DRAFT_QUERY_FAIL:-}" != 1 ]] || exit 1
    if [[ -f "$TEST_PARCEL_DRAFT_SCHEMA" ]]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
fi
if [[ "$1" == exec && "$*" == *"to_regclass('public.payment_cards')"* ]]; then
    [[ "${TEST_PAYMENT_CARD_QUERY_FAIL:-}" != 1 ]] || exit 1
    if [[ -f "$TEST_PAYMENT_CARD_SCHEMA" ]]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
fi
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
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if [ "$1" = --no-backup ]; then
    test "$2" = test-db
    printf 'NO_BACKUP %s\n' "$root" >> "$TEST_DOCKER_LOG"
else
    test "$1" = test-db
    test "$2" = "$(dirname "$(dirname "$root")")/shared/db-backups"
    printf 'BACKUP %s\n' "$root" >> "$TEST_DOCKER_LOG"
    test "${TEST_BACKUP_FAIL:-}" != 1
fi
printf 'MIGRATE %s\n' "$root" >> "$TEST_DOCKER_LOG"
test "$(basename "$root")" != "${TEST_MIGRATION_FAIL_VERSION:-}"
if [ -f "$root/backend/migrations/008-simplify-creation-requests.sql" ]; then touch "$TEST_CREATION_SCHEMA"; fi
if [ -f "$root/backend/migrations/009-membership-write-requests.sql" ] &&
   [ ! -f "$root/backend/migrations/010-remove-membership-write-requests.sql" ]; then touch "$TEST_MEMBERSHIP_TABLE"; fi
if [ -f "$root/backend/migrations/010-remove-membership-write-requests.sql" ]; then rm -f "$TEST_MEMBERSHIP_TABLE"; fi
if [ -f "$root/backend/migrations/019-organization-monthly-billing.sql" ]; then touch "$TEST_BILLING_SCHEMA"; fi
if [ -f "$root/backend/migrations/021-company-deletion-history.sql" ]; then touch "$TEST_COMPANY_HISTORY_SCHEMA"; fi
if [ -f "$root/backend/migrations/042-remove-call-analysis-result.sql" ]; then touch "$TEST_CALL_ANALYSIS_SCHEMA"; fi
if [ -f "$root/backend/migrations/043-remove-address-coordinates.sql" ]; then touch "$TEST_ADDRESS_SCHEMA"; fi
if [ -f "$root/backend/migrations/045-data-retention.sql" ]; then touch "$TEST_RETENTION_SCHEMA"; fi
if [ -f "$root/backend/migrations/047-remove-unused-schema.sql" ]; then touch "$TEST_UNUSED_SCHEMA"; fi
if [ -f "$root/backend/migrations/053-drop-company-pins.sql" ]; then touch "$TEST_COMPANY_PIN_SCHEMA"; fi
if [ -f "$root/backend/migrations/054-recording-retry-policy.sql" ]; then touch "$TEST_RECORDING_RETRY_SCHEMA"; fi
if [ -f "$root/backend/migrations/055-parcel-draft-intake.sql" ]; then touch "$TEST_PARCEL_DRAFT_SCHEMA"; fi
if [ -f "$root/backend/migrations/064-payment-cards.sql" ]; then touch "$TEST_PAYMENT_CARD_SCHEMA"; fi
MOCK
    printf 'SELECT 1;\n' > "$directory/infra/database/verify.sql"
    if [[ "${2:-}" == cutover || "${2:-}" == membership || "${2:-}" == cleanup || "${2:-}" == billing || "${2:-}" == history ]]; then
        mkdir -p "$directory/backend/migrations"
        printf 'SELECT 1;\n' > "$directory/backend/migrations/008-simplify-creation-requests.sql"
    fi
    if [[ "${2:-}" == membership || "${2:-}" == cleanup || "${2:-}" == billing || "${2:-}" == history ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/009-membership-write-requests.sql"
    fi
    if [[ "${2:-}" == cleanup || "${2:-}" == billing || "${2:-}" == history ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/010-remove-membership-write-requests.sql"
    fi
    if [[ "${2:-}" == billing || "${2:-}" == history ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/019-organization-monthly-billing.sql"
    fi
    if [[ "${2:-}" == history ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/021-company-deletion-history.sql"
    fi
    if [[ "${3:-}" == analysis || "${3:-}" == summary ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/024-call-analyses.sql"
    fi
    if [[ "${3:-}" == summary ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/042-remove-call-analysis-result.sql"
    fi
    if [[ "${4:-}" == address || "${4:-}" == retention || "${4:-}" == unused || "${4:-}" == pins || "${4:-}" == recording || "${4:-}" == drafts || "${4:-}" == cards ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/043-remove-address-coordinates.sql"
    fi
    if [[ "${4:-}" == retention || "${4:-}" == unused || "${4:-}" == pins || "${4:-}" == recording || "${4:-}" == drafts || "${4:-}" == cards ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/045-data-retention.sql"
    fi
    if [[ "${4:-}" == unused || "${4:-}" == pins || "${4:-}" == recording || "${4:-}" == drafts || "${4:-}" == cards ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/047-remove-unused-schema.sql"
    fi
    if [[ "${4:-}" == pins || "${4:-}" == recording || "${4:-}" == drafts || "${4:-}" == cards ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/053-drop-company-pins.sql"
    fi
    if [[ "${4:-}" == recording || "${4:-}" == drafts || "${4:-}" == cards ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/054-recording-retry-policy.sql"
    fi
    if [[ "${4:-}" == drafts || "${4:-}" == cards ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/055-parcel-draft-intake.sql"
    fi
    if [[ "${4:-}" == cards ]]; then
        printf 'SELECT 1;\n' > "$directory/backend/migrations/063-member-payment-policy.sql"
        printf 'SELECT 1;\n' > "$directory/backend/migrations/064-payment-cards.sql"
    fi
    (cd "$directory" && find . -type f ! -name 'images.tar*' ! -name release-files.sha256 -print0 | sort -z | xargs -0 sha256sum > release-files.sha256)
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

: > "$TEST_DOCKER_LOG"
make_release schema-query-failure cutover
if TEST_SCHEMA_QUERY_FAIL=1 bash "$test_root/site/releases/schema-query-failure/deploy.sh"; then
    echo 'Unknown schema compatibility was accepted.' >&2; exit 1
fi
assert_current fresh
if grep -E ' stop backend| up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi

: > "$TEST_DOCKER_LOG"
make_release backup-failure cutover
if TEST_BACKUP_FAIL=1 bash "$test_root/site/releases/backup-failure/deploy.sh"; then
    echo 'Backup failure was accepted.' >&2; exit 1
fi
assert_current fresh
[[ ! -f "$TEST_CREATION_SCHEMA" ]]
grep -F '/releases/backup-failure/compose.prod.yaml stop backend' "$TEST_DOCKER_LOG" >/dev/null
grep -F '/releases/fresh/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
if grep '^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi

: > "$TEST_DOCKER_LOG"
make_release cutover-sql-failure cutover
if TEST_MIGRATION_FAIL_VERSION=cutover-sql-failure bash "$test_root/site/releases/cutover-sql-failure/deploy.sh"; then
    echo 'Cutover SQL failure was accepted.' >&2; exit 1
fi
assert_current fresh
[[ ! -f "$TEST_CREATION_SCHEMA" ]]
grep '^BACKUP ' "$TEST_DOCKER_LOG" >/dev/null
grep -F '/releases/fresh/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
if grep -F '/releases/cutover-sql-failure/compose.prod.yaml up ' "$TEST_DOCKER_LOG"; then exit 1; fi

: > "$TEST_DOCKER_LOG"
make_release cutover cutover
bash "$test_root/site/releases/cutover/deploy.sh"
assert_current cutover
[[ -f "$TEST_CREATION_SCHEMA" ]]
stop_line="$(grep -n ' stop backend$' "$TEST_DOCKER_LOG" | cut -d: -f1)"
backup_line="$(grep -n '^BACKUP ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
migration_line="$(grep -n '^MIGRATE ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
app_line="$(grep -n ' up ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
[[ "$stop_line" -lt "$backup_line" && "$backup_line" -lt "$migration_line" && "$migration_line" -lt "$app_line" ]]

: > "$TEST_DOCKER_LOG"
if bash "$test_root/site/releases/cutover/deploy.sh" --rollback; then
    echo 'Incompatible manual rollback was accepted.' >&2; exit 1
fi
if bash "$test_root/site/releases/fresh/deploy.sh"; then
    echo 'Incompatible deployment was accepted.' >&2; exit 1
fi
assert_current cutover
if grep -E ' stop backend| up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi

: > "$TEST_DOCKER_LOG"
make_release compatible-broken cutover
if TEST_FAIL_VERSION=compatible-broken bash "$test_root/site/releases/compatible-broken/deploy.sh"; then exit 1; fi
assert_current cutover
grep '^NO_BACKUP ' "$TEST_DOCKER_LOG" >/dev/null
grep -F '/releases/cutover/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
if grep '^BACKUP ' "$TEST_DOCKER_LOG"; then exit 1; fi

# Reset only the disposable fixture to exercise a committed cutover followed by verification failure.
rm -f -- "$TEST_CREATION_SCHEMA"
printf 'fresh\n' > "$test_root/site/current-release"
: > "$TEST_DOCKER_LOG"
make_release cutover-verification-failure cutover
if TEST_VERIFY_FAIL=1 bash "$test_root/site/releases/cutover-verification-failure/deploy.sh"; then exit 1; fi
assert_current fresh
[[ -f "$TEST_CREATION_SCHEMA" ]]
grep -F '/releases/cutover-verification-failure/compose.prod.yaml stop backend' "$TEST_DOCKER_LOG" >/dev/null
if grep ' up ' "$TEST_DOCKER_LOG"; then echo 'App started after incompatible schema verification failure.' >&2; exit 1; fi

: > "$TEST_DOCKER_LOG"
make_release cutover-app-failure cutover
if TEST_FAIL_VERSION=cutover-app-failure bash "$test_root/site/releases/cutover-app-failure/deploy.sh"; then exit 1; fi
assert_current fresh
grep -F '/releases/cutover-app-failure/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
grep -F '/releases/cutover-app-failure/compose.prod.yaml stop backend' "$TEST_DOCKER_LOG" >/dev/null
if grep -F '/releases/fresh/compose.prod.yaml up ' "$TEST_DOCKER_LOG"; then
    echo 'Incompatible old application was restored.' >&2; exit 1
fi

make_release membership-old membership
make_release membership-cleanup cleanup
touch "$TEST_CREATION_SCHEMA" "$TEST_MEMBERSHIP_TABLE"
printf 'membership-old\n' > "$test_root/site/current-release"
: > "$TEST_DOCKER_LOG"
if TEST_MEMBERSHIP_QUERY_FAIL=1 bash "$test_root/site/releases/membership-cleanup/deploy.sh"; then exit 1; fi
if grep -E ' stop backend| up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi
assert_current membership-old
: > "$TEST_DOCKER_LOG"
if TEST_BACKUP_FAIL=1 bash "$test_root/site/releases/membership-cleanup/deploy.sh"; then exit 1; fi
test -f "$TEST_MEMBERSHIP_TABLE"
grep -F '/releases/membership-old/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
: > "$TEST_DOCKER_LOG"
if TEST_MIGRATION_FAIL_VERSION=membership-cleanup bash "$test_root/site/releases/membership-cleanup/deploy.sh"; then exit 1; fi
test -f "$TEST_MEMBERSHIP_TABLE"
grep -F '/releases/membership-old/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
: > "$TEST_DOCKER_LOG"
bash "$test_root/site/releases/membership-cleanup/deploy.sh"
assert_current membership-cleanup
test ! -f "$TEST_MEMBERSHIP_TABLE"
stop_line="$(grep -n ' stop backend$' "$TEST_DOCKER_LOG" | cut -d: -f1)"
backup_line="$(grep -n '^BACKUP ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
migration_line="$(grep -n '^MIGRATE ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
app_line="$(grep -n ' up ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
[[ "$stop_line" -lt "$backup_line" && "$backup_line" -lt "$migration_line" && "$migration_line" -lt "$app_line" ]]
: > "$TEST_DOCKER_LOG"
if bash "$test_root/site/releases/membership-cleanup/deploy.sh" --rollback; then exit 1; fi
if grep -E ' up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi
assert_current membership-cleanup
make_release membership-broken cleanup
touch "$TEST_MEMBERSHIP_TABLE"
printf 'membership-old\n' > "$test_root/site/current-release"
: > "$TEST_DOCKER_LOG"
if TEST_VERIFY_FAIL=1 bash "$test_root/site/releases/membership-broken/deploy.sh"; then exit 1; fi
test ! -f "$TEST_MEMBERSHIP_TABLE"
if grep ' up ' "$TEST_DOCKER_LOG"; then exit 1; fi
touch "$TEST_MEMBERSHIP_TABLE"
: > "$TEST_DOCKER_LOG"
if TEST_FAIL_VERSION=membership-broken bash "$test_root/site/releases/membership-broken/deploy.sh"; then exit 1; fi
if grep -F '/releases/membership-old/compose.prod.yaml up ' "$TEST_DOCKER_LOG"; then exit 1; fi

# Department/payment conversion must stop old writers and forbid incompatible restore.
printf 'membership-cleanup\n' > "$test_root/site/current-release"
rm -f -- "$TEST_MEMBERSHIP_TABLE"
make_release billing billing
: > "$TEST_DOCKER_LOG"
if TEST_BILLING_QUERY_FAIL=1 bash "$test_root/site/releases/billing/deploy.sh"; then exit 1; fi
if grep -E ' stop backend| up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi
: > "$TEST_DOCKER_LOG"
if TEST_MIGRATION_FAIL_VERSION=billing bash "$test_root/site/releases/billing/deploy.sh"; then exit 1; fi
[[ ! -f "$TEST_BILLING_SCHEMA" ]]
grep -F '/releases/membership-cleanup/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
: > "$TEST_DOCKER_LOG"
bash "$test_root/site/releases/billing/deploy.sh"
assert_current billing
[[ -f "$TEST_BILLING_SCHEMA" ]]
stop_line="$(grep -n ' stop backend$' "$TEST_DOCKER_LOG" | cut -d: -f1)"
backup_line="$(grep -n '^BACKUP ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
migration_line="$(grep -n '^MIGRATE ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
app_line="$(grep -n ' up ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
[[ "$stop_line" -lt "$backup_line" && "$backup_line" -lt "$migration_line" && "$migration_line" -lt "$app_line" ]]
: > "$TEST_DOCKER_LOG"
if bash "$test_root/site/releases/billing/deploy.sh" --rollback; then exit 1; fi
if bash "$test_root/site/releases/membership-cleanup/deploy.sh"; then exit 1; fi
if grep -E ' up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi
assert_current billing
make_release billing-compatible-broken billing
: > "$TEST_DOCKER_LOG"
if TEST_FAIL_VERSION=billing-compatible-broken bash "$test_root/site/releases/billing-compatible-broken/deploy.sh"; then exit 1; fi
grep '^NO_BACKUP ' "$TEST_DOCKER_LOG" >/dev/null
grep -F '/releases/billing/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
# Only reset the disposable schema marker to simulate first-conversion app failure.
rm -f -- "$TEST_BILLING_SCHEMA"
printf 'membership-cleanup\n' > "$test_root/site/current-release"
: > "$TEST_DOCKER_LOG"
if TEST_FAIL_VERSION=billing-compatible-broken bash "$test_root/site/releases/billing-compatible-broken/deploy.sh"; then exit 1; fi
[[ -f "$TEST_BILLING_SCHEMA" ]]
if grep -F '/releases/membership-cleanup/compose.prod.yaml up ' "$TEST_DOCKER_LOG"; then exit 1; fi
# 021 conversion stops old writers, takes a backup and blocks older images afterward.
printf 'billing\n' > "$test_root/site/current-release"
make_release company-history history
: > "$TEST_DOCKER_LOG"
if TEST_COMPANY_HISTORY_QUERY_FAIL=1 bash "$test_root/site/releases/company-history/deploy.sh"; then exit 1; fi
if grep -E ' stop backend| up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi
: > "$TEST_DOCKER_LOG"
bash "$test_root/site/releases/company-history/deploy.sh"
assert_current company-history
[[ -f "$TEST_COMPANY_HISTORY_SCHEMA" ]]
stop_line="$(grep -n ' stop backend$' "$TEST_DOCKER_LOG" | cut -d: -f1)"
backup_line="$(grep -n '^BACKUP ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
migration_line="$(grep -n '^MIGRATE ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
[[ "$stop_line" -lt "$backup_line" && "$backup_line" -lt "$migration_line" ]]
: > "$TEST_DOCKER_LOG"
if bash "$test_root/site/releases/company-history/deploy.sh" --rollback; then exit 1; fi
if grep -E ' up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi
make_release history-compatible-broken history
: > "$TEST_DOCKER_LOG"
if TEST_FAIL_VERSION=history-compatible-broken bash "$test_root/site/releases/history-compatible-broken/deploy.sh"; then exit 1; fi
grep -F '/releases/company-history/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null

# 042 removes a column used by existing analysis apps; fail closed before mutation and after conversion.
make_release analysis-old history analysis
bash "$test_root/site/releases/analysis-old/deploy.sh"
assert_current analysis-old
make_release call-summary history summary
: > "$TEST_DOCKER_LOG"
if TEST_CALL_ANALYSIS_QUERY_FAIL=1 bash "$test_root/site/releases/call-summary/deploy.sh"; then exit 1; fi
if grep -E ' stop backend| up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi
: > "$TEST_DOCKER_LOG"
if TEST_BACKUP_FAIL=1 bash "$test_root/site/releases/call-summary/deploy.sh"; then exit 1; fi
test ! -f "$TEST_CALL_ANALYSIS_SCHEMA"
grep -F '/releases/analysis-old/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
: > "$TEST_DOCKER_LOG"
if TEST_MIGRATION_FAIL_VERSION=call-summary bash "$test_root/site/releases/call-summary/deploy.sh"; then exit 1; fi
test ! -f "$TEST_CALL_ANALYSIS_SCHEMA"
grep -F '/releases/analysis-old/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
: > "$TEST_DOCKER_LOG"
bash "$test_root/site/releases/call-summary/deploy.sh"
assert_current call-summary
[[ -f "$TEST_CALL_ANALYSIS_SCHEMA" ]]
stop_line="$(grep -n ' stop backend$' "$TEST_DOCKER_LOG" | cut -d: -f1)"
backup_line="$(grep -n '^BACKUP ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
migration_line="$(grep -n '^MIGRATE ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
app_line="$(grep -n ' up ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
[[ "$stop_line" -lt "$backup_line" && "$backup_line" -lt "$migration_line" && "$migration_line" -lt "$app_line" ]]
: > "$TEST_DOCKER_LOG"
if bash "$test_root/site/releases/call-summary/deploy.sh" --rollback; then exit 1; fi
if bash "$test_root/site/releases/analysis-old/deploy.sh"; then exit 1; fi
if grep -E ' up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi
assert_current call-summary
make_release summary-compatible-broken history summary
: > "$TEST_DOCKER_LOG"
if TEST_FAIL_VERSION=summary-compatible-broken bash "$test_root/site/releases/summary-compatible-broken/deploy.sh"; then exit 1; fi
grep '^NO_BACKUP ' "$TEST_DOCKER_LOG" >/dev/null
grep -F '/releases/call-summary/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
for failure in verification app; do
    rm -f -- "$TEST_CALL_ANALYSIS_SCHEMA"
    printf 'analysis-old\n' > "$test_root/site/current-release"
    : > "$TEST_DOCKER_LOG"
    if [[ "$failure" == verification ]]; then
        if TEST_VERIFY_FAIL=1 bash "$test_root/site/releases/call-summary/deploy.sh"; then exit 1; fi
    else
        if TEST_FAIL_VERSION=call-summary bash "$test_root/site/releases/call-summary/deploy.sh"; then exit 1; fi
    fi
    [[ -f "$TEST_CALL_ANALYSIS_SCHEMA" ]]
    if grep -F '/releases/analysis-old/compose.prod.yaml up ' "$TEST_DOCKER_LOG"; then exit 1; fi
done
# Each later conversion must protect automatic deployment and recovery independently.
old_version=call-summary
for cutover in address retention unused pins recording drafts cards; do
    case "$cutover" in
        address) schema_marker="$TEST_ADDRESS_SCHEMA"; query_failure=TEST_ADDRESS_QUERY_FAIL ;;
        retention) schema_marker="$TEST_RETENTION_SCHEMA"; query_failure=TEST_RETENTION_QUERY_FAIL ;;
        unused) schema_marker="$TEST_UNUSED_SCHEMA"; query_failure=TEST_UNUSED_QUERY_FAIL ;;
        pins) schema_marker="$TEST_COMPANY_PIN_SCHEMA"; query_failure=TEST_COMPANY_PIN_QUERY_FAIL ;;
        recording) schema_marker="$TEST_RECORDING_RETRY_SCHEMA"; query_failure=TEST_RECORDING_RETRY_QUERY_FAIL ;;
        drafts) schema_marker="$TEST_PARCEL_DRAFT_SCHEMA"; query_failure=TEST_PARCEL_DRAFT_QUERY_FAIL ;;
        cards) schema_marker="$TEST_PAYMENT_CARD_SCHEMA"; query_failure=TEST_PAYMENT_CARD_QUERY_FAIL ;;
    esac
    printf '%s\n' "$old_version" > "$test_root/site/current-release"
    make_release "$cutover" history summary "$cutover"
    : > "$TEST_DOCKER_LOG"
    if env "$query_failure=1" bash "$test_root/site/releases/$cutover/deploy.sh"; then
        echo "Unknown $cutover schema was accepted." >&2; exit 1
    fi
    assert_current "$old_version"
    if grep -E ' stop backend| up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi

    for failure in backup sql; do
        : > "$TEST_DOCKER_LOG"
        if [[ "$failure" == backup ]]; then
            if TEST_BACKUP_FAIL=1 bash "$test_root/site/releases/$cutover/deploy.sh"; then exit 1; fi
            if grep '^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi
        else
            if TEST_MIGRATION_FAIL_VERSION="$cutover" bash "$test_root/site/releases/$cutover/deploy.sh"; then exit 1; fi
        fi
        assert_current "$old_version"
        [[ ! -f "$schema_marker" ]]
        grep '^BACKUP ' "$TEST_DOCKER_LOG" >/dev/null
        grep -F "/releases/$old_version/compose.prod.yaml up " "$TEST_DOCKER_LOG" >/dev/null
        if grep -F "/releases/$cutover/compose.prod.yaml up " "$TEST_DOCKER_LOG"; then exit 1; fi
    done

    : > "$TEST_DOCKER_LOG"
    bash "$test_root/site/releases/$cutover/deploy.sh"
    assert_current "$cutover"
    [[ -f "$schema_marker" ]]
    stop_line="$(grep -n ' stop backend$' "$TEST_DOCKER_LOG" | cut -d: -f1)"
    backup_line="$(grep -n '^BACKUP ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
    migration_line="$(grep -n '^MIGRATE ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
    app_line="$(grep -n ' up ' "$TEST_DOCKER_LOG" | cut -d: -f1)"
    [[ "$stop_line" -lt "$backup_line" && "$backup_line" -lt "$migration_line" && "$migration_line" -lt "$app_line" ]]

    : > "$TEST_DOCKER_LOG"
    if bash "$test_root/site/releases/$old_version/deploy.sh"; then
        echo "Old app deployed after $cutover conversion." >&2; exit 1
    fi
    assert_current "$cutover"
    if grep -E ' stop backend| up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi

    if [[ "$cutover" == pins || "$cutover" == recording || "$cutover" == drafts || "$cutover" == cards ]]; then
        : > "$TEST_DOCKER_LOG"
        if bash "$test_root/site/releases/$cutover/deploy.sh" --rollback; then exit 1; fi
        assert_current "$cutover"
        if grep -E ' stop backend| up |^MIGRATE ' "$TEST_DOCKER_LOG"; then exit 1; fi
    fi

    make_release "$cutover-compatible-broken" history summary "$cutover"
    : > "$TEST_DOCKER_LOG"
    if TEST_FAIL_VERSION="$cutover-compatible-broken" bash "$test_root/site/releases/$cutover-compatible-broken/deploy.sh"; then exit 1; fi
    assert_current "$cutover"
    grep '^NO_BACKUP ' "$TEST_DOCKER_LOG" >/dev/null
    grep -F "/releases/$cutover/compose.prod.yaml up " "$TEST_DOCKER_LOG" >/dev/null
    if grep '^BACKUP ' "$TEST_DOCKER_LOG"; then exit 1; fi
    # The only stop is cleanup of the failed app, after SQL; no repeated cutover outage.
    [[ "$(grep -c ' stop backend$' "$TEST_DOCKER_LOG")" -eq 1 ]]
    [[ "$(grep -n '^MIGRATE ' "$TEST_DOCKER_LOG" | cut -d: -f1)" -lt "$(grep -n ' stop backend$' "$TEST_DOCKER_LOG" | cut -d: -f1)" ]]

    for failure in verification app; do
        # Reset only the disposable fixture to simulate a first committed conversion.
        rm -f -- "$schema_marker"
        printf '%s\n' "$old_version" > "$test_root/site/current-release"
        : > "$TEST_DOCKER_LOG"
        if [[ "$failure" == verification ]]; then
            if TEST_VERIFY_FAIL=1 bash "$test_root/site/releases/$cutover/deploy.sh"; then exit 1; fi
        else
            if TEST_FAIL_VERSION="$cutover" bash "$test_root/site/releases/$cutover/deploy.sh"; then exit 1; fi
        fi
        assert_current "$old_version"
        [[ -f "$schema_marker" ]]
        grep '^BACKUP ' "$TEST_DOCKER_LOG" >/dev/null
        if grep -F "/releases/$old_version/compose.prod.yaml up " "$TEST_DOCKER_LOG"; then
            echo "Incompatible app restored after $cutover conversion." >&2; exit 1
        fi
        if [[ "$failure" == verification ]] && grep ' up ' "$TEST_DOCKER_LOG"; then exit 1; fi
    done
    old_version="$cutover"
done

# A release spanning later conversions needs just one stop and one backup.
rm -f -- "$TEST_ADDRESS_SCHEMA" "$TEST_RETENTION_SCHEMA" "$TEST_UNUSED_SCHEMA" "$TEST_COMPANY_PIN_SCHEMA" "$TEST_RECORDING_RETRY_SCHEMA" "$TEST_PARCEL_DRAFT_SCHEMA" "$TEST_PAYMENT_CARD_SCHEMA"
printf 'call-summary\n' > "$test_root/site/current-release"
make_release combined history summary cards
: > "$TEST_DOCKER_LOG"
bash "$test_root/site/releases/combined/deploy.sh"
assert_current combined
[[ -f "$TEST_ADDRESS_SCHEMA" && -f "$TEST_RETENTION_SCHEMA" && -f "$TEST_UNUSED_SCHEMA" && -f "$TEST_COMPANY_PIN_SCHEMA" ]]
[[ -f "$TEST_RECORDING_RETRY_SCHEMA" && -f "$TEST_PARCEL_DRAFT_SCHEMA" && -f "$TEST_PAYMENT_CARD_SCHEMA" ]]
[[ "$(grep -c ' stop backend$' "$TEST_DOCKER_LOG")" -eq 1 ]]
[[ "$(grep -c '^BACKUP ' "$TEST_DOCKER_LOG")" -eq 1 ]]
echo 'PASS: migration gating, fresh DB startup, compatible rollback, 008/010/019/021/042/043/045/047/053/054/055/064 stop-backup order and incompatible restore protection.'
