-- Stop old writers and back up before applying this breaking address conversion.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

LOCK TABLE customers, personal_pins, company_pins, order_parcels IN ACCESS EXCLUSIVE MODE;

ALTER TABLE customers DROP CONSTRAINT customers_address_data_check;
ALTER TABLE personal_pins DROP CONSTRAINT personal_pins_address_data_check;
ALTER TABLE company_pins DROP CONSTRAINT company_pins_address_data_check;

UPDATE customers SET address_data=address_data-'latitude'-'longitude'
 WHERE address_data ?| ARRAY['latitude','longitude'];

-- Removing retired JSON keys must not advance PIN versions or change ownership.
ALTER TABLE personal_pins DISABLE TRIGGER personal_pin_update_guard;
ALTER TABLE company_pins DISABLE TRIGGER company_pin_update_guard;
UPDATE personal_pins SET address_data=address_data-'latitude'-'longitude'
 WHERE address_data ?| ARRAY['latitude','longitude'];
UPDATE company_pins SET address_data=address_data-'latitude'-'longitude'
 WHERE address_data ?| ARRAY['latitude','longitude'];
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

CREATE OR REPLACE FUNCTION valid_customer_address(value jsonb) RETURNS boolean
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

ALTER TABLE customers ADD CONSTRAINT customers_address_data_check
 CHECK (address_data IS NULL OR valid_customer_address(address_data));
ALTER TABLE personal_pins ADD CONSTRAINT personal_pins_address_data_check
 CHECK (valid_parcel_address(address_data));
ALTER TABLE company_pins ADD CONSTRAINT company_pins_address_data_check
 CHECK (valid_parcel_address(address_data));

-- Dropping columns preserves finalized/cancelled snapshots and parent versions/timestamps.
ALTER TABLE order_parcels
 DROP COLUMN origin_latitude,
 DROP COLUMN origin_longitude,
 DROP COLUMN destination_latitude,
 DROP COLUMN destination_longitude;
