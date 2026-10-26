-- S15P31D109-35: durable, per-administrator organization creation idempotency.
-- Apply with infra/database/migrate.sh; keep previously applied migrations unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

CREATE SCHEMA IF NOT EXISTS api_idempotency;

CREATE TABLE api_idempotency.organization_creations (
 admin_user_seq integer NOT NULL REFERENCES public.admin_users(admin_user_seq),
 idempotency_key uuid NOT NULL,
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 organization_seq integer NOT NULL REFERENCES public.organizations(organization_seq),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (admin_user_seq, idempotency_key)
);
