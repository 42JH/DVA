#!/bin/sh
# test-monolith.ps1이 만든 임시 PostgreSQL에서 009 → 010 전환만 검증한다.
set -eu
ROOT=/tmp/dva129
MIGRATIONS=$ROOT/backend/migrations
RUNNER=$ROOT/infra/database/migrate.sh
DATABASE=membership_upgrade_check
export POSTGRES_DB=$DATABASE
createdb -U dva "$DATABASE"
OLD_ROOT=$ROOT/membership-old-release
mkdir -p "$OLD_ROOT/backend/migrations" "$OLD_ROOT/infra/database"
for number in 001 002 003 004 005 007 008 009; do
 cp "$MIGRATIONS"/$number-*.sql "$OLD_ROOT/backend/migrations/"
done
cp "$RUNNER" "$OLD_ROOT/infra/database/migrate.sh"
sh "$OLD_ROOT/infra/database/migrate.sh" --no-backup dva-db-129-check > /dev/null
sql() { psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" "$@"; }
sql <<'SQL'
DO $$
DECLARE a integer; co integer; cu integer; o integer;
BEGIN
 INSERT INTO admin_users(login_id,name,password_hash,role,status)
 VALUES('upgrade009Admin','fixture','test-only','OPERATOR','ACTIVE') RETURNING admin_user_seq INTO a;
 INSERT INTO customers(name,phone_number,status) VALUES('fixture','01900000009','ACTIVE') RETURNING customer_seq INTO cu;
 INSERT INTO organizations(name,status) VALUES('fixture','ACTIVE') RETURNING organization_seq INTO co;
 INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status) VALUES(cu,co,'0009','ORG_ADMIN','ACTIVE');
 INSERT INTO orders(customer_seq) VALUES(cu) RETURNING order_seq INTO o;
 INSERT INTO order_parcels(order_seq,parcel_position) VALUES(o,1);
 INSERT INTO call_sessions(order_seq,provider_call_id) VALUES(o,'upgrade009-call');
 INSERT INTO audit_logs(actor_type,actor_seq,action,target_type,target_seq,request_id,result,metadata)
 VALUES('ADMIN',a,'ORDER_CREATED','ORDER',o,'00000000-0000-4000-8000-000000000009','SUCCESS','{}');
 INSERT INTO api_idempotency.membership_writes(admin_user_seq,idempotency_key,organization_seq,operation,request_hash)
 VALUES(a,'00000000-0000-4000-8000-000000000009',co,'IMPORT',repeat('a',64));
 INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload) VALUES('upgrade009-recording','{}');
END $$;
SQL
snapshot() {
 sql -Atc "SELECT jsonb_build_object(
  'customers',(SELECT jsonb_agg(to_jsonb(c) ORDER BY customer_seq) FROM customers c),
  'organizations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY organization_seq) FROM organizations o),
  'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY membership_seq) FROM memberships m),
  'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY order_seq) FROM orders o),
  'parcels',(SELECT jsonb_agg(to_jsonb(p) ORDER BY order_parcel_seq) FROM order_parcels p),
  'calls',(SELECT jsonb_agg(to_jsonb(c) ORDER BY call_session_seq) FROM call_sessions c),
  'audits',(SELECT jsonb_agg(to_jsonb(a) ORDER BY audit_log_seq) FROM audit_logs a),
  'pbx',(SELECT jsonb_agg(to_jsonb(p) ORDER BY recording_id) FROM pbx_webhooks.call_ended_events p))"
}
BEFORE=$(snapshot)
HISTORY_BEFORE=$(sql -Atc 'SELECT jsonb_agg(to_jsonb(a) ORDER BY version) FROM db_migrations.applied_versions a')

# 후속 오류가 나면 테이블·스키마 삭제도 모두 롤백한다.
cat "$MIGRATIONS/010-remove-membership-write-requests.sql" > "$ROOT/membership-failure.sql"
printf '\nSELECT 1/0;\n' >> "$ROOT/membership-failure.sql"
if sql -1 -f "$ROOT/membership-failure.sql" > "$ROOT/membership-failure.log" 2>&1; then
 echo 'FAIL: invalid membership cleanup was accepted' >&2; exit 1
fi
test "$(sql -Atc 'SELECT count(*) FROM api_idempotency.membership_writes')" = 1
test "$(sql -Atc 'SELECT count(*) FROM db_migrations.applied_versions')" = 8
test "$(snapshot)" = "$BEFORE"

BACKUP_DIR=$ROOT/membership-upgrade-backups
sh "$RUNNER" dva-db-129-check "$BACKUP_DIR"
sql -f "$ROOT/infra/database/verify.sql"
test "$(snapshot)" = "$BEFORE"
test "$(sql -Atc "SELECT to_regclass('api_idempotency.membership_writes') IS NULL")" = t
test "$(sql -Atc "SELECT count(*) FROM pg_namespace WHERE nspname='api_idempotency'")" = 0
test "$(sql -Atc 'SELECT count(*) FROM db_migrations.applied_versions')" = 9
test "$(sql -Atc "SELECT jsonb_agg(to_jsonb(a) ORDER BY version) FROM db_migrations.applied_versions a WHERE version<>'010-remove-membership-write-requests.sql'")" = "$HISTORY_BEFORE"
test "$(sql -Atc "SELECT count(*) FROM db_migrations.applied_versions WHERE version IN ('009-membership-write-requests.sql','010-remove-membership-write-requests.sql')")" = 2
HISTORY_AFTER=$(sql -Atc 'SELECT jsonb_agg(to_jsonb(a) ORDER BY version) FROM db_migrations.applied_versions a')
sh "$RUNNER" --no-backup dva-db-129-check > /dev/null
test "$(sql -Atc 'SELECT jsonb_agg(to_jsonb(a) ORDER BY version) FROM db_migrations.applied_versions a')" = "$HISTORY_AFTER"
BACKUP=$(find "$BACKUP_DIR" -type f ! -name '*.sha256')
sha256sum -c "$BACKUP.sha256"
createdb -U dva membership_backup_check
pg_restore --exit-on-error --no-owner -U dva -d membership_backup_check "$BACKUP"
test "$(psql -X -At -U dva -d membership_backup_check -c 'SELECT count(*) FROM api_idempotency.membership_writes')" = 1
test "$(psql -X -At -U dva -d membership_backup_check -c 'SELECT count(*) FROM db_migrations.applied_versions')" = 8
echo 'PASS: 009 to 010 upgrade, immutable prior history, business preservation, rollback, repeat execution and restorable backup'
