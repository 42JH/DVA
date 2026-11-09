-- The verified admin API sets this order-scoped flag only for its transaction.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE OR REPLACE FUNCTION guard_order_parcel_edit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id integer; parent_status text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.order_seq<>OLD.order_seq THEN
  RAISE EXCEPTION 'Parcel cannot be moved to another order' USING ERRCODE='23514'; END IF;
 parent_id=CASE WHEN TG_OP='DELETE' THEN OLD.order_seq ELSE NEW.order_seq END;
 SELECT status INTO parent_status FROM orders WHERE order_seq=parent_id FOR UPDATE;
 IF current_setting('dva.admin_order_edit',true)=parent_id::text THEN
  IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Admin removal must preserve the parcel row' USING ERRCODE='23514';
  ELSIF TG_OP='INSERT' THEN
   NEW.status=CASE WHEN parent_status='CANCELLED' THEN 'CANCELLED' ELSE 'ACTIVE' END;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
   IF NEW.status<>'CANCELLED' OR (to_jsonb(NEW)-'status')<>(to_jsonb(OLD)-'status') THEN
    RAISE EXCEPTION 'Admin may only cancel a parcel without changing its snapshot' USING ERRCODE='23514';
   END IF;
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
