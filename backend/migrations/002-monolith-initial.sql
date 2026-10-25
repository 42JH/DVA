-- S15P31D109-129: monolith ERD dated 2026-10-25.
-- Apply only through infra/database/migrate.sh (transaction + checksum ledger).
-- No MSA schemas, event tables, seed accounts, or application APIs are installed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

CREATE FUNCTION valid_parcel_address(value jsonb) RETURNS boolean
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
 IF jsonb_typeof(value->'latitude') IS DISTINCT FROM 'number'
  OR jsonb_typeof(value->'longitude') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
 IF (value->>'latitude')::numeric NOT BETWEEN -90 AND 90
  OR (value->>'longitude')::numeric NOT BETWEEN -180 AND 180 THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(value) k WHERE k NOT IN
  ('name','phoneNumber','roadAddress','jibunAddress','detailAddress','dongName','postalCode','latitude','longitude')) THEN RETURN false; END IF;
 RETURN true;
END $$;

CREATE FUNCTION pin_identity(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_object_agg(key,lower(btrim(regexp_replace(normalize(
  CASE WHEN key='detailAddress' THEN coalesce(value->>key,'') ELSE value->>key END,NFC),'[[:space:]]+',' ','g'))))
 FROM unnest(ARRAY['name','phoneNumber','roadAddress','jibunAddress','detailAddress','dongName','postalCode']) AS fields(key)
$$;

CREATE TABLE customers (
 customer_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 name text NOT NULL,
 phone_number text NOT NULL UNIQUE,
 status text NOT NULL,
 CHECK (phone_number ~ '^[0-9]+$'),
 CHECK (status IN ('ACTIVE','WITHDRAWN'))
);

CREATE TABLE organizations (
 organization_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 name text NOT NULL,
 status text NOT NULL,
 CHECK (status IN ('ACTIVE','INACTIVE'))
);

CREATE TABLE memberships (
 membership_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 customer_seq integer NOT NULL UNIQUE,
 organization_seq integer NOT NULL,
 employee_no text NOT NULL,
 role text NOT NULL DEFAULT 'MEMBER',
 status text NOT NULL,
 CHECK (btrim(employee_no)<>''),
 CHECK (role IN ('MEMBER','ORG_ADMIN')),
 CHECK (status IN ('ACTIVE','INACTIVE')),
 UNIQUE (organization_seq,employee_no)
);

CREATE TABLE personal_pins (
 personal_pin_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 customer_seq integer NOT NULL,
 label text,
 address_data jsonb NOT NULL,
 search_text text GENERATED ALWAYS AS (lower(normalize(coalesce(label,'') || ' ' || (address_data->>'name') || ' ' || (address_data->>'phoneNumber') || ' ' || (address_data->>'roadAddress') || ' ' || (address_data->>'jibunAddress') || ' ' || coalesce(address_data->>'detailAddress',''),NFC))) STORED,
 version integer NOT NULL DEFAULT 1,
 CHECK (valid_parcel_address(address_data)),
 CHECK (version > 0)
);

CREATE TABLE company_pins (
 company_pin_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 organization_seq integer NOT NULL,
 label text,
 department_name text,
 address_data jsonb NOT NULL,
 search_text text GENERATED ALWAYS AS (lower(normalize(coalesce(label,'') || ' ' || coalesce(department_name,'') || ' ' || (address_data->>'name') || ' ' || (address_data->>'phoneNumber') || ' ' || (address_data->>'roadAddress') || ' ' || (address_data->>'jibunAddress') || ' ' || coalesce(address_data->>'detailAddress',''),NFC))) STORED,
 version integer NOT NULL DEFAULT 1,
 CHECK (valid_parcel_address(address_data)),
 CHECK (version > 0)
);

CREATE TABLE orders (
 order_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 customer_seq integer,
 payment_method_type text NOT NULL DEFAULT 'credit',
 pickup_requested_at timestamptz,
 status text NOT NULL DEFAULT 'COLLECTING',
 version integer NOT NULL DEFAULT 1,
 parcel_no text,
 dver_received_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (payment_method_type IN ('cat','billing','credit','groupBilling')),
 CHECK (status IN ('COLLECTING','SUBMITTING','ACCEPTED','AUTH_FAILED','REVIEW_REQUIRED','CANCELLED','EXPIRED')),
 CHECK (version>0),
 CHECK (parcel_no ~ '^[A-Za-z0-9]{8}$'),
 CHECK (status NOT IN ('SUBMITTING','ACCEPTED','AUTH_FAILED','REVIEW_REQUIRED') OR pickup_requested_at IS NOT NULL),
 CHECK ((status='ACCEPTED' AND parcel_no IS NOT NULL AND dver_received_at IS NOT NULL) OR (status<>'ACCEPTED' AND parcel_no IS NULL AND dver_received_at IS NULL))
);

CREATE TABLE order_parcels (
 order_parcel_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 order_seq integer NOT NULL,
 parcel_position integer NOT NULL,
 origin_name text,
 origin_phone_number text,
 origin_road_address text,
 origin_jibun_address text,
 origin_detail_address text,
 origin_dong_name text,
 origin_postal_code text,
 origin_latitude double precision,
 origin_longitude double precision,
 origin_pin_scope text,
 origin_pin_seq integer,
 destination_name text,
 destination_phone_number text,
 destination_road_address text,
 destination_jibun_address text,
 destination_detail_address text,
 destination_dong_name text,
 destination_postal_code text,
 destination_latitude double precision,
 destination_longitude double precision,
 document_count integer NOT NULL DEFAULT 0,
 small_box_count integer NOT NULL DEFAULT 0,
 medium_box_count integer NOT NULL DEFAULT 0,
 big_box_count integer NOT NULL DEFAULT 0,
 other_item_description text NOT NULL DEFAULT '',
 client_comment text NOT NULL DEFAULT '',
 notified_price integer NOT NULL DEFAULT 3500,
 item_price bigint,
 CHECK (parcel_position>0),
 CHECK (origin_phone_number ~ '^[0-9]+$'),
 CHECK (origin_latitude BETWEEN -90 AND 90),
 CHECK (origin_longitude BETWEEN -180 AND 180),
 CHECK (origin_pin_scope IN ('PERSONAL','COMPANY')),
 CHECK (origin_pin_seq>0),
 CHECK (destination_phone_number ~ '^[0-9]+$'),
 CHECK (destination_latitude BETWEEN -90 AND 90),
 CHECK (destination_longitude BETWEEN -180 AND 180),
 CHECK (document_count>=0),
 CHECK (small_box_count>=0),
 CHECK (medium_box_count>=0),
 CHECK (big_box_count>=0),
 CHECK (notified_price=3500),
 CHECK (item_price BETWEEN 0 AND 9007199254740991),
 CHECK (num_nonnulls(origin_pin_scope,origin_pin_seq) IN (0,2)),
 UNIQUE (order_seq,parcel_position)
);

CREATE TABLE call_sessions (
 call_session_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 order_seq integer,
 provider_call_id text NOT NULL UNIQUE,
 caller_phone_number text,
 started_at timestamptz,
 ended_at timestamptz,
 end_reason text,
 CHECK (btrim(provider_call_id)<>''),
 CHECK ((started_at IS NULL AND ended_at IS NULL AND end_reason IS NULL) OR (started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at>=started_at))
);

CREATE TABLE call_utterances (
 call_utterance_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 call_session_seq integer NOT NULL,
 utterance_order integer NOT NULL,
 speaker text NOT NULL,
 utterance_text text NOT NULL,
 last_sentence_seq integer NOT NULL,
 received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (utterance_order>0),
 CHECK (speaker IN ('CUSTOMER','AI')),
 CHECK (length(utterance_text)>0),
 CHECK (last_sentence_seq>0),
 UNIQUE (call_session_seq,utterance_order)
);

CREATE TABLE recordings (
 recording_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 call_session_seq integer NOT NULL,
 object_key text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (object_key !~ '(^/|\.\.|://)')
);

CREATE TABLE handoff_requests (
 handoff_request_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 call_session_seq integer NOT NULL UNIQUE,
 reason text NOT NULL,
 status text NOT NULL,
 assigned_admin_user_seq integer,
 summary_text text,
 requested_at timestamptz NOT NULL,
 CHECK (status IN ('REQUESTED','CONNECTED','FAILED'))
);

CREATE TABLE shipments (
 shipment_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 order_parcel_seq integer NOT NULL UNIQUE,
 tracking_number text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'notPaid',
 version integer NOT NULL DEFAULT 1,
 status_changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (btrim(tracking_number)<>''),
 CHECK (status IN ('notPaid','paid','received','waiting','sent','canceling','canceled')),
 CHECK (version>0)
);

CREATE TABLE shipment_status_history (
 shipment_status_history_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 shipment_seq integer NOT NULL,
 request_id uuid NOT NULL UNIQUE,
 from_status text,
 to_status text NOT NULL,
 actor_type text NOT NULL,
 actor_admin_user_seq integer,
 occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (from_status IN ('notPaid','paid','received','waiting','sent','canceling','canceled')),
 CHECK (to_status IN ('notPaid','paid','received','waiting','sent','canceling','canceled')),
 CHECK (actor_type IN ('ADMIN','SYSTEM')),
 CHECK ((actor_type='ADMIN' AND actor_admin_user_seq IS NOT NULL AND actor_admin_user_seq>0) OR (actor_type='SYSTEM' AND actor_admin_user_seq IS NULL))
);

CREATE TABLE admin_users (
 admin_user_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 login_id text NOT NULL UNIQUE,
 password_hash text NOT NULL,
 role text NOT NULL,
 status text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_login_at timestamptz,
 CHECK (role IN ('OPERATOR','SUPERVISOR','SYSTEM_ADMIN')),
 CHECK (status IN ('ACTIVE','PENDING'))
);

CREATE TABLE audit_logs (
 audit_log_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 actor_type text NOT NULL,
 actor_seq integer,
 action text NOT NULL,
 target_type text NOT NULL,
 target_seq integer,
 request_id uuid NOT NULL,
 result text NOT NULL,
 metadata jsonb NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (actor_type IN ('ADMIN','SYSTEM')),
 CHECK (result IN ('SUCCESS','DENIED','FAILED')),
 CHECK (jsonb_typeof(metadata)='object'),
 CHECK ((actor_type='ADMIN' AND actor_seq IS NOT NULL AND actor_seq>0) OR (actor_type='SYSTEM' AND actor_seq IS NULL))
);

CREATE TABLE ai_personas (
 ai_persona_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 code text NOT NULL UNIQUE,
 name text NOT NULL,
 is_enabled boolean NOT NULL DEFAULT true,
 voice_id text,
 turn_wait_level text NOT NULL DEFAULT 'NORMAL',
 speaking_rate numeric,
 CHECK (voice_id IS NULL OR btrim(voice_id)<>''),
 CHECK (turn_wait_level IN ('SHORT','NORMAL','LONG')),
 CHECK (speaking_rate IS NULL OR (speaking_rate>0 AND speaking_rate<'Infinity'::numeric))
);

CREATE TABLE ai_prompt_versions (
 ai_prompt_version_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 ai_persona_seq integer NOT NULL,
 version integer NOT NULL,
 prompt_text text NOT NULL,
 is_active boolean NOT NULL DEFAULT false,
 created_by_admin_user_seq integer,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (version > 0),
 CHECK (btrim(prompt_text) <> ''),
 UNIQUE (ai_persona_seq,version)
);

CREATE TABLE faq_entries (
 faq_entry_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
 question text NOT NULL,
 answer text NOT NULL,
 updated_by_admin_user_seq integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (btrim(question)<>''),
 CHECK (btrim(answer)<>'')
);

ALTER TABLE memberships ADD CONSTRAINT memberships_customer_seq_fk FOREIGN KEY (customer_seq) REFERENCES customers(customer_seq);
ALTER TABLE memberships ADD CONSTRAINT memberships_organization_seq_fk FOREIGN KEY (organization_seq) REFERENCES organizations(organization_seq);
ALTER TABLE personal_pins ADD CONSTRAINT personal_pins_customer_seq_fk FOREIGN KEY (customer_seq) REFERENCES customers(customer_seq);
ALTER TABLE company_pins ADD CONSTRAINT company_pins_organization_seq_fk FOREIGN KEY (organization_seq) REFERENCES organizations(organization_seq);
ALTER TABLE orders ADD CONSTRAINT orders_customer_seq_fk FOREIGN KEY (customer_seq) REFERENCES customers(customer_seq);
ALTER TABLE order_parcels ADD CONSTRAINT order_parcels_order_seq_fk FOREIGN KEY (order_seq) REFERENCES orders(order_seq);
ALTER TABLE call_sessions ADD CONSTRAINT call_sessions_order_seq_fk FOREIGN KEY (order_seq) REFERENCES orders(order_seq);
ALTER TABLE call_utterances ADD CONSTRAINT call_utterances_call_session_seq_fk FOREIGN KEY (call_session_seq) REFERENCES call_sessions(call_session_seq);
ALTER TABLE recordings ADD CONSTRAINT recordings_call_session_seq_fk FOREIGN KEY (call_session_seq) REFERENCES call_sessions(call_session_seq);
ALTER TABLE handoff_requests ADD CONSTRAINT handoff_requests_call_session_seq_fk FOREIGN KEY (call_session_seq) REFERENCES call_sessions(call_session_seq);
ALTER TABLE handoff_requests ADD CONSTRAINT handoff_requests_assigned_admin_user_seq_fk FOREIGN KEY (assigned_admin_user_seq) REFERENCES admin_users(admin_user_seq);
ALTER TABLE shipments ADD CONSTRAINT shipments_order_parcel_seq_fk FOREIGN KEY (order_parcel_seq) REFERENCES order_parcels(order_parcel_seq);
ALTER TABLE shipment_status_history ADD CONSTRAINT shipment_status_history_shipment_seq_fk FOREIGN KEY (shipment_seq) REFERENCES shipments(shipment_seq);
ALTER TABLE shipment_status_history ADD CONSTRAINT shipment_status_history_actor_admin_user_seq_fk FOREIGN KEY (actor_admin_user_seq) REFERENCES admin_users(admin_user_seq);
ALTER TABLE ai_prompt_versions ADD CONSTRAINT ai_prompt_versions_ai_persona_seq_fk FOREIGN KEY (ai_persona_seq) REFERENCES ai_personas(ai_persona_seq);
ALTER TABLE ai_prompt_versions ADD CONSTRAINT ai_prompt_versions_created_by_admin_user_seq_fk FOREIGN KEY (created_by_admin_user_seq) REFERENCES admin_users(admin_user_seq);
ALTER TABLE faq_entries ADD CONSTRAINT faq_entries_updated_by_admin_user_seq_fk FOREIGN KEY (updated_by_admin_user_seq) REFERENCES admin_users(admin_user_seq);

CREATE INDEX memberships_company_idx ON memberships(organization_seq,customer_seq);
CREATE INDEX personal_pins_scope_idx ON personal_pins(customer_seq,personal_pin_seq);
CREATE UNIQUE INDEX personal_pins_identity_uk ON personal_pins(customer_seq,pin_identity(address_data));
CREATE INDEX company_pins_scope_idx ON company_pins(organization_seq,company_pin_seq);
CREATE UNIQUE INDEX company_pins_identity_uk ON company_pins(organization_seq,lower(btrim(regexp_replace(normalize(coalesce(department_name,''),NFC),'[[:space:]]+',' ','g'))),pin_identity(address_data));
CREATE INDEX orders_resume_idx ON orders(customer_seq,updated_at DESC,order_seq) WHERE status='COLLECTING';
CREATE INDEX orders_list_idx ON orders(created_at DESC,order_seq DESC);
CREATE INDEX calls_order_idx ON call_sessions(order_seq,started_at,call_session_seq);
CREATE INDEX calls_retention_idx ON call_sessions(ended_at,provider_call_id);
CREATE INDEX utterances_pending_retention_idx ON call_utterances(received_at,call_session_seq);
CREATE INDEX recordings_call_idx ON recordings(call_session_seq,recording_seq);
CREATE INDEX recordings_retention_idx ON recordings(created_at,recording_seq);
CREATE INDEX handoff_queue_idx ON handoff_requests(status,requested_at);
CREATE INDEX shipment_history_lookup_idx ON shipment_status_history(shipment_seq,occurred_at,shipment_status_history_seq);
CREATE INDEX audits_target_idx ON audit_logs(target_type,target_seq,occurred_at DESC);
CREATE UNIQUE INDEX ai_one_active_prompt_uk ON ai_prompt_versions(ai_persona_seq) WHERE is_active;

-- Pin ownership stays fixed; generated search_text and versions follow edits.
CREATE FUNCTION guard_pin_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)->'customer_seq') IS DISTINCT FROM (to_jsonb(OLD)->'customer_seq')
  OR (to_jsonb(NEW)->'organization_seq') IS DISTINCT FROM (to_jsonb(OLD)->'organization_seq') THEN
  RAISE EXCEPTION 'Pin ownership cannot be reassigned' USING ERRCODE='23514';
 END IF;
 IF NEW.label IS DISTINCT FROM OLD.label OR NEW.address_data IS DISTINCT FROM OLD.address_data
  OR (to_jsonb(NEW)->'department_name') IS DISTINCT FROM (to_jsonb(OLD)->'department_name') THEN
  NEW.version=OLD.version+1;
 ELSE NEW.version=OLD.version; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER personal_pin_update_guard BEFORE UPDATE ON personal_pins
 FOR EACH ROW EXECUTE FUNCTION guard_pin_update();
