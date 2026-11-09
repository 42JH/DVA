-- Additive receipt storage for the monolith, independent of msa/liquibase.
-- Keep original download URLs here; recordings.object_key is reserved for stored audio.
CREATE SCHEMA IF NOT EXISTS pbx_webhooks;
CREATE TABLE IF NOT EXISTS pbx_webhooks.call_ended_events (
    recording_id varchar(200) PRIMARY KEY,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processing_status text NOT NULL DEFAULT 'RECEIVED'
        CHECK (processing_status IN ('RECEIVED', 'PROCESSED', 'FAILED'))
);
CREATE INDEX IF NOT EXISTS call_ended_pending_idx
    ON pbx_webhooks.call_ended_events (received_at)
    WHERE processing_status = 'RECEIVED';
