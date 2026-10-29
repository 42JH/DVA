-- Preserve parcel prices independently of the remaining payable order amount.
DO $$
DECLARE constraint_name text;
BEGIN
 SELECT conname INTO STRICT constraint_name FROM pg_constraint
 WHERE conrelid='order_parcels'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%notified_price%';
 EXECUTE format('ALTER TABLE order_parcels DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE order_parcels ALTER COLUMN notified_price DROP DEFAULT;
ALTER TABLE order_parcels ALTER COLUMN notified_price DROP NOT NULL;
ALTER TABLE order_parcels ADD CONSTRAINT order_parcels_delivery_fee_check
 CHECK (notified_price>0);
ALTER TABLE orders ADD COLUMN total_amount integer CHECK (total_amount>=0);

-- AI and scheduled changes must remain distinguishable in shipment history too.
DO $$
DECLARE constraint_name text;
BEGIN
 FOR constraint_name IN SELECT conname FROM pg_constraint
 WHERE conrelid='shipment_status_history'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%actor_type%'
 LOOP
  EXECUTE format('ALTER TABLE shipment_status_history DROP CONSTRAINT %I',constraint_name);
 END LOOP;
END $$;
ALTER TABLE shipment_status_history ADD CONSTRAINT shipment_history_actor_type_check
 CHECK (actor_type IN ('ADMIN','AI','SYSTEM'));
ALTER TABLE shipment_status_history ADD CONSTRAINT shipment_history_actor_identity_check
 CHECK ((actor_type='ADMIN' AND actor_admin_user_seq IS NOT NULL AND actor_admin_user_seq>0)
  OR (actor_type IN ('AI','SYSTEM') AND actor_admin_user_seq IS NULL));
