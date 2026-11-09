SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE public.call_analyses ADD COLUMN has_callback_request boolean;

COMMENT ON COLUMN public.call_analyses.has_callback_request IS 'AI 판정 콜백 요청 여부. 연결 요구·처리 완료와 별개. 미수집은 NULL';
