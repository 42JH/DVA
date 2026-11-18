-- Preserve submitted snapshots/receipts while recording parcel cancellation.
LOCK TABLE orders, order_parcels IN ACCESS EXCLUSIVE MODE;

ALTER TABLE order_parcels ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE'
 CHECK (status IN ('ACTIVE','CANCELLED'));

-- Backfill without rewriting historical parent versions or timestamps.
ALTER TABLE order_parcels DISABLE TRIGGER order_parcel_edit_guard;
ALTER TABLE order_parcels DISABLE TRIGGER order_parcel_parent_version;
UPDATE order_parcels p SET status='CANCELLED'
 FROM orders o WHERE o.order_seq=p.order_seq AND o.status='CANCELLED';
ALTER TABLE order_parcels ENABLE TRIGGER order_parcel_edit_guard;
ALTER TABLE order_parcels ENABLE TRIGGER order_parcel_parent_version;

DO $$
DECLARE receipt_constraint text;
BEGIN
 SELECT conname INTO STRICT receipt_constraint FROM pg_constraint
 WHERE conrelid='orders'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%parcel_no%'
  AND pg_get_constraintdef(oid) LIKE '%dver_received_at%';
 EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I',receipt_constraint);
END $$;
ALTER TABLE orders ADD CONSTRAINT orders_receipt_status_check CHECK (
 (status='ACCEPTED' AND parcel_no IS NOT NULL AND dver_received_at IS NOT NULL)
 OR (status='CANCELLED' AND ((parcel_no IS NULL AND dver_received_at IS NULL)
  OR (parcel_no IS NOT NULL AND dver_received_at IS NOT NULL)))
 OR (status NOT IN ('ACCEPTED','CANCELLED') AND parcel_no IS NULL AND dver_received_at IS NULL)
);

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
  IF NEW.status='CANCELLED' AND parent_status IN ('COLLECTING','ACCEPTED','CANCELLED')
   AND (to_jsonb(NEW)-'status')=(to_jsonb(OLD)-'status') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Only cancellation may change parcel status' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND NEW.status<>'ACTIVE' THEN
  RAISE EXCEPTION 'New parcel must be active' USING ERRCODE='23514'; END IF;
 IF parent_status IS NOT NULL AND parent_status<>'COLLECTING' THEN
  RAISE EXCEPTION 'Submitted parcel snapshot is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;

-- Also cover the existing AI consultation outcome=CANCELLED path.
CREATE FUNCTION cancel_order_parcels() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE order_parcels SET status='CANCELLED' WHERE order_seq=NEW.order_seq AND status='ACTIVE';
 RETURN NEW;
END $$;
CREATE TRIGGER order_cancel_parcels AFTER UPDATE OF status ON orders
 FOR EACH ROW WHEN (NEW.status='CANCELLED' AND OLD.status IS DISTINCT FROM NEW.status)
 EXECUTE FUNCTION cancel_order_parcels();
