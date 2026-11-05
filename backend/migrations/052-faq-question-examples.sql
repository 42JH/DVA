SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE public.faq_question_examples (
 faq_question_example_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 faq_entry_seq integer NOT NULL REFERENCES public.faq_entries(faq_entry_seq) ON DELETE CASCADE,
 event_id uuid NOT NULL UNIQUE,
 question_text text NOT NULL CHECK (length(btrim(question_text))>0 AND length(question_text)<=20000),
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at))
);
CREATE INDEX faq_question_examples_recent_idx ON public.faq_question_examples
 (faq_entry_seq,occurred_at DESC,faq_question_example_seq DESC);
CREATE INDEX faq_question_examples_retention_idx ON public.faq_question_examples
 (occurred_at,faq_question_example_seq);

CREATE FUNCTION public.reset_faq_question_examples() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM public.faq_question_examples WHERE faq_entry_seq=NEW.faq_entry_seq;
 RETURN NULL;
END $$;
CREATE TRIGGER faq_question_examples_reset AFTER UPDATE ON public.faq_entries
 FOR EACH ROW EXECUTE FUNCTION public.reset_faq_question_examples();

COMMENT ON TABLE public.faq_question_examples IS 'FAQ별 최신 10개 고객 질문 스냅샷. 응대 발생 후 5년 폐기. FAQ 수정·삭제 시 정리하며 통화 삭제와 독립';
COMMENT ON COLUMN public.faq_question_examples.event_id IS '원본 FAQ_ANSWERED UUID의 논리 참조. 원본 통화·이벤트 물리 삭제 뒤에도 스냅샷을 유지하므로 FK 없음';
COMMENT ON COLUMN public.faq_question_examples.question_text IS '수집 시 검증된 고객 발화 원문 복사. 같은 문장의 서로 다른 발생도 각각 저장';
COMMENT ON COLUMN public.faq_question_examples.occurred_at IS 'FAQ_ANSWERED.occurredAt. 최신 10개와 5년 보존의 공통 기준. 재전송으로 연장하지 않음';
