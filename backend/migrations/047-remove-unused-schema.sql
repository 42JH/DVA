SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE company_pins DROP COLUMN search_text;

ALTER TABLE call_sessions DROP CONSTRAINT call_sessions_check;
ALTER TABLE call_sessions DROP COLUMN end_reason;
ALTER TABLE call_sessions ADD CONSTRAINT call_sessions_check CHECK (
 (started_at IS NULL AND ended_at IS NULL)
 OR (started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at>=started_at));

DROP TABLE handoff_requests;
