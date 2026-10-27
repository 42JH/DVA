-- S15P31D109-34: durable customer registration receipts; MVP keys are API-wide.
-- Apply with the existing runner. Previously applied migrations remain unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

CREATE SCHEMA IF NOT EXISTS api_idempotency;
CREATE TABLE api_idempotency.customer_creations (
 idempotency_key uuid PRIMARY KEY,
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 customer_seq integer NOT NULL REFERENCES public.customers(customer_seq),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
