SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE admin_users ADD COLUMN deleted_at timestamptz;
ALTER TABLE customers ADD COLUMN deleted_at timestamptz, ADD COLUMN anonymized_at timestamptz;
ALTER TABLE organizations ADD COLUMN deleted_at timestamptz;
ALTER TABLE departments ADD COLUMN deleted_at timestamptz;
ALTER TABLE memberships ADD COLUMN deleted_at timestamptz;
ALTER TABLE personal_pins ADD COLUMN deleted_at timestamptz;
ALTER TABLE company_pins ADD COLUMN deleted_at timestamptz;
ALTER TABLE faq_entries ADD COLUMN deleted_at timestamptz;
ALTER TABLE orders ADD COLUMN deleted_at timestamptz,
 ADD COLUMN closed_at timestamptz,
 ADD COLUMN created_by_admin_user_seq integer;
ALTER TABLE call_sessions ADD COLUMN deleted_at timestamptz,
 ADD COLUMN purge_claim_id uuid,
 ADD COLUMN purge_claimed_until timestamptz,
 ADD CONSTRAINT call_purge_claim_pair CHECK ((purge_claim_id IS NULL)=(purge_claimed_until IS NULL));
ALTER TABLE ai_persona_versions ADD COLUMN created_by_admin_user_name text;

-- Backfills must not consume order versions or replace historical timestamps.
ALTER TABLE orders DISABLE TRIGGER order_header_timestamp;
UPDATE orders o SET created_by_admin_user_seq=(
 SELECT a.actor_seq FROM audit_logs a WHERE a.target_type='ORDER' AND a.target_seq=o.order_seq
  AND a.action='ORDER_CREATED' AND a.actor_type='ADMIN' AND a.result='SUCCESS'
 ORDER BY a.occurred_at,a.audit_log_seq LIMIT 1);
UPDATE orders o SET closed_at=CASE WHEN status='ACCEPTED' THEN dver_received_at ELSE COALESCE((
 SELECT min(a.occurred_at) FROM audit_logs a WHERE a.target_type='ORDER' AND a.target_seq=o.order_seq
  AND a.action='ORDER_CANCELLED' AND a.result='SUCCESS'),created_at) END
 WHERE status IN ('ACCEPTED','CANCELLED');
ALTER TABLE orders ENABLE TRIGGER order_header_timestamp;
UPDATE ai_persona_versions v SET created_by_admin_user_name=COALESCE((
 SELECT a.actor_name FROM audit_logs a WHERE a.target_type='AI_PERSONA_VERSION'
  AND a.target_seq=v.ai_persona_version_seq AND a.actor_seq=v.created_by_admin_user_seq
  AND a.actor_type='ADMIN' AND a.result='SUCCESS' AND a.actor_name IS NOT NULL
 ORDER BY a.occurred_at,a.audit_log_seq LIMIT 1),
 (SELECT name FROM admin_users WHERE admin_user_seq=v.created_by_admin_user_seq));
-- Only an original PBX start proves a missing legacy call arrival time.
UPDATE call_sessions SET incoming_at=started_at WHERE incoming_at IS NULL AND started_at IS NOT NULL;

ALTER TABLE admin_users DROP CONSTRAINT admin_users_login_id_key;
CREATE UNIQUE INDEX admin_users_login_id_key ON admin_users(login_id) WHERE deleted_at IS NULL;
ALTER TABLE customers DROP CONSTRAINT customers_phone_number_key;
CREATE UNIQUE INDEX customers_phone_number_key ON customers(phone_number) WHERE deleted_at IS NULL;
ALTER TABLE memberships DROP CONSTRAINT memberships_customer_seq_key;
CREATE UNIQUE INDEX memberships_customer_seq_key ON memberships(customer_seq) WHERE deleted_at IS NULL;
ALTER TABLE memberships DROP CONSTRAINT memberships_organization_seq_employee_no_key;
CREATE UNIQUE INDEX memberships_organization_seq_employee_no_key
 ON memberships(organization_seq,employee_no) WHERE deleted_at IS NULL;
ALTER TABLE departments DROP CONSTRAINT departments_organization_seq_name_key;
CREATE UNIQUE INDEX departments_organization_seq_name_key ON departments(organization_seq,name) WHERE deleted_at IS NULL;
DROP INDEX personal_pins_identity_uk;
CREATE UNIQUE INDEX personal_pins_identity_uk ON personal_pins(customer_seq,pin_identity(address_data)) WHERE deleted_at IS NULL;
DROP INDEX company_pins_identity_uk;
CREATE UNIQUE INDEX company_pins_identity_uk ON company_pins(organization_seq,
 lower(btrim(regexp_replace(normalize(coalesce(department_name,''),NFC),'[[:space:]]+',' ','g'))),
 pin_identity(address_data)) WHERE deleted_at IS NULL;
DROP INDEX faq_entries_question_identity_uq;
CREATE UNIQUE INDEX faq_entries_question_identity_uq ON faq_entries
 (sha256(replace(lower(btrim(regexp_replace(normalize(question,NFC),'[[:space:]]+',' ','g'))),
 chr(92),chr(92)||chr(92))::bytea)) WHERE deleted_at IS NULL;

