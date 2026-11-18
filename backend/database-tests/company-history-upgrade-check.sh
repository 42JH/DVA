#!/bin/sh
# 020 -> 021: preserve settled order content, timestamps, totals and unresolved PIN names.
set -eu
ROOT=/tmp/dva129
MIGRATIONS=$ROOT/backend/migrations
DATABASE=company_history_upgrade_check
createdb -U dva "$DATABASE"
sql() { psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" "$@"; }
for migration in "$MIGRATIONS"/*.sql; do
 case "$migration" in */021-*) break ;; esac
 sql -1 -f "$migration" > /dev/null
done
sql <<'SQL'
INSERT INTO organizations(name,status) VALUES('보존 기업','ACTIVE');
INSERT INTO departments(organization_seq,name) VALUES(1,'개발팀');
INSERT INTO orders(payment_method_type,status,total_amount,paid_at,billing_organization_seq,billing_department_seq)
 VALUES('groupBilling','PAID',5000,now(),1,1);
INSERT INTO order_billing_charges VALUES(1,1,date_trunc('month',now())::date,'groupBilling',5000,now());
INSERT INTO organization_billing_months(organization_seq,billing_month,group_billing_amount) VALUES(1,date_trunc('month',now())::date,5000);
INSERT INTO company_pins(organization_seq,department_name,address_data)
 SELECT 1,d,jsonb_build_object('name','보존','phoneNumber','01012345678','roadAddress','도로 1','jibunAddress','지번 1','dongName','검증동','postalCode','12345','latitude',37,'longitude',127)
 FROM (VALUES('개발팀'),('실제 배정 미확인')) x(d);
CREATE TABLE original_order AS SELECT to_jsonb(o) AS snapshot FROM orders o;
SQL
cat "$MIGRATIONS/021-company-deletion-history.sql" > "$ROOT/company-history-failure.sql"
printf '\nSELECT 1/0;\n' >> "$ROOT/company-history-failure.sql"
if sql -1 -f "$ROOT/company-history-failure.sql" > "$ROOT/company-history-failure.log" 2>&1; then
 echo 'FAIL: history rollback probe succeeded' >&2; exit 1
fi
test "$(sql -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='billing_organization_name'")" = 0
sql -1 -f "$MIGRATIONS/021-company-deletion-history.sql"
sql <<'SQL'
DO $$ BEGIN
 IF (SELECT to_jsonb(o)-'billing_organization_name'-'billing_department_name' FROM orders o) IS DISTINCT FROM (SELECT snapshot FROM original_order)
 THEN RAISE EXCEPTION 'Migration rewrote historical order/timestamps'; END IF;
 IF (SELECT billing_organization_name FROM orders)<>'보존 기업' OR (SELECT billing_department_name FROM orders)<>'개발팀'
 THEN RAISE EXCEPTION 'Known names not preserved'; END IF;
 IF (SELECT department_seq FROM company_pins WHERE company_pin_seq=1)<>1
  OR (SELECT department_seq FROM company_pins WHERE company_pin_seq=2) IS NOT NULL
 THEN RAISE EXCEPTION 'Legacy PIN assignment was lost or invented'; END IF;
END $$;
DELETE FROM company_pins;
DELETE FROM departments;
DELETE FROM organizations;
DO $$ BEGIN
 IF (SELECT group_billing_amount FROM organization_billing_months)<>5000 OR (SELECT amount FROM order_billing_charges)<>5000
  OR (SELECT billing_organization_name FROM orders)<>'보존 기업' THEN RAISE EXCEPTION 'Company deletion lost financial history'; END IF;
END $$;
SQL
echo 'PASS: company history upgrade preserves orders/timestamps/amounts, retains known names, leaves uncertain PINs unassigned and rolls back atomically'