CREATE TRIGGER company_pin_update_guard BEFORE UPDATE ON company_pins
 FOR EACH ROW EXECUTE FUNCTION guard_pin_update();

CREATE FUNCTION touch_order_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.customer_seq IS DISTINCT FROM OLD.customer_seq
  OR NEW.payment_method_type IS DISTINCT FROM OLD.payment_method_type
  OR NEW.pickup_requested_at IS DISTINCT FROM OLD.pickup_requested_at
  OR NEW.version IS DISTINCT FROM OLD.version THEN
  NEW.version=OLD.version+1;
 END IF;
 NEW.updated_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER order_header_timestamp BEFORE UPDATE ON orders
 FOR EACH ROW EXECUTE FUNCTION touch_order_header();

-- Serialize detail edits with their parent. Submitted address snapshots stay fixed.
CREATE FUNCTION guard_order_parcel_edit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id integer; parent_status text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.order_seq<>OLD.order_seq THEN
  RAISE EXCEPTION 'Parcel cannot be moved to another order' USING ERRCODE='23514'; END IF;
 parent_id=CASE WHEN TG_OP='DELETE' THEN OLD.order_seq ELSE NEW.order_seq END;
 SELECT status INTO parent_status FROM orders WHERE order_seq=parent_id FOR UPDATE;
 IF FOUND AND parent_status<>'COLLECTING' THEN
  RAISE EXCEPTION 'Submitted parcel snapshot is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION touch_order_parcel_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id integer;
BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 parent_id=CASE WHEN TG_OP='DELETE' THEN OLD.order_seq ELSE NEW.order_seq END;
 UPDATE orders SET version=version+1 WHERE order_seq=parent_id;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_parcel_edit_guard BEFORE INSERT OR UPDATE OR DELETE ON order_parcels
 FOR EACH ROW EXECUTE FUNCTION guard_order_parcel_edit();
CREATE TRIGGER order_parcel_parent_version AFTER INSERT OR UPDATE OR DELETE ON order_parcels
 FOR EACH ROW EXECUTE FUNCTION touch_order_parcel_parent();

CREATE FUNCTION guard_prompt_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.ai_persona_seq IS DISTINCT FROM OLD.ai_persona_seq OR NEW.version IS DISTINCT FROM OLD.version
  OR NEW.prompt_text IS DISTINCT FROM OLD.prompt_text
  OR NEW.created_by_admin_user_seq IS DISTINCT FROM OLD.created_by_admin_user_seq THEN
  RAISE EXCEPTION 'Create a new prompt version instead of overwriting history' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_prompt_history_guard BEFORE UPDATE ON ai_prompt_versions
 FOR EACH ROW EXECUTE FUNCTION guard_prompt_history();

CREATE FUNCTION notify_transcript_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('transcript_changed',jsonb_build_object('callSessionSeq',NEW.call_session_seq,
  'utteranceSeq',NEW.call_utterance_seq,'utteranceOrder',NEW.utterance_order)::text);
 RETURN NEW;
END $$;
CREATE TRIGGER transcript_change_notification AFTER INSERT OR UPDATE OF utterance_text ON call_utterances
 FOR EACH ROW EXECUTE FUNCTION notify_transcript_change();

CREATE FUNCTION touch_faq_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN NEW.updated_at=clock_timestamp(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER faq_entry_timestamp BEFORE UPDATE ON faq_entries
 FOR EACH ROW EXECUTE FUNCTION touch_faq_entry();
CREATE FUNCTION notify_faq_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_id integer;
BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
 entry_id=CASE WHEN TG_OP='DELETE' THEN OLD.faq_entry_seq ELSE NEW.faq_entry_seq END;
 PERFORM pg_notify('faq_changed',jsonb_build_object('faqEntrySeq',entry_id,'operation',TG_OP)::text);
 RETURN NULL;
END $$;
CREATE TRIGGER faq_change_notification AFTER INSERT OR UPDATE OR DELETE ON faq_entries
 FOR EACH ROW EXECUTE FUNCTION notify_faq_change();
