#!/bin/sh
# Runs only inside the disposable test-monolith container: 052 data -> 053 and backup restore.
set -eu
ROOT=/tmp/dva129
MIGRATIONS=$ROOT/backend/migrations
DATABASE=company_pin_retirement_check
createdb -U dva "$DATABASE"
sql() { psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" "$@"; }
for migration in "$MIGRATIONS"/*.sql; do
 case "$migration" in */053-*) break ;; esac
 sql -1 -f "$migration" > /dev/null
done
sql <<'SQL'
DO $$
DECLARE c integer; o integer; d integer; p integer; ord integer;
 a jsonb := '{"name":"Recipient","phoneNumber":"01012345678","roadAddress":"Road","jibunAddress":"Lot","detailAddress":"1","dongName":"Dong","postalCode":"01234"}';
BEGIN
 INSERT INTO customers(name,phone_number,status,address_data) VALUES('Recipient','01012345678','ACTIVE',a-'name'-'phoneNumber') RETURNING customer_seq INTO c;
 INSERT INTO organizations(name,status) VALUES('Legacy company','ACTIVE') RETURNING organization_seq INTO o;
 INSERT INTO departments(organization_seq,name) VALUES(o,'Legacy department') RETURNING department_seq INTO d;
 INSERT INTO memberships(organization_seq,customer_seq,employee_no,department_seq,role,status) VALUES(o,c,'0001',d,'MEMBER','ACTIVE');
 INSERT INTO personal_pins(customer_seq,label,address_data,version) VALUES(c,'Private',a,7);
 INSERT INTO company_pins(organization_seq,department_seq,department_name,address_data) VALUES(o,d,'Legacy department',a) RETURNING company_pin_seq INTO p;
 INSERT INTO orders(customer_seq,payment_method_type) VALUES(c,'billing') RETURNING order_seq INTO ord;
 INSERT INTO order_parcels(order_seq,parcel_position,origin_pin_scope,origin_pin_seq,origin_name,origin_phone_number,origin_road_address,origin_jibun_address,origin_detail_address,origin_dong_name,origin_postal_code)
 VALUES(ord,1,'COMPANY',p,'Recipient','01012345678','Road','Lot','1','Dong','01234');
 INSERT INTO audit_logs(actor_type,action,target_type,target_seq,request_id,result,metadata)
 VALUES('SYSTEM','COMPANY_PIN_CREATED','COMPANY_PIN',p,'00000000-0000-4000-8000-000000000053','SUCCESS','{}');
END $$;
SQL
snapshot() {
 sql -At <<'SQL'
SELECT md5(jsonb_build_object(
 'customers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY customer_seq) FROM customers t),
 'organizations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY organization_seq) FROM organizations t),
 'departments',(SELECT jsonb_agg(to_jsonb(t) ORDER BY department_seq) FROM departments t),
 'memberships',(SELECT jsonb_agg(to_jsonb(t) ORDER BY membership_seq) FROM memberships t),
 'personal',(SELECT jsonb_agg(to_jsonb(t) ORDER BY personal_pin_seq) FROM personal_pins t),
 'orders',(SELECT jsonb_agg(to_jsonb(t) ORDER BY order_seq) FROM orders t),
 'parcels',(SELECT jsonb_agg(to_jsonb(t) ORDER BY order_parcel_seq) FROM order_parcels t),
 'audits',(SELECT jsonb_agg(to_jsonb(t) ORDER BY audit_log_seq) FROM audit_logs t)
)::text);
SQL
}
company_snapshot() { sql -Atc 'SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY company_pin_seq)::text) FROM company_pins t'; }
before=$(snapshot)
company_before=$(company_snapshot)
pg_dump -U dva -d "$DATABASE" -Fc -f "$ROOT/company-pin-before.dump"
sha256sum "$ROOT/company-pin-before.dump" > "$ROOT/company-pin-before.dump.sha256"

if sql -1 -f "$MIGRATIONS/053-drop-company-pins.sql" -c 'SELECT 1/0' > "$ROOT/company-pin-failure.log" 2>&1; then
 echo 'FAIL: synthetic post-DROP failure succeeded' >&2; exit 1
fi
test "$(snapshot)" = "$before"
test "$(company_snapshot)" = "$company_before"
sql -c 'CREATE VIEW company_pin_dependency_probe AS SELECT * FROM company_pins'
if sql -1 -f "$MIGRATIONS/053-drop-company-pins.sql" > "$ROOT/company-pin-dependency.log" 2>&1; then
 echo 'FAIL: DROP silently removed an unexpected dependent object' >&2; exit 1
fi
sql -c 'DROP VIEW company_pin_dependency_probe'
sql -1 -f "$MIGRATIONS/053-drop-company-pins.sql"
test "$(sql -Atc "SELECT to_regclass('public.company_pins') IS NULL AND to_regclass('public.company_pins_company_pin_seq_seq') IS NULL")" = t
test "$(snapshot)" = "$before"
test "$(sql -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = 29
test "$(sql -Atc "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='f'")" = 25
sql -c "UPDATE personal_pins SET label='Still editable'"
test "$(sql -Atc 'SELECT version FROM personal_pins')" = 8

sha256sum -c "$ROOT/company-pin-before.dump.sha256"
createdb -U dva company_pin_restore_check
pg_restore --exit-on-error --no-owner -U dva -d company_pin_restore_check "$ROOT/company-pin-before.dump"
DATABASE=company_pin_restore_check
test "$(snapshot)" = "$before"
test "$(company_snapshot)" = "$company_before"
echo 'PASS: 053 preserves order/reference/audit/personal data, rolls back failed DROP, rejects dependent objects and restores populated 052 backup'
