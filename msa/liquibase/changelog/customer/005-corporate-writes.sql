SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
ALTER TABLE company_pins ADD COLUMN department_seq integer, ADD COLUMN deleted_at timestamptz;
ALTER TABLE company_pins ADD CONSTRAINT company_pins_department_company_fk
 FOREIGN KEY(department_seq,organization_seq) REFERENCES departments(department_seq,organization_seq);
CREATE INDEX company_pins_department_idx ON company_pins(department_seq);
CREATE INDEX company_pins_retention_idx ON company_pins(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX customer_audit_decision_idx ON outbox_events((payload->>'transactionId')) WHERE event_type='AuditCommitted';
-- Only one normalized match proves the existing PIN's department (monolith 021).
UPDATE company_pins p SET department_seq=(
 SELECT min(d.department_seq) FROM departments d WHERE d.organization_seq=p.organization_seq
 AND lower(btrim(regexp_replace(normalize(d.name,NFC),'[[:space:]]+',' ','g')))=
     lower(btrim(regexp_replace(normalize(p.department_name,NFC),'[[:space:]]+',' ','g')))
 HAVING count(*)=1
) WHERE nullif(btrim(p.department_name),'') IS NOT NULL;

-- Match monolith 043; retired coordinates are removed without advancing PIN versions.
LOCK TABLE personal_pins, company_pins IN ACCESS EXCLUSIVE MODE;
ALTER TABLE personal_pins DROP CONSTRAINT personal_pins_address_data_check;
ALTER TABLE company_pins DROP CONSTRAINT company_pins_address_data_check;
ALTER TABLE personal_pins DISABLE TRIGGER personal_pin_update_guard;
ALTER TABLE company_pins DISABLE TRIGGER company_pin_update_guard;
UPDATE personal_pins SET address_data=address_data-'latitude'-'longitude' WHERE jsonb_exists_any(address_data,ARRAY['latitude','longitude']);
UPDATE company_pins SET address_data=address_data-'latitude'-'longitude' WHERE jsonb_exists_any(address_data,ARRAY['latitude','longitude']);
ALTER TABLE personal_pins ENABLE TRIGGER personal_pin_update_guard;
ALTER TABLE company_pins ENABLE TRIGGER company_pin_update_guard;
CREATE OR REPLACE FUNCTION valid_parcel_address(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE field text;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOREACH field IN ARRAY ARRAY['name','phoneNumber','roadAddress','jibunAddress','detailAddress','dongName','postalCode'] LOOP
  IF field='detailAddress' AND NOT (value ? field) THEN CONTINUE; END IF;
  IF jsonb_typeof(value->field) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  IF field<>'detailAddress' AND btrim(value->>field)='' THEN RETURN false; END IF;
 END LOOP;
 IF (value->>'phoneNumber') !~ '^[0-9]+$' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(value) k WHERE k NOT IN
  ('name','phoneNumber','roadAddress','jibunAddress','detailAddress','dongName','postalCode')) THEN RETURN false; END IF;
 RETURN true;
END $$;


ALTER TABLE personal_pins ADD CONSTRAINT personal_pins_address_data_check CHECK(valid_parcel_address(address_data));
ALTER TABLE company_pins ADD CONSTRAINT company_pins_address_data_check CHECK(valid_parcel_address(address_data));
DROP INDEX company_pins_identity_uk;
CREATE UNIQUE INDEX company_pins_identity_uk ON company_pins(organization_seq,lower(btrim(regexp_replace(normalize(coalesce(department_name,''),NFC),'[[:space:]]+',' ','g'))),pin_identity(address_data)) WHERE deleted_at IS NULL;
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
