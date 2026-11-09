-- Cross-service customer/pin authorization must be checked by the authenticated backend.
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

CREATE TABLE orders (
 order_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 customer_seq integer, -- Customer service ID (logical reference)
 payment_method_type text NOT NULL DEFAULT 'credit' CHECK (payment_method_type IN ('cat','billing','credit','groupBilling')),
 pickup_requested_at timestamptz,
 status text NOT NULL DEFAULT 'COLLECTING' CHECK (status IN ('COLLECTING','SUBMITTING','ACCEPTED','AUTH_FAILED','REVIEW_REQUIRED','CANCELLED','EXPIRED')),
 version integer NOT NULL DEFAULT 1 CHECK (version>0),
 parcel_no text CHECK (parcel_no ~ '^[A-Za-z0-9]{8}$'),
 dver_received_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (status NOT IN ('SUBMITTING','ACCEPTED','AUTH_FAILED','REVIEW_REQUIRED') OR pickup_requested_at IS NOT NULL),
 CHECK ((status='ACCEPTED' AND parcel_no IS NOT NULL AND dver_received_at IS NOT NULL) OR
  (status<>'ACCEPTED' AND parcel_no IS NULL AND dver_received_at IS NULL))
);
CREATE INDEX orders_resume_idx ON orders(customer_seq,updated_at DESC,order_seq) WHERE status='COLLECTING';
CREATE INDEX orders_list_idx ON orders(created_at DESC,order_seq DESC);

CREATE TABLE order_parcels (
 order_parcel_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_seq integer NOT NULL REFERENCES orders,
 parcel_position integer NOT NULL CHECK (parcel_position>0),
 origin_name text,
 origin_phone_number text CHECK (origin_phone_number ~ '^[0-9]+$'),
 origin_road_address text, origin_jibun_address text, origin_detail_address text,
 origin_dong_name text, origin_postal_code text,
 origin_latitude double precision CHECK (origin_latitude BETWEEN -90 AND 90),
 origin_longitude double precision CHECK (origin_longitude BETWEEN -180 AND 180),
 origin_pin_scope text CHECK (origin_pin_scope IN ('PERSONAL','COMPANY')),
 origin_pin_seq integer CHECK (origin_pin_seq>0),
 destination_name text,
 destination_phone_number text CHECK (destination_phone_number ~ '^[0-9]+$'),
 destination_road_address text, destination_jibun_address text, destination_detail_address text,
 destination_dong_name text, destination_postal_code text,
 destination_latitude double precision CHECK (destination_latitude BETWEEN -90 AND 90),
 destination_longitude double precision CHECK (destination_longitude BETWEEN -180 AND 180),
 document_count integer NOT NULL DEFAULT 0 CHECK (document_count>=0),
 small_box_count integer NOT NULL DEFAULT 0 CHECK (small_box_count>=0),
 medium_box_count integer NOT NULL DEFAULT 0 CHECK (medium_box_count>=0),
 big_box_count integer NOT NULL DEFAULT 0 CHECK (big_box_count>=0),
 other_item_description text NOT NULL DEFAULT '', client_comment text NOT NULL DEFAULT '',
 notified_price integer NOT NULL DEFAULT 3500 CHECK (notified_price=3500),
 item_price bigint CHECK (item_price BETWEEN 0 AND 9007199254740991),
 UNIQUE(order_seq,parcel_position),
 CHECK (num_nonnulls(origin_pin_scope,origin_pin_seq) IN (0,2))
);

