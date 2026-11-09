SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE INDEX call_sessions_finalized_customer_idx ON call_sessions
  (customer_seq,COALESCE(incoming_at,started_at,registered_at),call_session_seq)
  WHERE ended_at IS NOT NULL AND order_finalized_at IS NOT NULL;
CREATE INDEX call_sessions_finalized_caller_idx ON call_sessions
  (caller_phone_number,COALESCE(incoming_at,started_at,registered_at),call_session_seq)
  WHERE ended_at IS NOT NULL AND order_finalized_at IS NOT NULL;
