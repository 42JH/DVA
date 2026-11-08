SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

ALTER TABLE call_sessions ADD COLUMN analysis_failed_at timestamptz;

COMMENT ON COLUMN call_sessions.analysis_failed_at IS 'AI 최종 분석 실패 최초 수신 시각. 정상 분석이 있으면 조회 상태는 COMPLETED 우선. 통화의 삭제·5년 보관 정책을 따름';