-- JSON is assembled only for the external API / address helpers, not stored as order data.
CREATE FUNCTION parcel_address(p order_parcels,scope text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF scope='ORIGIN' THEN RETURN jsonb_build_object('name',p.origin_name,'phoneNumber',p.origin_phone_number,
  'roadAddress',p.origin_road_address,'jibunAddress',p.origin_jibun_address,'detailAddress',coalesce(p.origin_detail_address,''),
  'dongName',p.origin_dong_name,'postalCode',p.origin_postal_code,'latitude',p.origin_latitude,'longitude',p.origin_longitude);
 ELSIF scope='DESTINATION' THEN RETURN jsonb_build_object('name',p.destination_name,'phoneNumber',p.destination_phone_number,
  'roadAddress',p.destination_road_address,'jibunAddress',p.destination_jibun_address,'detailAddress',coalesce(p.destination_detail_address,''),
  'dongName',p.destination_dong_name,'postalCode',p.destination_postal_code,'latitude',p.destination_latitude,'longitude',p.destination_longitude);
 ELSE RAISE EXCEPTION 'Invalid address scope' USING ERRCODE='22023'; END IF;
END $$;

CREATE FUNCTION check_order_contents(target_order integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM order_parcels WHERE order_seq=target_order) THEN
  RAISE EXCEPTION 'At least one parcel is required' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM order_parcels p WHERE p.order_seq=target_order AND
  (NOT valid_parcel_address(parcel_address(p,'ORIGIN')) OR NOT valid_parcel_address(parcel_address(p,'DESTINATION'))
   OR p.item_price IS NULL OR (p.document_count=0 AND p.small_box_count=0 AND p.medium_box_count=0 AND p.big_box_count=0 AND btrim(p.other_item_description)=''))) THEN
  RAISE EXCEPTION 'Parcel fields are incomplete' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION guard_order_header() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'COLLECTING' THEN RAISE EXCEPTION 'Create order in COLLECTING state' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.customer_seq IS NOT NULL AND NEW.customer_seq IS DISTINCT FROM OLD.customer_seq THEN
  RAISE EXCEPTION 'Order ownership cannot be reassigned' USING ERRCODE='23514'; END IF;
 changed=NEW.customer_seq IS DISTINCT FROM OLD.customer_seq OR NEW.payment_method_type IS DISTINCT FROM OLD.payment_method_type
  OR NEW.pickup_requested_at IS DISTINCT FROM OLD.pickup_requested_at OR NEW.version IS DISTINCT FROM OLD.version;
 IF changed THEN
  IF OLD.status<>'COLLECTING' THEN RAISE EXCEPTION 'Submitted order header is immutable' USING ERRCODE='23514'; END IF;
  NEW.version=OLD.version+1;NEW.status='COLLECTING';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  (OLD.status='COLLECTING' AND NEW.status IN ('SUBMITTING','CANCELLED','EXPIRED')) OR
  (OLD.status='SUBMITTING' AND NEW.status IN ('ACCEPTED','AUTH_FAILED','REVIEW_REQUIRED')) OR
  (OLD.status='AUTH_FAILED' AND NEW.status='CANCELLED')) THEN
  RAISE EXCEPTION 'Invalid order state transition' USING ERRCODE='23514'; END IF;
 IF NEW.status='SUBMITTING' AND OLD.status<>'SUBMITTING' THEN PERFORM check_order_contents(NEW.order_seq); END IF;
 NEW.updated_at=CURRENT_TIMESTAMP;
 RETURN NEW;
END $$;
CREATE TRIGGER order_header_guard BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_order_header();

CREATE FUNCTION guard_order_detail() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent integer; state text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.order_seq<>OLD.order_seq THEN RAISE EXCEPTION 'Parcel cannot be moved' USING ERRCODE='23514'; END IF;
 parent=CASE WHEN TG_OP='DELETE' THEN OLD.order_seq ELSE NEW.order_seq END;
 SELECT status INTO STRICT state FROM orders WHERE order_seq=parent FOR UPDATE;
 IF state<>'COLLECTING' THEN RAISE EXCEPTION 'Submitted parcel snapshot is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE FUNCTION touch_order_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent integer;
BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 parent=CASE WHEN TG_OP='DELETE' THEN OLD.order_seq ELSE NEW.order_seq END;
 UPDATE orders SET version=version+1 WHERE order_seq=parent;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER parcel_edit_guard BEFORE INSERT OR UPDATE OR DELETE ON order_parcels FOR EACH ROW EXECUTE FUNCTION guard_order_detail();
CREATE TRIGGER parcel_content_version AFTER INSERT OR UPDATE OR DELETE ON order_parcels FOR EACH ROW EXECUTE FUNCTION touch_order_content();

