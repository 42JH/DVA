SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE INDEX outbox_pending_order_idx ON public.outbox_events(outbox_seq) WHERE delivered_at IS NULL;
