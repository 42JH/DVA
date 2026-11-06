-- backend migrations 008/012/014/016/018/019/021/022/023/032/037/038/043/045/046/051.
-- Stop old writers and back up before removing retired coordinates/workflow functions.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public,pg_catalog;
LOCK TABLE orders,order_parcels IN ACCESS EXCLUSIVE MODE;

-- As in source 018, an old receipt is not evidence of payment.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM orders WHERE status NOT IN ('COLLECTING','CANCELLED')) THEN
  RAISE EXCEPTION 'Reconcile legacy submitted orders before enabling the payment-first workflow';
 END IF;
END $$;

DROP TRIGGER order_header_guard ON orders;
DROP TRIGGER accepted_order_event ON orders;
DROP TRIGGER parcel_edit_guard ON order_parcels;
DROP TRIGGER parcel_content_version ON order_parcels;
DROP FUNCTION guard_order_header();
DROP FUNCTION guard_order_detail();
DROP FUNCTION touch_order_content();
DROP FUNCTION publish_accepted_order();
DROP FUNCTION prepare_submission(integer,integer);
DROP FUNCTION finish_submission(integer,integer,jsonb);
DROP FUNCTION parcel_request(integer);
DROP FUNCTION check_order_contents(integer);
DROP FUNCTION parcel_address(order_parcels,text);
DROP FUNCTION cancel_order(integer,integer);
DROP FUNCTION flag_stale_submissions(timestamptz);

ALTER TABLE orders
 ADD COLUMN creation_request_id uuid UNIQUE,
 ADD COLUMN creation_source text NOT NULL DEFAULT 'UNKNOWN' CHECK (creation_source IN ('AI','ADMIN','UNKNOWN')),
 ADD COLUMN total_amount integer CHECK (total_amount>=0),
 ADD COLUMN payment_due_at timestamptz,
 ADD COLUMN paid_at timestamptz,
 ADD COLUMN billing_organization_seq integer,
 ADD COLUMN billing_department_seq integer,
 ADD COLUMN billing_organization_name text,
 ADD COLUMN billing_department_name text,
 ADD COLUMN deleted_at timestamptz,
 ADD COLUMN closed_at timestamptz,
 ADD COLUMN created_by_admin_user_seq integer,
 ADD COLUMN submission_first_attempt_at timestamptz,
 ADD COLUMN submission_last_attempt_at timestamptz,
 ALTER COLUMN payment_method_type DROP DEFAULT,
 ALTER COLUMN payment_method_type DROP NOT NULL,
 DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
 'COLLECTING','notPaid','PAID','SUBMITTING','SUBMITTING_FAILED','ACCEPTED','SUBMISSION_FAILED','CANCELLED'));
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_required_check
 CHECK (payment_method_type IS NOT NULL OR status IN ('COLLECTING','CANCELLED'));
ALTER TABLE orders ADD CONSTRAINT orders_billing_department_identity_check
 CHECK (billing_department_seq IS NULL OR billing_organization_seq IS NOT NULL);
DO $$ DECLARE constraint_name text; BEGIN
 SELECT conname INTO STRICT constraint_name FROM pg_constraint
 WHERE conrelid='orders'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%parcel_no%' AND pg_get_constraintdef(oid) LIKE '%dver_received_at%';
 EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE orders ADD CONSTRAINT orders_receipt_status_check CHECK (
 (status='ACCEPTED' AND parcel_no IS NOT NULL AND dver_received_at IS NOT NULL)
 OR (status='CANCELLED' AND ((parcel_no IS NULL AND dver_received_at IS NULL)
   OR (parcel_no IS NOT NULL AND dver_received_at IS NOT NULL)))
 OR (status NOT IN ('ACCEPTED','CANCELLED') AND parcel_no IS NULL AND dver_received_at IS NULL));