-- Dver transport belongs to OrderModule; no separate request/event storage tables.
CREATE FUNCTION parcel_request(target_order integer) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE header orders%ROWTYPE; parcels jsonb;
BEGIN
 SELECT * INTO STRICT header FROM orders WHERE order_seq=target_order;
 IF header.status<>'COLLECTING' OR header.pickup_requested_at IS NULL THEN
  RAISE EXCEPTION 'Order fields are incomplete or not ready' USING ERRCODE='23514'; END IF;
 PERFORM check_order_contents(target_order);
 SELECT jsonb_agg(jsonb_build_object('origin',parcel_address(p,'ORIGIN'),'destination',parcel_address(p,'DESTINATION'),
  'item',jsonb_build_object('document',p.document_count,'smallBox',p.small_box_count,'mediumBox',p.medium_box_count,'bigBox',p.big_box_count,'etc',p.other_item_description),
  'clientComment',p.client_comment,'notifiedPrice',p.notified_price,'itemPrice',p.item_price,
  'customFields','[]'::jsonb) ORDER BY p.parcel_position)
 INTO parcels FROM order_parcels p WHERE p.order_seq=target_order;
 RETURN jsonb_build_object('paymentMethodType',header.payment_method_type,
  'pickupRequestedAt',to_char(header.pickup_requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'outboundParcels',parcels);
END $$;
CREATE FUNCTION prepare_submission(target_order integer,expected_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE request jsonb; current_version integer;
BEGIN
 SELECT version INTO STRICT current_version FROM orders WHERE order_seq=target_order FOR UPDATE;
 IF expected_version IS NOT NULL AND current_version<>expected_version THEN RAISE EXCEPTION 'Stale order version' USING ERRCODE='23514'; END IF;
 request=parcel_request(target_order);
 UPDATE orders SET status='SUBMITTING' WHERE order_seq=target_order;
 RETURN request;
END $$;
CREATE FUNCTION finish_submission(target_order integer,http_code integer,body jsonb) RETURNS text LANGUAGE plpgsql AS $$
DECLARE current_state text; accepted_at timestamptz; valid boolean:=false; outcome text;
BEGIN
 SELECT status INTO STRICT current_state FROM orders WHERE order_seq=target_order FOR UPDATE;
 IF current_state<>'SUBMITTING' THEN RAISE EXCEPTION 'Submission already finalized or not started' USING ERRCODE='23514'; END IF;
 IF http_code=200 AND jsonb_typeof(body)='object' AND body->'ok'='true'::jsonb
  AND jsonb_typeof(body->'parcelNo')='string' AND body->>'parcelNo' ~ '^[A-Za-z0-9]{8}$'
  AND jsonb_typeof(body->'receivedAt')='string'
  AND body->>'receivedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN
  BEGIN accepted_at=(body->>'receivedAt')::timestamptz;valid=true;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN valid=false; END;
 END IF;
 IF valid THEN outcome='ACCEPTED';
  UPDATE orders SET status='ACCEPTED',parcel_no=body->>'parcelNo',dver_received_at=accepted_at WHERE order_seq=target_order;
 ELSE outcome=CASE WHEN http_code=403 THEN 'AUTH_FAILED' ELSE 'REVIEW_REQUIRED' END;
  UPDATE orders SET status=outcome WHERE order_seq=target_order;
 END IF;
 RETURN outcome;
END $$;
CREATE FUNCTION cancel_order(target_order integer,target_customer integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE header orders%ROWTYPE;
BEGIN
 SELECT * INTO STRICT header FROM orders WHERE order_seq=target_order FOR UPDATE;
 IF target_customer IS NULL OR header.customer_seq IS DISTINCT FROM target_customer THEN
  RAISE EXCEPTION 'ORDER_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
 IF header.status IN ('SUBMITTING','ACCEPTED','REVIEW_REQUIRED') THEN
  RAISE EXCEPTION 'ORDER_RESULT_REQUIRES_REVIEW' USING ERRCODE='23514'; END IF;
 IF header.status='EXPIRED' THEN RAISE EXCEPTION 'ORDER_EXPIRED' USING ERRCODE='23514'; END IF;
 UPDATE orders SET status='CANCELLED' WHERE order_seq=target_order AND status<>'CANCELLED';
END $$;


-- A stale request is ambiguous, never an authorization to submit to Dver again.
CREATE FUNCTION flag_stale_submissions(before_time timestamptz) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
 IF before_time IS NULL OR before_time>=CURRENT_TIMESTAMP THEN
  RAISE EXCEPTION 'Recovery cutoff must be in the past' USING ERRCODE='22023'; END IF;
 UPDATE orders SET status='REVIEW_REQUIRED' WHERE status='SUBMITTING' AND updated_at<before_time;
 GET DIAGNOSTICS affected=ROW_COUNT; RETURN affected;
END $$;
-- Infrastructure template, included once per participating service database.
-- A separate row per destination permits independent acknowledgements.
CREATE TABLE outbox_events (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 destination text NOT NULL CHECK (btrim(destination)<>''),
 event_type text NOT NULL CHECK (btrim(event_type)<>''),
 aggregate_seq integer NOT NULL,
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 delivered_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox_events(occurred_at,event_id) WHERE delivered_at IS NULL;
CREATE TABLE inbox_events (
 event_id uuid PRIMARY KEY,
 source text NOT NULL CHECK (btrim(source)<>''),
 event_type text NOT NULL CHECK (btrim(event_type)<>''),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 processed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Insert inbox + business changes in ONE transaction. Compare payload/source/type on duplicates.
-- Receiver ACKs only committed processing; sender marks delivered_at only after ACK.
-- Relay and authenticated transport remain application work; this DDL is not a running worker.
CREATE FUNCTION publish_accepted_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='ACCEPTED' AND OLD.status IS DISTINCT FROM NEW.status THEN
  INSERT INTO outbox_events(destination,event_type,aggregate_seq,payload)
  SELECT 'delivery','OrderAccepted',NEW.order_seq,
   jsonb_build_object('orderSeq',NEW.order_seq,'orderParcelSeqs',jsonb_agg(order_parcel_seq ORDER BY order_parcel_seq))
  FROM order_parcels WHERE order_seq=NEW.order_seq;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER accepted_order_event AFTER UPDATE OF status ON orders
 FOR EACH ROW EXECUTE FUNCTION publish_accepted_order();

