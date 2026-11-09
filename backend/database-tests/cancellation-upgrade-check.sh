#!/bin/sh
# 013 -> 014: retain receipts/snapshots; cancellation never reopens a parcel.
set -eu
ROOT=/tmp/dva129
MIGRATIONS=$ROOT/backend/migrations
DATABASE=cancellation_upgrade_check
createdb -U dva "$DATABASE"
sql() { psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" "$@"; }
for migration in "$MIGRATIONS"/*.sql; do
 case "$migration" in */014-*) break ;; esac
 sql -1 -f "$migration" > /dev/null
done
sql <<'SQL'
INSERT INTO orders DEFAULT VALUES;
INSERT INTO orders DEFAULT VALUES;
INSERT INTO order_parcels(order_seq,parcel_position,other_item_description) VALUES(1,1,'accepted snapshot'),(2,1,'cancelled snapshot');
UPDATE orders SET status='ACCEPTED',pickup_requested_at=CURRENT_TIMESTAMP,parcel_no='KEEP0001',dver_received_at=CURRENT_TIMESTAMP WHERE order_seq=1;
UPDATE orders SET status='CANCELLED' WHERE order_seq=2;
CREATE TABLE cancellation_expected AS SELECT to_jsonb(o) AS snapshot FROM orders o;
CREATE TABLE parcel_expected AS SELECT to_jsonb(p) AS snapshot FROM order_parcels p;
SQL
cat "$MIGRATIONS/014-order-cancellation.sql" > "$ROOT/cancellation-failure.sql"
printf '\nSELECT 1/0;\n' >> "$ROOT/cancellation-failure.sql"
if sql -1 -f "$ROOT/cancellation-failure.sql" > "$ROOT/cancellation-failure.log" 2>&1; then
 echo 'FAIL: cancellation rollback probe succeeded' >&2; exit 1
fi
test "$(sql -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='order_parcels' AND column_name='status'")" = 0
sql -1 -f "$MIGRATIONS/014-order-cancellation.sql"
sql <<'SQL'
CREATE FUNCTION must_fail(statement text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE statement;
 EXCEPTION WHEN check_violation THEN RETURN; END;
 RAISE EXCEPTION 'Expected constraint failure: %',statement;
END $$;
DO $$
BEGIN
 IF EXISTS((SELECT to_jsonb(o) FROM orders o EXCEPT SELECT snapshot FROM cancellation_expected)
  UNION ALL (SELECT snapshot FROM cancellation_expected EXCEPT SELECT to_jsonb(o) FROM orders o)) THEN
  RAISE EXCEPTION 'Migration changed parent content/version/timestamps'; END IF;
 IF EXISTS((SELECT to_jsonb(p)-'status' FROM order_parcels p EXCEPT SELECT snapshot FROM parcel_expected)
  UNION ALL (SELECT snapshot FROM parcel_expected EXCEPT SELECT to_jsonb(p)-'status' FROM order_parcels p)) THEN
  RAISE EXCEPTION 'Migration changed parcel snapshots'; END IF;
 IF (SELECT status FROM order_parcels WHERE order_seq=1)<>'ACTIVE'
  OR (SELECT status FROM order_parcels WHERE order_seq=2)<>'CANCELLED' THEN
  RAISE EXCEPTION 'Incorrect status backfill'; END IF;
END $$;
SELECT must_fail('UPDATE order_parcels SET other_item_description=''changed'' WHERE order_seq=1');
SELECT must_fail('UPDATE order_parcels SET status=''ACTIVE'' WHERE order_seq=2');
SELECT must_fail('DELETE FROM order_parcels WHERE order_seq=2');
SELECT must_fail('UPDATE orders SET parcel_no=NULL WHERE order_seq=1');
SELECT must_fail('UPDATE orders SET status=''COLLECTING'' WHERE order_seq=1');
UPDATE orders SET status='CANCELLED' WHERE order_seq=1;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM order_parcels WHERE status<>'CANCELLED') THEN
  RAISE EXCEPTION 'Whole cancellation did not cancel parcels'; END IF;
 IF (SELECT parcel_no FROM orders WHERE order_seq=1)<>'KEEP0001'
  OR (SELECT dver_received_at IS NULL FROM orders WHERE order_seq=1) THEN
  RAISE EXCEPTION 'Cancellation lost Dver receipt'; END IF;
 IF (SELECT version FROM orders WHERE order_seq=1)<=2 THEN
  RAISE EXCEPTION 'Cancellation did not advance version'; END IF;
END $$;
SELECT must_fail('UPDATE orders SET dver_received_at=NULL WHERE order_seq=1');
INSERT INTO orders DEFAULT VALUES;
INSERT INTO order_parcels(order_seq,parcel_position) VALUES(3,1),(3,2);
UPDATE order_parcels SET status='CANCELLED' WHERE order_seq=3 AND parcel_position=1;
SELECT must_fail('UPDATE order_parcels SET other_item_description=''changed'' WHERE order_seq=3 AND parcel_position=1');
UPDATE order_parcels SET other_item_description='editable' WHERE order_seq=3 AND parcel_position=2;
UPDATE orders SET status='SUBMITTING',pickup_requested_at=CURRENT_TIMESTAMP WHERE order_seq=3;
SELECT must_fail('UPDATE order_parcels SET status=''CANCELLED'' WHERE order_seq=3 AND parcel_position=2');
SQL
echo 'PASS: cancellation upgrade preserves snapshots/receipts, backfills status, guards edits and rolls back atomically'
