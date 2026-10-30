#!/bin/sh
# 022 -> 023: existing paid requests become pending without rewriting financial data.
set -eu
ROOT=/tmp/dva129
MIGRATIONS=$ROOT/backend/migrations
DATABASE=payment_completion_upgrade_check
createdb -U dva "$DATABASE"
sql() { psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" "$@"; }
for migration in "$MIGRATIONS"/*.sql; do
 case "$migration" in */023-*) break ;; esac
 sql -1 -f "$migration" > /dev/null
done
sql <<'SQL'
INSERT INTO orders(payment_method_type,status,total_amount,paid_at,pickup_requested_at)
 VALUES('billing','PAID',3500,now(),now()+interval '1 hour'),('billing','notPaid',3500,NULL,NULL);
INSERT INTO order_payment_requests(order_seq,amount,expires_at,completed_at,provider_reference,notification_status)
 SELECT order_seq,3500,now()+interval '24 hours',paid_at,CASE WHEN paid_at IS NOT NULL THEN 'preserved-test-payment' END,'SENT' FROM orders;
CREATE TABLE original_orders AS SELECT order_seq,to_jsonb(o) AS snapshot FROM orders o;
CREATE TABLE original_requests AS SELECT payment_request_id,to_jsonb(r) AS snapshot FROM order_payment_requests r;
SQL
cat "$MIGRATIONS/023-payment-completion-notifications.sql" > "$ROOT/payment-completion-failure.sql"
printf '\nSELECT 1/0;\n' >> "$ROOT/payment-completion-failure.sql"
if sql -1 -f "$ROOT/payment-completion-failure.sql" > "$ROOT/payment-completion-failure.log" 2>&1; then
 echo 'FAIL: completion migration rollback probe succeeded' >&2; exit 1
fi
test "$(sql -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='order_payment_requests' AND column_name='completion_notification_status'")" = 0
sql -1 -f "$MIGRATIONS/023-payment-completion-notifications.sql"
sql <<'SQL'
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM orders o JOIN original_orders b USING(order_seq) WHERE to_jsonb(o) IS DISTINCT FROM b.snapshot)
 THEN RAISE EXCEPTION 'Migration rewrote order data/timestamps'; END IF;
 IF EXISTS(SELECT 1 FROM order_payment_requests r JOIN original_requests b USING(payment_request_id)
  WHERE to_jsonb(r)-'completion_notification_status'-'completion_notification_attempted_at'-'completion_notification_sent_at' IS DISTINCT FROM b.snapshot)
 THEN RAISE EXCEPTION 'Migration rewrote payment or original notice data'; END IF;
 IF (SELECT completion_notification_status FROM order_payment_requests WHERE order_seq=1)<>'PENDING'
  OR (SELECT completion_notification_status FROM order_payment_requests WHERE order_seq=2)<>'WAITING'
 THEN RAISE EXCEPTION 'Migration queued an unpaid request or missed a paid request'; END IF;
END $$;
SQL
echo 'PASS: completion notices queue existing paid requests, preserve financial data and roll back atomically'
