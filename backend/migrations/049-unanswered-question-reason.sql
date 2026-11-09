SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE public.unanswered_questions ADD COLUMN reason text
 CONSTRAINT unanswered_questions_reason_check CHECK (reason IN ('KB_NO_ANSWER','KB_UNAVAILABLE'));

COMMENT ON COLUMN public.unanswered_questions.reason IS 'AI가 보고한 미답변 사유. KB_NO_ANSWER 근거 부족 / KB_UNAVAILABLE 검색 미연결·장애. 과거·미분류는 NULL. 업무 status와 별개';
