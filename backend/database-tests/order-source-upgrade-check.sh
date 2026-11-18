#!/bin/sh
# 011 -> 012: preserve snapshots; never guess historical order sources.
set -eu
ROOT=/tmp/dva129
MIGRATIONS=$ROOT/backend/migrations
DATABASE=order_source_upgrade_check
createdb -U dva "$DATABASE"
sql() { psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" "$@"; }
for number in 001 002 003 004 005 007 008 009 010 011; do
 sql -1 -f "$MIGRATIONS"/$number-*.sql > /dev/null
done
sql <<'SQL'
INSERT INTO orders(status) VALUES('COLLECTING');
INSERT INTO orders(status,pickup_requested_at) VALUES('SUBMITTING',CURRENT_TIMESTAMP);
INSERT INTO orders(status,pickup_requested_at,parcel_no,dver_received_at)
VALUES('ACCEPTED',CURRENT_TIMESTAMP,'TEST0069',CURRENT_TIMESTAMP);
INSERT INTO call_sessions(order_seq,provider_call_id) VALUES(3,'source-upgrade-call');
CREATE TABLE source_expected AS SELECT to_jsonb(o) AS snapshot FROM orders o;
SQL
cat "$MIGRATIONS/012-order-creation-source.sql" > "$ROOT/source-failure.sql"
printf '\nSELECT 1/0;\n' >> "$ROOT/source-failure.sql"
if sql -1 -f "$ROOT/source-failure.sql" > "$ROOT/source-failure.log" 2>&1; then
 echo 'FAIL: order source rollback probe succeeded' >&2; exit 1
fi
test "$(sql -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='creation_source'")" = 0
sql -1 -f "$MIGRATIONS/012-order-creation-source.sql"
sql <<'SQL'
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM orders WHERE creation_source<>'UNKNOWN') THEN
  RAISE EXCEPTION 'Historical sources were guessed'; END IF;
 IF EXISTS((SELECT to_jsonb(o)-'creation_source' FROM orders o EXCEPT SELECT snapshot FROM source_expected)
   UNION ALL (SELECT snapshot FROM source_expected EXCEPT SELECT to_jsonb(o)-'creation_source' FROM orders o)) THEN
  RAISE EXCEPTION 'Order content, version or timestamps changed'; END IF;
 IF (SELECT order_seq FROM call_sessions WHERE provider_call_id='source-upgrade-call')<>3 THEN
  RAISE EXCEPTION 'Call association changed'; END IF;
END $$;
SQL
echo 'PASS: 011 to 012 preserves order snapshots, timestamps and call links; migration failure rolls back'
