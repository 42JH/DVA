-- Existing service event tables are preserved; customer joins the same transport contract.
CREATE TABLE IF NOT EXISTS outbox_events (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 destination text NOT NULL CHECK (btrim(destination)<>''),
 event_type text NOT NULL CHECK (btrim(event_type)<>''),
 aggregate_seq integer NOT NULL,
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 delivered_at timestamptz
);
CREATE TABLE IF NOT EXISTS inbox_events (
 event_id uuid PRIMARY KEY,
 source text NOT NULL CHECK (btrim(source)<>''),
 event_type text NOT NULL CHECK (btrim(event_type)<>''),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 processed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE outbox_events
 ADD COLUMN outbox_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
 ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ADD COLUMN last_http_status integer CHECK (last_http_status BETWEEN 100 AND 599);
CREATE INDEX outbox_retry_idx ON outbox_events(next_attempt_at,outbox_seq) WHERE delivered_at IS NULL;
CREATE INDEX outbox_aggregate_pending_idx ON outbox_events(destination,aggregate_seq,outbox_seq) WHERE delivered_at IS NULL;
