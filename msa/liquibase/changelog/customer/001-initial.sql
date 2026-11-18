CREATE FUNCTION valid_parcel_address(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE field text;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOREACH field IN ARRAY ARRAY['name','phoneNumber','roadAddress','jibunAddress','detailAddress','dongName','postalCode'] LOOP
  IF field='detailAddress' AND NOT (value ? field) THEN CONTINUE; END IF;
  IF jsonb_typeof(value->field) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  IF field <> 'detailAddress' AND btrim(value->>field) = '' THEN RETURN false; END IF;
 END LOOP;
 IF (value->>'phoneNumber') !~ '^[0-9]+$' THEN RETURN false; END IF;
 IF jsonb_typeof(value->'latitude') IS DISTINCT FROM 'number'
    OR jsonb_typeof(value->'longitude') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
 IF (value->>'latitude')::numeric NOT BETWEEN -90 AND 90
    OR (value->>'longitude')::numeric NOT BETWEEN -180 AND 180 THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(value) k WHERE k NOT IN
  ('name','phoneNumber','roadAddress','jibunAddress','detailAddress','dongName','postalCode','latitude','longitude'))
 THEN RETURN false; END IF;
 RETURN true;
END $$;

-- CustomerModule. Optional reusable profiles, not a customer registration prerequisite.
CREATE TABLE customers (
 customer_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL,
 phone_number text NOT NULL UNIQUE CHECK (phone_number ~ '^[0-9]+$'),
 status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','WITHDRAWN'))
);
CREATE TABLE organizations (
 organization_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL,
 status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','INACTIVE'))
);
CREATE TABLE memberships (
 membership_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 customer_seq integer NOT NULL REFERENCES customers,
 organization_seq integer NOT NULL REFERENCES organizations,
 role text NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER','ORG_ADMIN')),
 status text NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
 UNIQUE(customer_seq)
);
CREATE INDEX memberships_company_idx ON memberships(organization_seq,customer_seq);
-- Labels, usage and coordinate precision do not create a new recipient/address identity.
CREATE FUNCTION pin_identity(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_object_agg(key,lower(btrim(regexp_replace(normalize(CASE WHEN key='detailAddress' THEN coalesce(value->>key,'') ELSE value->>key END,NFC),'[[:space:]]+',' ','g'))))
 FROM unnest(ARRAY['name','phoneNumber','roadAddress','jibunAddress','detailAddress','dongName','postalCode']) AS fields(key)
$$;
CREATE TABLE personal_pins (
 personal_pin_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 customer_seq integer NOT NULL REFERENCES customers,
 label text,
 address_data jsonb NOT NULL CHECK (valid_parcel_address(address_data)),
 search_text text GENERATED ALWAYS AS
  (lower(normalize(coalesce(label,'') || ' ' || (address_data->>'name') || ' ' || (address_data->>'phoneNumber') || ' ' || (address_data->>'roadAddress') || ' ' || (address_data->>'jibunAddress') || ' ' || coalesce(address_data->>'detailAddress',''),NFC))) STORED,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX personal_pins_scope_idx ON personal_pins(customer_seq,personal_pin_seq);
CREATE UNIQUE INDEX personal_pins_identity_uk ON personal_pins(customer_seq,pin_identity(address_data));
CREATE TABLE company_pins (
 company_pin_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_seq integer NOT NULL REFERENCES organizations,
 label text,
 department_name text,
 address_data jsonb NOT NULL CHECK (valid_parcel_address(address_data)),
 search_text text GENERATED ALWAYS AS
  (lower(normalize(coalesce(label,'') || ' ' || coalesce(department_name,'') || ' ' || (address_data->>'name') || ' ' || (address_data->>'phoneNumber') || ' ' || (address_data->>'roadAddress') || ' ' || (address_data->>'jibunAddress') || ' ' || coalesce(address_data->>'detailAddress',''),NFC))) STORED,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX company_pins_scope_idx ON company_pins(organization_seq,company_pin_seq);
CREATE UNIQUE INDEX company_pins_identity_uk ON company_pins(organization_seq,lower(btrim(regexp_replace(normalize(coalesce(department_name,''),NFC),'[[:space:]]+',' ','g'))),pin_identity(address_data));

CREATE FUNCTION guard_pin_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='personal_pins' THEN
  IF NEW.customer_seq IS DISTINCT FROM OLD.customer_seq THEN
   RAISE EXCEPTION 'Pin ownership cannot be reassigned' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NEW.organization_seq IS DISTINCT FROM OLD.organization_seq THEN
   RAISE EXCEPTION 'Pin ownership cannot be reassigned' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.label IS DISTINCT FROM OLD.label OR NEW.address_data IS DISTINCT FROM OLD.address_data
  OR (TG_TABLE_NAME='company_pins' AND (to_jsonb(NEW)->'department_name') IS DISTINCT FROM (to_jsonb(OLD)->'department_name')) THEN
  NEW.version:=OLD.version+1;
 ELSE NEW.version:=OLD.version;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER personal_pin_update_guard BEFORE UPDATE ON personal_pins FOR EACH ROW EXECUTE FUNCTION guard_pin_update();
CREATE TRIGGER company_pin_update_guard BEFORE UPDATE ON company_pins FOR EACH ROW EXECUTE FUNCTION guard_pin_update();



