-- Legacy accepted/unresolved orders do not prove payment. Never infer a charge.
DO $$
DECLARE constraint_name text;
BEGIN
 IF EXISTS(SELECT 1 FROM orders WHERE status NOT IN ('COLLECTING','CANCELLED')) THEN
  RAISE EXCEPTION 'Reconcile legacy submitted orders before enabling the payment-first workflow';
 END IF;
 SELECT conname INTO STRICT constraint_name FROM pg_constraint
 WHERE conrelid='orders'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%COLLECTING%';
 EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
 CHECK (status IN ('COLLECTING','notPaid','PAID','SUBMITTING','ACCEPTED','SUBMISSION_FAILED','CANCELLED'));
ALTER TABLE orders ALTER COLUMN payment_method_type SET DEFAULT 'billing';
ALTER TABLE orders ADD COLUMN payment_due_at timestamptz;
ALTER TABLE orders ADD COLUMN paid_at timestamptz;
ALTER TABLE orders ADD COLUMN billing_organization_seq integer REFERENCES organizations(organization_seq);
ALTER TABLE orders ADD COLUMN billing_department_seq integer;
ALTER TABLE orders ADD CONSTRAINT orders_billing_department_fk
 FOREIGN KEY (billing_department_seq,billing_organization_seq) REFERENCES departments(department_seq,organization_seq);
ALTER TABLE orders ADD CONSTRAINT orders_billing_department_identity_check
 CHECK (billing_department_seq IS NULL OR billing_organization_seq IS NOT NULL);

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
 CHECK (completed_at IS NULL OR (invalidated_at IS NULL AND provider_reference IS NOT NULL)),
 CHECK (provider_reference IS NULL OR completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX one_active_order_payment_request ON order_payment_requests(order_seq)
 WHERE invalidated_at IS NULL AND completed_at IS NULL;
CREATE INDEX pending_orders_expiry_idx ON orders(payment_due_at) WHERE status='notPaid';

CREATE OR REPLACE FUNCTION guard_order_parcel_edit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id integer; parent_status text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.order_seq<>OLD.order_seq THEN
  RAISE EXCEPTION 'Parcel cannot be moved to another order' USING ERRCODE='23514'; END IF;
 parent_id=CASE WHEN TG_OP='DELETE' THEN OLD.order_seq ELSE NEW.order_seq END;
 SELECT status INTO parent_status FROM orders WHERE order_seq=parent_id FOR UPDATE;
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
