-- 과거의 종료 미확인 통화를 활성 통화로 추정하지 않는다.
ALTER TABLE call_sessions ADD COLUMN registered_at timestamptz;
ALTER TABLE call_sessions ALTER COLUMN registered_at SET DEFAULT clock_timestamp();

CREATE INDEX call_sessions_active_count_idx ON call_sessions(call_session_seq)
  WHERE registered_at IS NOT NULL AND ended_at IS NULL;
CREATE INDEX call_ended_unlinked_identity_idx
  ON pbx_webhooks.call_ended_events((payload->>'callFrom'),(payload->>'startedAt'))
  WHERE call_session_seq IS NULL AND processing_status<>'PROCESSED';
