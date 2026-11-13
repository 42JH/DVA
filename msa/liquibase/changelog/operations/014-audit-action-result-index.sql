SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE INDEX audit_logs_action_result_order_idx ON public.audit_logs(action, result, occurred_at DESC, audit_log_seq DESC);
