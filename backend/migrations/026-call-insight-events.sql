SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- EVT-01의 미답변 참조를 실제 FK로 검증하는 기반. UNQ 수집·관리 API는 후속 구현이다.
CREATE TABLE public.unanswered_questions (
 unanswered_question_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_id uuid NOT NULL UNIQUE,
 call_session_seq integer NOT NULL REFERENCES public.call_sessions(call_session_seq),
 question_text text,
 occurred_at timestamptz NOT NULL,
 offset_seconds bigint CHECK (offset_seconds BETWEEN 0 AND 9007199254740991),
 status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REGISTERED','DELETED')),
 faq_entry_seq integer CHECK (faq_entry_seq>0),
 payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
 faq_conversion_hash text CHECK (faq_conversion_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 registered_at timestamptz,
 deleted_at timestamptz,
 UNIQUE (unanswered_question_seq,call_session_seq),
 CHECK (question_text IS NULL OR (length(btrim(question_text))>0 AND length(question_text)<=1000)),
 CHECK ((status='OPEN' AND question_text IS NOT NULL AND faq_entry_seq IS NULL
   AND faq_conversion_hash IS NULL AND registered_at IS NULL AND deleted_at IS NULL)
  OR (status='REGISTERED' AND question_text IS NOT NULL AND faq_entry_seq IS NOT NULL
   AND faq_conversion_hash IS NOT NULL AND registered_at IS NOT NULL AND deleted_at IS NULL)
  OR (status='DELETED' AND question_text IS NULL AND faq_entry_seq IS NULL
   AND faq_conversion_hash IS NULL AND registered_at IS NULL AND deleted_at IS NOT NULL))
);
CREATE INDEX unanswered_questions_call_idx ON public.unanswered_questions(call_session_seq,unanswered_question_seq);
COMMENT ON COLUMN public.unanswered_questions.faq_entry_seq IS 'FAQ 삭제 뒤에도 전환 대상을 보존하는 논리 참조';

CREATE TABLE public.call_insight_events (
 call_insight_event_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_id uuid NOT NULL UNIQUE,
 call_session_seq integer NOT NULL REFERENCES public.call_sessions(call_session_seq),
 event_order integer NOT NULL CHECK (event_order>0),
 kind text NOT NULL CHECK (kind IN ('UTTERANCE','AI_ACTION','BUSINESS_RESULT')),
 occurred_at timestamptz NOT NULL,
 offset_seconds bigint CHECK (offset_seconds BETWEEN 0 AND 9007199254740991),
 call_utterance_seq integer UNIQUE REFERENCES public.call_utterances(call_utterance_seq),
 unanswered_question_seq integer,
 payload jsonb,
 payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
 received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE (call_session_seq,event_order),
 FOREIGN KEY (unanswered_question_seq,call_session_seq)
  REFERENCES public.unanswered_questions(unanswered_question_seq,call_session_seq),
 CHECK ((kind='UTTERANCE' AND call_utterance_seq IS NOT NULL AND unanswered_question_seq IS NULL AND payload IS NULL)
  OR (kind='AI_ACTION' AND call_utterance_seq IS NULL AND unanswered_question_seq IS NULL
   AND payload IS NOT NULL AND jsonb_typeof(payload)='object' AND NOT (payload ? 'status'))
  OR (kind='BUSINESS_RESULT' AND call_utterance_seq IS NULL
   AND payload IS NOT NULL AND jsonb_typeof(payload)='object'))
);
COMMENT ON TABLE public.call_insight_events IS '통화 이벤트 추가 저장. 요청당 50개와 누적 개수는 별개. 동작 status는 저장하지 않음';
COMMENT ON COLUMN public.call_insight_events.offset_seconds IS 'AI 통화 시작부터의 정수 초. 순서는 event_order, 미확인은 NULL';
COMMENT ON COLUMN public.call_insight_events.payload IS '검증된 동작·업무 요약만 저장. 발화 원문은 call_utterances 참조';