-- 001/002 has no cancellation audit or payment/creation identity. Use source 045's
-- created_at fallback; leave unproven creator, billing, payment and request fields NULL.
UPDATE orders SET closed_at=created_at WHERE status='CANCELLED';
ALTER TABLE order_parcels ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED'));
UPDATE order_parcels SET status='CANCELLED' WHERE order_seq IN (SELECT order_seq FROM orders WHERE status='CANCELLED');
ALTER TABLE order_parcels
 DROP CONSTRAINT order_parcels_notified_price_check,
 ALTER COLUMN notified_price DROP DEFAULT,
 ALTER COLUMN notified_price DROP NOT NULL,
 ADD CONSTRAINT order_parcels_delivery_fee_check CHECK (notified_price>0),
 DROP COLUMN origin_latitude,
 DROP COLUMN origin_longitude,
 DROP COLUMN destination_latitude,
 DROP COLUMN destination_longitude;

CREATE TABLE order_payment_requests (
 payment_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_seq integer NOT NULL REFERENCES orders(order_seq),
 amount integer NOT NULL CHECK (amount>0),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 approval_started_at timestamptz,
 invalidated_at timestamptz,
 completed_at timestamptz,
 provider_reference text UNIQUE CHECK (length(provider_reference) BETWEEN 1 AND 200),
 provider_payment_key text UNIQUE CHECK (length(provider_payment_key) BETWEEN 1 AND 200),
 provider_approved_at timestamptz,
 approval_claim_id uuid,
 approval_claimed_until timestamptz,
 notification_status text NOT NULL DEFAULT 'PENDING'
  CHECK (notification_status IN ('PENDING','SENDING','SENT','FAILED','UNKNOWN')),
 notification_attempted_at timestamptz,
 notification_sent_at timestamptz,
 completion_notification_status text NOT NULL DEFAULT 'WAITING'
  CHECK (completion_notification_status IN ('WAITING','PENDING','SENDING','SENT','FAILED','UNKNOWN')),
 completion_notification_attempted_at timestamptz,
 completion_notification_sent_at timestamptz,
 approval_next_check_at timestamptz,
 CHECK (completed_at IS NULL OR (invalidated_at IS NULL AND provider_reference IS NOT NULL)),
 CHECK (provider_reference IS NULL OR completed_at IS NOT NULL),
 CONSTRAINT payment_approval_claim_pair CHECK ((approval_claim_id IS NULL)=(approval_claimed_until IS NULL))
);
CREATE UNIQUE INDEX one_active_order_payment_request ON order_payment_requests(order_seq)
 WHERE invalidated_at IS NULL AND completed_at IS NULL;
CREATE INDEX order_payment_notification_pending_idx ON order_payment_requests(created_at)
 WHERE notification_status='PENDING' AND invalidated_at IS NULL AND completed_at IS NULL;
CREATE INDEX order_payment_completion_pending_idx ON order_payment_requests(completed_at)
 WHERE completion_notification_status IN ('WAITING','PENDING') AND completed_at IS NOT NULL;
