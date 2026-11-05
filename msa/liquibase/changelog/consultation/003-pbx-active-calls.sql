SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE SCHEMA pbx_webhooks;
CREATE TABLE pbx_webhooks.call_ended_events (
 recording_id varchar(200) PRIMARY KEY,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 processing_status text NOT NULL DEFAULT 'RECEIVED' CHECK(processing_status IN ('RECEIVED','PROCESSED','FAILED')),
 call_session_seq integer REFERENCES call_sessions(call_session_seq),
 last_attempt_at timestamptz,
 claim_id uuid,
 claimed_until timestamptz,
 CONSTRAINT call_ended_claim_pair_check CHECK((claim_id IS NULL)=(claimed_until IS NULL))
);
CREATE INDEX call_ended_pending_idx ON pbx_webhooks.call_ended_events(received_at) WHERE processing_status='RECEIVED';
CREATE INDEX call_ended_retry_idx ON pbx_webhooks.call_ended_events(last_attempt_at NULLS FIRST,received_at) WHERE processing_status<>'PROCESSED';
CREATE INDEX call_ended_unlinked_identity_idx ON pbx_webhooks.call_ended_events((payload->>'callFrom'),(payload->>'startedAt')) WHERE call_session_seq IS NULL AND processing_status<>'PROCESSED';

ALTER TABLE call_sessions ADD COLUMN incoming_at timestamptz, ADD COLUMN registered_at timestamptz, ADD COLUMN deleted_at timestamptz;
-- Original PBX times prove arrival; legacy registration time remains unknown (monolith 044/045).
UPDATE call_sessions SET incoming_at=started_at WHERE started_at IS NOT NULL;
ALTER TABLE call_sessions ALTER COLUMN registered_at SET DEFAULT clock_timestamp();
CREATE INDEX call_sessions_caller_incoming_idx ON call_sessions(caller_phone_number,incoming_at) WHERE incoming_at IS NOT NULL;
CREATE INDEX call_sessions_active_count_idx ON call_sessions(call_session_seq) WHERE registered_at IS NOT NULL AND ended_at IS NULL;
CREATE INDEX call_ended_call_idx ON pbx_webhooks.call_ended_events(call_session_seq);
CREATE INDEX call_sessions_retention_idx ON call_sessions(incoming_at,call_session_seq);
