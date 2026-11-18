-- Keep order preparations separate from other service transactions.
CREATE TABLE order_audit_preparations (
 event_id uuid PRIMARY KEY,
 transaction_id uuid NOT NULL,
 audit jsonb,
 aborted boolean NOT NULL DEFAULT false,
 prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((aborted AND audit IS NULL) OR (NOT aborted AND jsonb_typeof(audit)='object' AND audit IS NOT NULL))
);
CREATE INDEX order_audit_pending_idx ON order_audit_preparations(prepared_at) WHERE NOT aborted;
CREATE INDEX order_audit_transaction_idx ON order_audit_preparations(transaction_id) WHERE NOT aborted;
