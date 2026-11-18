-- Historical billing identities survive deletion of the live company/department.
ALTER TABLE orders DROP CONSTRAINT orders_billing_organization_seq_fkey;
ALTER TABLE orders DROP CONSTRAINT orders_billing_department_fk;
ALTER TABLE organization_billing_months DROP CONSTRAINT organization_billing_months_organization_seq_fkey;
ALTER TABLE order_billing_charges DROP CONSTRAINT order_billing_charges_organization_seq_fkey;
ALTER TABLE orders ADD COLUMN billing_organization_name text;
ALTER TABLE orders ADD COLUMN billing_department_name text;
ALTER TABLE organization_billing_months ADD COLUMN organization_name text;

-- Backfill with the currently known names without changing historical timestamps.
ALTER TABLE orders DISABLE TRIGGER order_header_timestamp;
UPDATE orders x SET billing_organization_name=o.name FROM organizations o
 WHERE x.billing_organization_seq=o.organization_seq;
UPDATE orders x SET billing_department_name=d.name FROM departments d
 WHERE x.billing_department_seq=d.department_seq;
ALTER TABLE orders ENABLE TRIGGER order_header_timestamp;
UPDATE organization_billing_months b SET organization_name=o.name FROM organizations o
 WHERE b.organization_seq=o.organization_seq;

COMMENT ON COLUMN orders.billing_organization_seq IS '결제 당시 기업 번호. 기업 삭제 후에도 보존하는 논리 참조';
COMMENT ON COLUMN orders.billing_department_seq IS '결제 당시 부서 번호. 부서 삭제 후에도 보존하는 논리 참조';
COMMENT ON COLUMN orders.billing_organization_name IS '결제 당시 기업명. 기존 주문은 021 적용 시 확인 가능한 이름';
COMMENT ON COLUMN orders.billing_department_name IS '결제 당시 부서명. 기존 주문은 021 적용 시 확인 가능한 이름';
COMMENT ON COLUMN organization_billing_months.organization_seq IS '기업 청구 이력의 논리 참조. 기업 삭제 후에도 보존';
COMMENT ON COLUMN order_billing_charges.organization_seq IS '기업 청구 이력의 논리 참조. 기업 삭제 후에도 보존';

ALTER TABLE company_pins ADD COLUMN department_seq integer;
ALTER TABLE company_pins ADD CONSTRAINT company_pins_department_company_fk
 FOREIGN KEY(department_seq,organization_seq) REFERENCES departments(department_seq,organization_seq);
CREATE INDEX company_pins_department_idx ON company_pins(department_seq);
-- Only a unique normalized name match proves a legacy PIN's department.
UPDATE company_pins p SET department_seq=(
 SELECT min(d.department_seq) FROM departments d WHERE d.organization_seq=p.organization_seq
 AND lower(btrim(regexp_replace(normalize(d.name,NFC),'[[:space:]]+',' ','g')))=
     lower(btrim(regexp_replace(normalize(p.department_name,NFC),'[[:space:]]+',' ','g')))
 HAVING count(*)=1
) WHERE nullif(btrim(p.department_name),'') IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_pin_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)->'customer_seq') IS DISTINCT FROM (to_jsonb(OLD)->'customer_seq')
   OR (to_jsonb(NEW)->'organization_seq') IS DISTINCT FROM (to_jsonb(OLD)->'organization_seq') THEN
  RAISE EXCEPTION 'Pin ownership cannot be reassigned' USING ERRCODE='23514';
 END IF;
 IF NEW.label IS DISTINCT FROM OLD.label OR NEW.address_data IS DISTINCT FROM OLD.address_data
   OR (to_jsonb(NEW)->'department_name') IS DISTINCT FROM (to_jsonb(OLD)->'department_name')
   OR (to_jsonb(NEW)->'department_seq') IS DISTINCT FROM (to_jsonb(OLD)->'department_seq') THEN
  NEW.version=OLD.version+1;
 ELSE NEW.version=OLD.version; END IF;
 RETURN NEW;
END $$;
