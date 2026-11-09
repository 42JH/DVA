-- Source 016 actor identity; preserve shipments/history and all event IDs/payloads.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public,pg_catalog;
LOCK TABLE shipments,shipment_status_history IN ACCESS EXCLUSIVE MODE;
DO $$ DECLARE constraint_name text; BEGIN
 FOR constraint_name IN SELECT conname FROM pg_constraint
  WHERE conrelid='shipment_status_history'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%actor_type%' LOOP
  EXECUTE format('ALTER TABLE shipment_status_history DROP CONSTRAINT %I',constraint_name);
 END LOOP;
END $$;
ALTER TABLE shipment_status_history ADD CONSTRAINT shipment_history_actor_type_check
 CHECK (actor_type IN ('ADMIN','AI','SYSTEM'));
ALTER TABLE shipment_status_history ADD CONSTRAINT shipment_history_actor_identity_check
 CHECK ((actor_type='ADMIN' AND actor_admin_user_seq IS NOT NULL AND actor_admin_user_seq>0)
  OR (actor_type IN ('AI','SYSTEM') AND actor_admin_user_seq IS NULL));
COMMENT ON COLUMN shipments.order_parcel_seq IS 'order 서비스 주문 상세 논리 참조';
COMMENT ON COLUMN shipment_status_history.actor_admin_user_seq IS '관리자 논리 참조. 작업자 이름은 감사 로그에 보존';

-- Source now creates paid shipments in the verified order workflow, not a SQL
-- notPaid receiver or unrestricted admin transition. Neither is routed by this app.
DROP FUNCTION receive_accepted_order(uuid,jsonb);
DROP FUNCTION create_shipment(integer,uuid);
DROP FUNCTION change_shipment_status(integer,integer,text,uuid,integer);
