-- Customer-owned fields from monolith migrations 017/028/033/043/045.
SET LOCAL lock_timeout='5s';

CREATE FUNCTION valid_customer_address(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE field text;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOREACH field IN ARRAY ARRAY['roadAddress','jibunAddress','detailAddress','dongName','postalCode'] LOOP
  IF field='detailAddress' AND NOT (value ? field) THEN CONTINUE; END IF;
  IF jsonb_typeof(value->field) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  IF field<>'detailAddress' AND btrim(value->>field)='' THEN RETURN false; END IF;
 END LOOP;
 IF (value->>'postalCode') !~ '^[0-9]{5}$' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(value) k WHERE k NOT IN
  ('roadAddress','jibunAddress','detailAddress','dongName','postalCode')) THEN RETURN false; END IF;
 RETURN true;
END $$;

ALTER TABLE customers
 ADD COLUMN monthly_billing_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN address_data jsonb CHECK(address_data IS NULL OR valid_customer_address(address_data)),
 ADD COLUMN deleted_at timestamptz,
 ADD COLUMN anonymized_at timestamptz;
ALTER TABLE customers DROP CONSTRAINT customers_phone_number_key;
CREATE UNIQUE INDEX customers_phone_number_key ON customers(phone_number) WHERE deleted_at IS NULL;
CREATE INDEX customers_retention_idx ON customers(deleted_at) WHERE deleted_at IS NOT NULL;

ALTER TABLE organizations
 ADD COLUMN monthly_billing_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN created_at timestamptz,
 ADD COLUMN deleted_at timestamptz;
-- No customer creation audit source existed in this DB; do not fabricate a legacy date.
ALTER TABLE organizations ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX organizations_retention_idx ON organizations(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE departments (
 department_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_seq integer NOT NULL REFERENCES organizations(organization_seq),
 name text NOT NULL CHECK(name=btrim(name) AND length(name) BETWEEN 1 AND 100),
 group_billing_enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
 deleted_at timestamptz,
 UNIQUE(department_seq,organization_seq)
);
CREATE UNIQUE INDEX departments_organization_seq_name_key ON departments(organization_seq,name) WHERE deleted_at IS NULL;
CREATE INDEX departments_retention_idx ON departments(deleted_at) WHERE deleted_at IS NOT NULL;

-- Current monolith permits no department. Existing memberships keep their identities.
ALTER TABLE memberships ADD COLUMN department_seq integer, ADD COLUMN deleted_at timestamptz;
ALTER TABLE memberships ADD CONSTRAINT memberships_department_company_fk
 FOREIGN KEY(department_seq,organization_seq) REFERENCES departments(department_seq,organization_seq);
CREATE INDEX memberships_department_idx ON memberships(department_seq);
ALTER TABLE memberships DROP CONSTRAINT memberships_customer_seq_key;
CREATE UNIQUE INDEX memberships_customer_seq_key ON memberships(customer_seq) WHERE deleted_at IS NULL;
ALTER TABLE memberships DROP CONSTRAINT memberships_organization_employee_no_key;
CREATE UNIQUE INDEX memberships_organization_employee_no_key ON memberships(organization_seq,employee_no) WHERE deleted_at IS NULL;
CREATE INDEX memberships_retention_idx ON memberships(deleted_at) WHERE deleted_at IS NOT NULL;
