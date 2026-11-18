-- The customer service owns customers; historical references cannot be inferred here.
ALTER TABLE call_sessions ADD COLUMN customer_seq integer CHECK (customer_seq > 0);
CREATE INDEX calls_customer_idx ON call_sessions(customer_seq,call_session_seq)
 WHERE customer_seq IS NOT NULL;
