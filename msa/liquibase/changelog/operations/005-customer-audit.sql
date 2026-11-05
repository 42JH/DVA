-- Prepared audit rows are private until the owning customer transaction commits.
CREATE TABLE customer_audit_preparations (
 event_id uuid PRIMARY KEY,
 transaction_id uuid NOT NULL,
 audit jsonb,
 aborted boolean NOT NULL DEFAULT false,
 prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((aborted AND audit IS NULL) OR (NOT aborted AND jsonb_typeof(audit)='object' AND audit IS NOT NULL))
);
CREATE INDEX customer_audit_pending_idx ON customer_audit_preparations(prepared_at) WHERE NOT aborted;
CREATE INDEX customer_audit_transaction_idx ON customer_audit_preparations(transaction_id) WHERE NOT aborted;
