SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

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
 IF jsonb_typeof(value->'latitude') IS DISTINCT FROM 'number'
  OR jsonb_typeof(value->'longitude') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
 IF (value->>'latitude')::numeric NOT BETWEEN -90 AND 90
  OR (value->>'longitude')::numeric NOT BETWEEN -180 AND 180 THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(value) k WHERE k NOT IN
  ('roadAddress','jibunAddress','detailAddress','dongName','postalCode','latitude','longitude')) THEN RETURN false; END IF;
 RETURN true;
END $$;

-- A PIN or a historical shipment does not establish the customer's own address.
ALTER TABLE customers ADD COLUMN address_data jsonb;
ALTER TABLE customers ADD CONSTRAINT customers_address_data_check
 CHECK (address_data IS NULL OR valid_customer_address(address_data));
COMMENT ON COLUMN customers.address_data IS 'Customer own address, independent of PINs. NULL when unset.';

ALTER TABLE memberships ALTER COLUMN department_seq DROP NOT NULL;
