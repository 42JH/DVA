-- ORD-06: persist the submission intent on the existing order before external HTTP.
-- Existing orders, including legacy submitted orders, keep NULL intent fields.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

ALTER TABLE orders
 ADD COLUMN submission_request_id uuid UNIQUE,
 ADD COLUMN submission_expected_version integer,
 ADD COLUMN submission_started_at timestamptz,
 ADD CONSTRAINT order_submission_intent_complete CHECK (
  num_nonnulls(submission_request_id,submission_expected_version,submission_started_at) IN (0,3)),
 ADD CONSTRAINT order_submission_version_positive CHECK (submission_expected_version > 0),
 ADD CONSTRAINT order_submission_intent_state CHECK (submission_request_id IS NULL OR status <> 'COLLECTING');

COMMENT ON COLUMN orders.submission_request_id IS 'Final submission UUID, distinct from creation_request_id. Never replace after sending.';
COMMENT ON COLUMN orders.submission_expected_version IS 'Version confirmed by the caller. Same key with a different version is rejected.';
COMMENT ON COLUMN orders.submission_started_at IS 'Committed intent time; stale SUBMITTING is reviewed without resending.';