DO $$
DECLARE constraint_name text;
BEGIN
 SELECT conname INTO STRICT constraint_name FROM pg_constraint
 WHERE conrelid='unanswered_questions'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%status%DELETED%question_text%';
 EXECUTE format('ALTER TABLE unanswered_questions DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE unanswered_questions ADD CONSTRAINT unanswered_questions_lifecycle_check CHECK (
 (status='OPEN' AND question_text IS NOT NULL AND faq_entry_seq IS NULL
  AND faq_conversion_hash IS NULL AND registered_at IS NULL AND deleted_at IS NULL)
 OR (status='REGISTERED' AND question_text IS NOT NULL AND faq_entry_seq IS NOT NULL
  AND faq_conversion_hash IS NOT NULL AND registered_at IS NOT NULL AND deleted_at IS NULL)
 OR (status='DELETED' AND faq_entry_seq IS NULL AND faq_conversion_hash IS NULL
  AND registered_at IS NULL AND deleted_at IS NOT NULL));

CREATE INDEX orders_retention_idx ON orders((COALESCE(closed_at,created_at)),order_seq);
CREATE INDEX call_sessions_retention_idx ON call_sessions(incoming_at,call_session_seq);
CREATE INDEX audit_logs_retention_idx ON audit_logs(occurred_at,audit_log_seq);
CREATE INDEX faq_notifications_retention_idx ON faq_change_notifications(sent_at) WHERE sent_at IS NOT NULL;
DO $$
DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['admin_users','customers','organizations','departments','memberships','personal_pins','company_pins','faq_entries'] LOOP
  EXECUTE format('CREATE INDEX %I ON %I(deleted_at) WHERE deleted_at IS NOT NULL',table_name||'_retention_idx',table_name);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION touch_order_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.customer_seq IS DISTINCT FROM OLD.customer_seq
  OR NEW.payment_method_type IS DISTINCT FROM OLD.payment_method_type
  OR NEW.pickup_requested_at IS DISTINCT FROM OLD.pickup_requested_at
  OR NEW.version IS DISTINCT FROM OLD.version THEN NEW.version=OLD.version+1; END IF;
 NEW.closed_at=OLD.closed_at;
 IF OLD.closed_at IS NULL AND NEW.status IN ('ACCEPTED','CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
  NEW.closed_at=clock_timestamp();
 END IF;
 NEW.updated_at=clock_timestamp();
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_order_parcel_edit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id integer; parent_status text; expired boolean;
BEGIN
 IF TG_OP='UPDATE' AND NEW.order_seq<>OLD.order_seq THEN
  RAISE EXCEPTION 'Parcel cannot be moved to another order' USING ERRCODE='23514'; END IF;
 parent_id=CASE WHEN TG_OP='DELETE' THEN OLD.order_seq ELSE NEW.order_seq END;
 SELECT status,COALESCE(closed_at,created_at)<=clock_timestamp()-interval '5 years'
 INTO parent_status,expired FROM orders WHERE order_seq=parent_id FOR UPDATE;
 -- The retention worker still locks the parent and verifies the real expiry.
 IF TG_OP='DELETE' AND expired AND current_setting('dva.retention_order',true)=parent_id::text THEN RETURN OLD; END IF;
 IF current_setting('dva.admin_order_edit',true)=parent_id::text THEN
  IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Admin removal must preserve the parcel row' USING ERRCODE='23514';
  ELSIF TG_OP='INSERT' THEN NEW.status=CASE WHEN parent_status='CANCELLED' THEN 'CANCELLED' ELSE 'ACTIVE' END;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
   IF NEW.status<>'CANCELLED' OR (to_jsonb(NEW)-'status')<>(to_jsonb(OLD)-'status') THEN
    RAISE EXCEPTION 'Admin may only cancel a parcel without changing its snapshot' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP IN ('UPDATE','DELETE') AND OLD.status='CANCELLED' THEN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Cancelled parcel snapshot is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
  IF NEW.status='CANCELLED' AND parent_status IN ('COLLECTING','notPaid','CANCELLED')
   AND (to_jsonb(NEW)-'status')=(to_jsonb(OLD)-'status') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Only unpaid parcel cancellation is allowed' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND NEW.status<>'ACTIVE' THEN
  RAISE EXCEPTION 'New parcel must be active' USING ERRCODE='23514'; END IF;
 IF parent_status IS NOT NULL AND parent_status<>'COLLECTING' THEN
  RAISE EXCEPTION 'Finalized parcel snapshot is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;

COMMENT ON COLUMN orders.closed_at IS '최초 접수 완료/취소 시각. 수정·soft delete·재전송으로 연장하지 않는 5년 보관 기준';
COMMENT ON COLUMN orders.created_by_admin_user_seq IS '감사 로그 TTL과 독립적인 생성자 권한의 논리 참조. 근거 없는 과거 값은 NULL';
COMMENT ON COLUMN call_sessions.incoming_at IS '최초 통화 수신 시각. 녹취·STT·분석·AI 이벤트 전체의 5년 보관 기준';
COMMENT ON COLUMN ai_persona_versions.created_by_admin_user_name IS '감사 로그 TTL과 독립적인 작성자 이름 스냅샷. 생성 후 5년이면 제거';
