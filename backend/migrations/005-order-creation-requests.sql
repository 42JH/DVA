-- S15P31D109-55: 관리자 미완료 주문 생성의 중복 방지와 최초 응답 보존.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

CREATE TABLE api_idempotency.order_creations (
 admin_user_seq integer NOT NULL REFERENCES public.admin_users(admin_user_seq),
 idempotency_key uuid NOT NULL,
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 order_seq integer NOT NULL REFERENCES public.orders(order_seq),
 response_version integer NOT NULL CHECK (response_version > 0),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (admin_user_seq, idempotency_key)
);
