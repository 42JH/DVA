#!/bin/sh
# Runs ONLY inside the disposable test container created by test-monolith.ps1.
set -eu
ROOT=/tmp/dva129
MIGRATIONS=$ROOT/backend/migrations
RUNNER=$ROOT/infra/database/migrate.sh
export PATH="$ROOT/testbin:$PATH"
psql -X -v ON_ERROR_STOP=1 -U dva -d monolith_db -f "$MIGRATIONS/001-pbx-call-ended.sql"
psql -X -v ON_ERROR_STOP=1 -U dva -d monolith_db <<'SQL'
INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload)
VALUES('migration-preservation-test','{}');
SQL
sh "$RUNNER" dva-db-129-check "$ROOT/backups"
psql -X -v ON_ERROR_STOP=1 -U dva -d monolith_db -f "$ROOT/infra/database/verify.sql"
psql -X -v ON_ERROR_STOP=1 -U dva -d monolith_db -f "$ROOT/check.sql"

# Restore the pre-migration dump into a different disposable database.
BACKUP=$(find "$ROOT/backups" -type f ! -name '*.sha256' | sort | head -n 1)
createdb -U dva restore_check
pg_restore --exit-on-error --no-owner -U dva -d restore_check "$BACKUP"
test "$(psql -X -U dva -d restore_check -Atc "SELECT count(*) FROM pbx_webhooks.call_ended_events WHERE recording_id='migration-preservation-test'")" = 1
test "$(psql -X -U dva -d restore_check -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = 0
echo 'PASS: pre-migration backup restored with the original PBX receipt'

# Repeating the unchanged migrations is a no-op.
backup_count=$(find "$ROOT/backups" -type f | wc -l)
sh "$RUNNER" --no-backup dva-db-129-check "$ROOT/no-backup"
test ! -e "$ROOT/no-backup"
test "$(find "$ROOT/backups" -type f | wc -l)" = "$backup_count"
test "$(psql -X -U dva -d monolith_db -Atc 'SELECT count(*) FROM db_migrations.applied_versions')" = 10
echo 'PASS: repeated execution skips already-applied migrations'

# Tamper only with a copy inside this test container, never with repo files.
cp "$MIGRATIONS/002-monolith-initial.sql" "$ROOT/original-002.sql"
printf '\n-- checksum drift probe\n' >> "$MIGRATIONS/002-monolith-initial.sql"
if sh "$RUNNER" --no-backup dva-db-129-check "$ROOT/backups" > "$ROOT/drift.log" 2>&1; then
 echo 'FAIL: checksum drift was accepted' >&2; exit 1
fi
grep -q 'Previously applied migration checksum changed' "$ROOT/drift.log"
cp "$ROOT/original-002.sql" "$MIGRATIONS/002-monolith-initial.sql"
echo 'PASS: changed applied SQL is rejected'

printf 'CREATE TABLE migration_rollback_probe(id integer);\n' > "$MIGRATIONS/012-rollback-probe.sql"
printf 'SELECT 1/0;\n' > "$MIGRATIONS/013-failure-probe.sql"
if sh "$RUNNER" --no-backup dva-db-129-check "$ROOT/backups" > "$ROOT/failure.log" 2>&1; then
 echo 'FAIL: invalid migration was accepted' >&2; exit 1
fi
test "$(psql -X -U dva -d monolith_db -Atc "SELECT to_regclass('public.migration_rollback_probe') IS NULL")" = t
test "$(psql -X -U dva -d monolith_db -Atc 'SELECT count(*) FROM db_migrations.applied_versions')" = 10
echo 'PASS: failure rolls back all newly pending SQL and ledger records'

# Also prove atomic rollback when no ledger or business schema exists yet.
createdb -U dva first_run_failure_check
if POSTGRES_DB=first_run_failure_check sh "$RUNNER" --no-backup dva-db-129-check "$ROOT/backups" > "$ROOT/first-failure.log" 2>&1; then
 echo 'FAIL: first-run invalid migration was accepted' >&2; exit 1
fi
test "$(psql -X -U dva -d first_run_failure_check -Atc "SELECT count(*) FROM pg_namespace WHERE nspname IN ('db_migrations','pbx_webhooks','api_idempotency')")" = 0
test "$(psql -X -U dva -d first_run_failure_check -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = 0
echo 'PASS: first-run failure leaves no partially created schemas or tables'
rm -f "$MIGRATIONS/012-rollback-probe.sql" "$MIGRATIONS/013-failure-probe.sql"
sh "$ROOT/creation-upgrade-check.sh"
sh "$ROOT/membership-upgrade-check.sh"
echo 'ALL MONOLITH DATABASE CHECKS PASSED'
