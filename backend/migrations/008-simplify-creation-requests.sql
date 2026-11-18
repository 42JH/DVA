-- Preserve applied migrations; move order creation identity into the business row.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

ALTER TABLE orders ADD COLUMN creation_request_id uuid;

-- Previously keys were scoped by actor. Never silently reassign an ambiguous old key.
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM api_idempotency.order_creations GROUP BY idempotency_key HAVING count(*)>1)
  OR EXISTS(SELECT 1 FROM api_idempotency.order_creations GROUP BY order_seq HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Ambiguous legacy order creation keys: resolve before migration';
 END IF;
END $$;

-- This bookkeeping move must not change the order version or its business timestamp.
ALTER TABLE orders DISABLE TRIGGER order_header_timestamp;
UPDATE orders o SET creation_request_id=r.idempotency_key
FROM api_idempotency.order_creations r WHERE r.order_seq=o.order_seq;
ALTER TABLE orders ENABLE TRIGGER order_header_timestamp;
ALTER TABLE orders ADD CONSTRAINT orders_creation_request_id_key UNIQUE (creation_request_id);

DROP TABLE api_idempotency.order_creations;
DROP TABLE api_idempotency.customer_creations;
DROP TABLE api_idempotency.organization_creations;
DROP SCHEMA api_idempotency;
