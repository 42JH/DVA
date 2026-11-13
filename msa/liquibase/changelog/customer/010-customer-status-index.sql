SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE INDEX customers_status_seq_idx ON public.customers(status, customer_seq DESC) WHERE deleted_at IS NULL;
