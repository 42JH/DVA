#!/bin/sh
# Uses only the disposable PostgreSQL instance from test-monolith.ps1.
set -eu
ROOT=/tmp/dva129
MIGRATIONS=$ROOT/backend/migrations
DATABASE=submission_upgrade_check
createdb -U dva "$DATABASE"
sql() { psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" "$@"; }
for number in 001 002 003 004 005 007 008 009 010; do
 sql -1 -f "$MIGRATIONS"/$number-*.sql > /dev/null
done
sql <<'SQL'
INSERT INTO orders(payment_method_type) VALUES('cat');
INSERT INTO orders(status,pickup_requested_at) VALUES('SUBMITTING',CURRENT_TIMESTAMP);
INSERT INTO orders(status,pickup_requested_at,parcel_no,dver_received_at)
VALUES('ACCEPTED',CURRENT_TIMESTAMP,'TEST0011',CURRENT_TIMESTAMP);
CREATE TABLE upgrade_expected AS SELECT order_seq,to_jsonb(o) AS snapshot FROM orders o;
SQL
cat "$MIGRATIONS/011-order-submission.sql" > "$ROOT/submission-failure.sql"
printf '\nSELECT 1/0;\n' >> "$ROOT/submission-failure.sql"
if sql -1 -f "$ROOT/submission-failure.sql" > "$ROOT/submission-failure.log" 2>&1; then
 echo 'FAIL: invalid submission upgrade was accepted' >&2; exit 1
fi
test "$(sql -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='orders' AND column_name='submission_request_id'")" = 0
sql -1 -f "$MIGRATIONS/011-order-submission.sql"
sql <<'SQL'
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM orders o JOIN upgrade_expected e USING(order_seq)
  WHERE to_jsonb(o)-ARRAY['submission_request_id','submission_expected_version','submission_started_at'] IS DISTINCT FROM e.snapshot) THEN
  RAISE EXCEPTION 'Submission migration changed existing order data'; END IF;
 IF EXISTS(SELECT 1 FROM orders WHERE num_nonnulls(submission_request_id,submission_expected_version,submission_started_at)<>0) THEN
  RAISE EXCEPTION 'Submission migration fabricated an intent'; END IF;
END $$;
SQL
echo 'PASS: submission upgrade preserves legacy cat/submitted orders and rolls back atomically'
