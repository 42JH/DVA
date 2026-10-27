#!/bin/sh
# Runs only inside the disposable database verification container.
set -eu
ROOT=/tmp/dva129
MIGRATIONS=$ROOT/backend/migrations
DATABASE=creation_upgrade_check
createdb -U dva "$DATABASE"
for number in 001 002 003 004 005 007; do
 psql -X -v ON_ERROR_STOP=1 -1 -U dva -d "$DATABASE" -f "$MIGRATIONS"/$number-*.sql > /dev/null
done
psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" <<'SQL'
BEGIN;
INSERT INTO customers(name,phone_number,status) VALUES('upgrade fixture','01000000055','ACTIVE');
INSERT INTO organizations(name,status) VALUES('upgrade fixture','ACTIVE');
INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES('upgradeAdmin','fixture','test-only','SYSTEM_ADMIN','ACTIVE');
INSERT INTO orders(customer_seq) VALUES(1);
INSERT INTO order_parcels(order_seq,parcel_position) VALUES(1,1);
INSERT INTO call_sessions(order_seq,provider_call_id) VALUES(1,'upgrade-call');
INSERT INTO audit_logs(actor_type,actor_seq,action,target_type,target_seq,request_id,result,metadata)
VALUES('ADMIN',1,'ORDER_CREATED','ORDER',1,'00000000-0000-4000-8000-000000000001','SUCCESS','{}');
INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload) VALUES('upgrade-recording','{}');
INSERT INTO api_idempotency.organization_creations(admin_user_seq,idempotency_key,request_hash,organization_seq)
VALUES(1,'00000000-0000-4000-8000-000000000002',repeat('a',64),1);
INSERT INTO api_idempotency.customer_creations(idempotency_key,request_hash,customer_seq)
VALUES('00000000-0000-4000-8000-000000000003',repeat('a',64),1);
INSERT INTO api_idempotency.order_creations(actor_key,idempotency_key,request_hash,order_seq,response_version)
VALUES('admin:1','00000000-0000-4000-8000-000000000055',repeat('a',64),1,2);
CREATE TABLE upgrade_expected AS SELECT to_jsonb(o) AS snapshot FROM orders o;
COMMIT;
-- Legacy actor-scoped duplicate keys must stop the upgrade without discarding orders.
INSERT INTO orders(customer_seq) VALUES(1);
INSERT INTO api_idempotency.order_creations(actor_key,idempotency_key,request_hash,order_seq,response_version)
VALUES('call:1','00000000-0000-4000-8000-000000000055',repeat('b',64),2,1);
SQL
if psql -X -v ON_ERROR_STOP=1 -1 -U dva -d "$DATABASE" -f "$MIGRATIONS/008-simplify-creation-requests.sql" > "$ROOT/ambiguous-keys.log" 2>&1; then
 echo 'FAIL: ambiguous legacy order keys were accepted' >&2; exit 1
fi
grep -q 'Ambiguous legacy order creation keys' "$ROOT/ambiguous-keys.log"
test "$(psql -X -U dva -d "$DATABASE" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='orders' AND column_name='creation_request_id'")" = 0
test "$(psql -X -U dva -d "$DATABASE" -Atc 'SELECT count(*) FROM api_idempotency.order_creations')" = 2
psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" <<'SQL'
DELETE FROM api_idempotency.order_creations WHERE actor_key='call:1';
DELETE FROM orders WHERE order_seq=2;
SQL
# A later error must undo column creation, backfill, trigger changes and DROP together.
if psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" > "$ROOT/cleanup-rollback.log" 2>&1 <<SQL
BEGIN;
\i $MIGRATIONS/008-simplify-creation-requests.sql
SELECT 1/0;
COMMIT;
SQL
then
 echo 'FAIL: cleanup rollback probe succeeded' >&2; exit 1
fi
grep -q 'division by zero' "$ROOT/cleanup-rollback.log"
test "$(psql -X -U dva -d "$DATABASE" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='api_idempotency'")" = 3
test "$(psql -X -U dva -d "$DATABASE" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='orders' AND column_name='creation_request_id'")" = 0

psql -X -v ON_ERROR_STOP=1 -1 -U dva -d "$DATABASE" -f "$MIGRATIONS/008-simplify-creation-requests.sql"
psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" <<'SQL'
DO $$
BEGIN
 IF (SELECT to_jsonb(o)-'creation_request_id' FROM orders o WHERE order_seq=1) IS DISTINCT FROM (SELECT snapshot FROM upgrade_expected) THEN
  RAISE EXCEPTION 'Order business data/version/timestamps changed during backfill'; END IF;
 IF (SELECT creation_request_id FROM orders WHERE order_seq=1) <> '00000000-0000-4000-8000-000000000055'::uuid THEN
  RAISE EXCEPTION 'Legacy order creation key was not preserved'; END IF;
 IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='api_idempotency') THEN
  RAISE EXCEPTION 'Creation receipt tables remain'; END IF;
 IF (SELECT count(*) FROM customers)<>1 OR (SELECT count(*) FROM organizations)<>1
  OR (SELECT count(*) FROM order_parcels)<>1 OR (SELECT count(*) FROM audit_logs)<>1
  OR (SELECT order_seq FROM call_sessions WHERE provider_call_id='upgrade-call')<>1
  OR (SELECT count(*) FROM pbx_webhooks.call_ended_events WHERE recording_id='upgrade-recording')<>1 THEN
  RAISE EXCEPTION 'Existing business data or PBX receipt lost'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='orders'::regclass AND tgname='order_header_timestamp' AND tgenabled<>'O') THEN
  RAISE EXCEPTION 'Order trigger was not restored'; END IF;
END $$;
SQL
echo 'PASS: legacy key backfill, business data preservation, ambiguous-key rejection and cleanup rollback'
psql -X -v ON_ERROR_STOP=1 -1 -U dva -d "$DATABASE" -f "$MIGRATIONS/009-membership-write-requests.sql"
test "$(psql -X -U dva -d "$DATABASE" -Atc "SELECT to_regclass('api_idempotency.membership_writes') IS NOT NULL")" = t
test "$(psql -X -U dva -d "$DATABASE" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='api_idempotency'")" = 1
echo 'PASS: membership receipts are created after the old creation schema is removed'
