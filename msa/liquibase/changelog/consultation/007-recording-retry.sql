SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE pbx_webhooks.call_ended_events
  ADD COLUMN attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  ADD COLUMN next_attempt_at timestamptz CHECK (isfinite(next_attempt_at)),
  ADD COLUMN last_error_code text CHECK (last_error_code IN (
    'SOURCE_NOT_ALLOWED','ADDRESS_NOT_PUBLIC','OBJECT_CONFLICT','DOWNLOAD_REJECTED',
    'CONTENT_TYPE_REJECTED','TOO_LARGE','DOWNLOAD_INCOMPLETE','DOWNLOAD_UNAVAILABLE',
    'SOURCE_ACCESS_DENIED','SOURCE_NOT_FOUND','SOURCE_RATE_LIMITED','SOURCE_UNAVAILABLE',
    'STORAGE_UNAVAILABLE','PAYLOAD_INVALID','PROCESSING_UNAVAILABLE','ATTEMPT_INTERRUPTED','LEGACY_FAILURE')),
  ADD COLUMN requires_review boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT call_ended_review_check CHECK (
    NOT requires_review OR (processing_status='FAILED' AND next_attempt_at IS NULL AND last_error_code IS NOT NULL)),
  ADD CONSTRAINT call_ended_processed_retry_check CHECK (
    processing_status<>'PROCESSED' OR (NOT requires_review AND next_attempt_at IS NULL AND last_error_code IS NULL));

-- 과거 실패 원인은 복원할 수 없으므로 기존 FAILED는 운영 확인 후 재개한다.
UPDATE pbx_webhooks.call_ended_events SET requires_review=true,last_error_code='LEGACY_FAILURE'
WHERE processing_status='FAILED';

DROP INDEX pbx_webhooks.call_ended_retry_idx;
CREATE INDEX call_ended_retry_idx
  ON pbx_webhooks.call_ended_events(next_attempt_at NULLS FIRST,last_attempt_at NULLS FIRST,received_at,recording_id)
  WHERE processing_status<>'PROCESSED' AND NOT requires_review;
CREATE INDEX call_ended_unmatched_expiry_idx ON pbx_webhooks.call_ended_events(received_at,recording_id)
  WHERE processing_status<>'PROCESSED' AND call_session_seq IS NULL;

COMMENT ON COLUMN pbx_webhooks.call_ended_events.attempt_count IS '녹취 처리 시도 수. 매칭 대기·S3 미설정 제외, 최초 포함 최대 5회';
COMMENT ON COLUMN pbx_webhooks.call_ended_events.next_attempt_at IS '다음 자동 재시도 시각. 최초 NULL, 확인 대기도 NULL';
COMMENT ON COLUMN pbx_webhooks.call_ended_events.last_error_code IS '원문 URL·전화번호·외부 오류를 포함하지 않는 실패 코드';
COMMENT ON COLUMN pbx_webhooks.call_ended_events.requires_review IS '자동 재시도 중지. 기존 보관 만료·미연결 30분 정리는 유지';
