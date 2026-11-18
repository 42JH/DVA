-- Queue customers already deleted so the guarded cascade can run after rollout.
ALTER TABLE customers ADD COLUMN related_deletion_due_at timestamptz;
UPDATE customers SET related_deletion_due_at=transaction_timestamp() WHERE deleted_at IS NOT NULL;
CREATE INDEX customers_related_deletion_due_idx
 ON customers(related_deletion_due_at,customer_seq) WHERE related_deletion_due_at IS NOT NULL;

CREATE INDEX orders_deleted_retention_idx ON orders(deleted_at,order_seq) WHERE deleted_at IS NOT NULL;
CREATE INDEX calls_deleted_retention_idx ON call_sessions(deleted_at,call_session_seq) WHERE deleted_at IS NOT NULL;
CREATE INDEX parcel_drafts_deleted_retention_idx ON order_parcel_drafts(deleted_at,draft_seq) WHERE deleted_at IS NOT NULL;
CREATE INDEX calls_customer_deletion_idx ON call_sessions(customer_seq,call_session_seq)
 WHERE customer_seq IS NOT NULL AND deleted_at IS NULL;

-- The last migrated draft can now be purged while its original order still exists.
ALTER TABLE orders ADD COLUMN migrated_to_parcel_drafts boolean NOT NULL DEFAULT false;
UPDATE orders o SET migrated_to_parcel_drafts=true
 WHERE EXISTS(SELECT 1 FROM order_parcel_drafts d WHERE d.legacy_order_seq=o.order_seq);

CREATE OR REPLACE FUNCTION guard_order_parcel_edit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id integer; parent_status text; expired boolean;
BEGIN
 IF TG_OP='UPDATE' AND NEW.order_seq<>OLD.order_seq THEN
  RAISE EXCEPTION 'Parcel cannot be moved to another order' USING ERRCODE='23514'; END IF;
 parent_id=CASE WHEN TG_OP='DELETE' THEN OLD.order_seq ELSE NEW.order_seq END;
 SELECT status,COALESCE(deleted_at<=statement_timestamp()-interval '5 years',false)
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

COMMENT ON COLUMN orders.closed_at IS 'First reception or cancellation timestamp.';
COMMENT ON COLUMN call_sessions.incoming_at IS 'First incoming event timestamp.';
