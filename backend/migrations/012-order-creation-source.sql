-- S15P31D109-69: distinguish AI orders from administrator manual orders.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

-- Historical rows have no reliable source marker. Do not infer it from missing calls.
ALTER TABLE orders ADD COLUMN creation_source text NOT NULL DEFAULT 'UNKNOWN'
  CONSTRAINT orders_creation_source_check CHECK (creation_source IN ('AI','ADMIN','UNKNOWN'));
