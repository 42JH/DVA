SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Complete source 045/047 call storage before comparing complete 055 call snapshots.
ALTER TABLE call_sessions
 ADD COLUMN purge_claim_id uuid,
 ADD COLUMN purge_claimed_until timestamptz,
 ADD CONSTRAINT call_purge_claim_pair CHECK ((purge_claim_id IS NULL)=(purge_claimed_until IS NULL));
ALTER TABLE call_sessions DROP CONSTRAINT call_sessions_check;
ALTER TABLE call_sessions DROP COLUMN end_reason;
ALTER TABLE call_sessions ADD CONSTRAINT call_sessions_check CHECK (
 (started_at IS NULL AND ended_at IS NULL)
 OR (started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at>=started_at));

ALTER TABLE call_sessions
 ADD COLUMN order_intake_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN order_intake_version integer NOT NULL DEFAULT 1 CHECK (order_intake_version>0),
 ADD COLUMN order_completion_received_at timestamptz,
 ADD COLUMN order_completion_payload jsonb,
 ADD COLUMN order_finalized_at timestamptz,
 ADD COLUMN order_finalization_result jsonb,
 ADD COLUMN order_finalization_error_code text,
 ADD COLUMN order_finalization_attempted_at timestamptz,
 ADD CONSTRAINT call_order_completion_check CHECK ((order_completion_received_at IS NULL)=(order_completion_payload IS NULL)
  AND (order_completion_payload IS NULL OR jsonb_typeof(order_completion_payload)='object')),
 ADD CONSTRAINT call_order_finalization_check CHECK ((order_finalized_at IS NULL)=(order_finalization_result IS NULL)
  AND (order_finalization_result IS NULL OR (order_completion_received_at IS NOT NULL AND ended_at IS NOT NULL AND jsonb_typeof(order_finalization_result)='object')));
ALTER TABLE call_sessions ALTER COLUMN order_intake_enabled SET DEFAULT true;
CREATE INDEX call_order_finalization_idx ON call_sessions(order_finalization_attempted_at NULLS FIRST,call_session_seq)
 WHERE order_intake_enabled AND order_completion_received_at IS NOT NULL AND order_finalized_at IS NULL AND deleted_at IS NULL;

-- Capture before post-upgrade call deletion/retention can change historical cardinality.
CREATE TABLE legacy_parcel_draft_call_snapshots (
 legacy_order_seq integer PRIMARY KEY,
 call_session_seq integer,
 caller_phone_number text
);
CREATE TABLE parcel_draft_call_snapshot_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 pruned boolean NOT NULL DEFAULT false
);
INSERT INTO parcel_draft_call_snapshot_state DEFAULT VALUES;
INSERT INTO legacy_parcel_draft_call_snapshots(legacy_order_seq,call_session_seq,caller_phone_number)
 SELECT order_seq,CASE WHEN count(*)=1 THEN min(call_session_seq) END,
 CASE WHEN count(*)=1 THEN min(caller_phone_number) END
 FROM call_sessions WHERE order_seq IS NOT NULL GROUP BY order_seq;
COMMENT ON COLUMN call_sessions.order_intake_enabled IS '055 이전 통화 false, 이후 등록 true. 신규 AI는 초안·완료 신호 계약 사용';