CREATE INDEX order_payment_reconcile_idx ON order_payment_requests
 ((COALESCE(approval_next_check_at,approval_started_at)),payment_request_id)
 WHERE provider_payment_key IS NOT NULL AND approval_started_at IS NOT NULL
  AND completed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE organization_billing_months (
 organization_seq integer NOT NULL,
 billing_month date NOT NULL CHECK (extract(day FROM billing_month)=1),
 monthly_amount bigint NOT NULL DEFAULT 0 CHECK (monthly_amount BETWEEN 0 AND 9007199254740991),
 group_billing_amount bigint NOT NULL DEFAULT 0 CHECK (group_billing_amount BETWEEN 0 AND 9007199254740991),
 organization_name text,
 PRIMARY KEY (organization_seq,billing_month)
);
CREATE TABLE order_billing_charges (
 order_seq integer PRIMARY KEY REFERENCES orders(order_seq),
 organization_seq integer NOT NULL,
 billing_month date NOT NULL CHECK (extract(day FROM billing_month)=1),
 payment_method_type text NOT NULL CHECK (payment_method_type IN ('credit','groupBilling')),
 amount integer NOT NULL CHECK (amount>0),
 occurred_at timestamptz NOT NULL
);
CREATE INDEX billing_charge_month_idx ON order_billing_charges(organization_seq,billing_month);
CREATE TABLE empty_ai_order_results (
 request_id uuid PRIMARY KEY,
 call_session_seq integer NOT NULL UNIQUE,
 actor_admin_user_seq integer,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pending_orders_expiry_idx ON orders(payment_due_at) WHERE status='notPaid';
CREATE INDEX orders_customer_created_list_idx ON orders(customer_seq,created_at DESC,order_seq DESC);
CREATE INDEX orders_retention_idx ON orders((COALESCE(closed_at,created_at)),order_seq);
CREATE INDEX orders_submission_retry_idx ON orders(submission_last_attempt_at,order_seq)
 WHERE deleted_at IS NULL AND status IN ('PAID','SUBMITTING','SUBMITTING_FAILED');

COMMENT ON COLUMN orders.customer_seq IS 'customer 서비스 고객 논리 참조. 다른 서비스 테이블을 복제하지 않음';
COMMENT ON COLUMN orders.billing_organization_seq IS '결제 당시 기업 번호. 기업 삭제 후에도 보존하는 논리 참조';
COMMENT ON COLUMN orders.billing_department_seq IS '결제 당시 부서 번호. 부서 삭제 후에도 보존하는 논리 참조';
COMMENT ON COLUMN orders.billing_organization_name IS '결제 당시 기업명. 근거 없는 과거 값은 NULL';
COMMENT ON COLUMN orders.billing_department_name IS '결제 당시 부서명. 근거 없는 과거 값은 NULL';
COMMENT ON COLUMN orders.closed_at IS '최초 접수 완료/취소 시각. 수정·soft delete·재전송으로 연장하지 않는 5년 보관 기준';
COMMENT ON COLUMN orders.created_by_admin_user_seq IS '감사 로그 TTL과 독립적인 생성자 권한의 논리 참조. 근거 없는 과거 값은 NULL';
COMMENT ON COLUMN organization_billing_months.organization_seq IS '기업 청구 이력의 논리 참조. 기업 삭제 후에도 보존';
COMMENT ON COLUMN order_billing_charges.organization_seq IS '기업 청구 이력의 논리 참조. 기업 삭제 후에도 보존';
COMMENT ON COLUMN empty_ai_order_results.call_session_seq IS 'consultation 서비스 통화 논리 참조';
COMMENT ON COLUMN empty_ai_order_results.actor_admin_user_seq IS 'operations 서비스 관리자 논리 참조';
COMMENT ON COLUMN order_payment_requests.provider_payment_key IS '토스 승인 전 저장. 응답 유실·재기동 시 조회로 결과 확인';
COMMENT ON COLUMN order_payment_requests.notification_status IS '결제 안내 발송 결과. UNKNOWN은 자동 재발송하지 않음';
COMMENT ON COLUMN order_payment_requests.completion_notification_status IS '결제 완료 안내 발송 상태. WAITING은 미결제, UNKNOWN은 자동 재발송하지 않음';
COMMENT ON COLUMN order_payment_requests.approval_next_check_at IS '자동 승인 조회의 다음 선택 시각. NULL은 즉시 조회하며 기존 결제 키·승인 기록은 보존';

CREATE OR REPLACE FUNCTION public.cancel_order_parcels()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 UPDATE order_parcels SET status='CANCELLED' WHERE order_seq=NEW.order_seq AND status='ACTIVE';
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.guard_order_parcel_edit()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$;

CREATE OR REPLACE FUNCTION public.touch_order_header()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$;

CREATE OR REPLACE FUNCTION public.touch_order_parcel_parent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE parent_id integer;
BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 parent_id=CASE WHEN TG_OP='DELETE' THEN OLD.order_seq ELSE NEW.order_seq END;
 UPDATE orders SET version=version+1 WHERE order_seq=parent_id;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.valid_parcel_address(value jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
END $function$;

CREATE TRIGGER order_cancel_parcels AFTER UPDATE OF status ON public.orders FOR EACH ROW WHEN (((new.status = 'CANCELLED'::text) AND (old.status IS DISTINCT FROM new.status))) EXECUTE FUNCTION cancel_order_parcels();
CREATE TRIGGER order_header_timestamp BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION touch_order_header();
CREATE TRIGGER order_parcel_edit_guard BEFORE INSERT OR DELETE OR UPDATE ON public.order_parcels FOR EACH ROW EXECUTE FUNCTION guard_order_parcel_edit();
CREATE TRIGGER order_parcel_parent_version AFTER INSERT OR DELETE OR UPDATE ON public.order_parcels FOR EACH ROW EXECUTE FUNCTION touch_order_parcel_parent();
