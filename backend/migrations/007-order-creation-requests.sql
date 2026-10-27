-- S15P31D109-55: same order creation contract for AI calls and administrator sessions.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

CREATE TABLE api_idempotency.order_creations (
 actor_key text NOT NULL CHECK (actor_key ~ '^(admin|call):[1-9][0-9]*$'),
 idempotency_key uuid NOT NULL,
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 order_seq integer NOT NULL REFERENCES public.orders(order_seq),
 response_version integer NOT NULL CHECK (response_version > 0),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (actor_key, idempotency_key)
);
