-- S15P31D109-37: shared per-admin idempotency keys for membership registration/import.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

-- 008 removes the old creation receipt schema; membership receipts are created afterwards.
CREATE SCHEMA IF NOT EXISTS api_idempotency;
CREATE TABLE api_idempotency.membership_writes (
 admin_user_seq integer NOT NULL REFERENCES public.admin_users(admin_user_seq),
 idempotency_key uuid NOT NULL,
 organization_seq integer NOT NULL REFERENCES public.organizations(organization_seq),
 operation text NOT NULL CHECK (operation IN ('CREATE','IMPORT')),
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (admin_user_seq, idempotency_key)
);
