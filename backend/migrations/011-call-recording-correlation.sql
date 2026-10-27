-- OpenAI 이벤트 시각과 PBX 실제 통화 시각은 별도로 보관한다.
ALTER TABLE call_sessions ADD COLUMN incoming_at timestamptz;
CREATE INDEX call_sessions_caller_incoming_idx
  ON call_sessions(caller_phone_number, incoming_at) WHERE incoming_at IS NOT NULL;

-- 기존 수신함을 재사용한다. S3 재시도 중에도 처음 결정한 통화 연결을 유지한다.
ALTER TABLE pbx_webhooks.call_ended_events
  ADD COLUMN call_session_seq integer REFERENCES call_sessions(call_session_seq),
  ADD COLUMN last_attempt_at timestamptz;
CREATE INDEX call_ended_retry_idx
  ON pbx_webhooks.call_ended_events(last_attempt_at NULLS FIRST, received_at)
  WHERE processing_status <> 'PROCESSED';
