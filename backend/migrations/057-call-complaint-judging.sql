SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- 통화 불만 판정(후처리, Jira 148): AI 분석 저장 뒤 백엔드 워커가 has_complaint · complaints를 채운다.
-- AI는 불만을 판정하지 않고 has_complaint=NULL로 보낸다. NULL인 행을 워커가 집어 판정하고, 결과로만 바꾼다.
ALTER TABLE call_analyses
  ADD COLUMN complaint_attempts smallint NOT NULL DEFAULT 0 CHECK (complaint_attempts BETWEEN 0 AND 10),
  ADD COLUMN complaint_retry_at timestamptz CHECK (isfinite(complaint_retry_at));

COMMENT ON COLUMN call_analyses.complaint_attempts IS '불만 판정 시도 수. 3번 실패하거나 판정할 수 없는 통화(대본이 너무 김)는 10으로 두고 다시 집지 않음';
COMMENT ON COLUMN call_analyses.complaint_retry_at IS '불만 판정을 다시 집을 수 있는 시각(진행 중 임대 · 실패 뒤 대기). NULL이면 바로';

-- 아직 판정하지 않은 통화를 최신부터 집는 색인 (판정이 끝난 행은 들어가지 않음)
CREATE INDEX call_analyses_complaint_pending_idx ON call_analyses (analysed_at DESC)
  WHERE has_complaint IS NULL AND complaint_attempts < 3;
