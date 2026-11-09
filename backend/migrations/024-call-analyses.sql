SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.call_analyses (
 call_session_seq integer PRIMARY KEY REFERENCES public.call_sessions(call_session_seq),
 ai_persona_version_seq integer REFERENCES public.ai_persona_versions(ai_persona_version_seq),
 ai_started_at timestamptz NOT NULL,
 ai_ended_at timestamptz NOT NULL,
 result text NOT NULL CHECK (result IN ('REGISTERED','REGISTRATION_FAILED','HANDOFF','CANCELLED','INQUIRY')),
 repeat_question_count integer CHECK (repeat_question_count>=0),
 has_complaint boolean,
 complaints jsonb NOT NULL,
 payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
 analysed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (ai_ended_at>=ai_started_at),
 CHECK (CASE WHEN jsonb_typeof(complaints)='array' THEN
  (has_complaint IS TRUE AND jsonb_array_length(complaints) BETWEEN 1 AND 20)
  OR (has_complaint IS NOT TRUE AND jsonb_array_length(complaints)=0)
  ELSE false END)
);

COMMENT ON TABLE public.call_analyses IS '통화당 최종 AI 분석 한 건. PBX 통화 시각·주문·실제 사용 페르소나 이력은 변경하지 않음';
COMMENT ON COLUMN public.call_analyses.complaints IS '불만 유형·근거·위치·같은 통화의 발화 순번. 발화 원문을 중복 저장하지 않음';
COMMENT ON COLUMN public.call_analyses.payload_hash IS '검증·정규화한 요청의 SHA-256. 같은 통화 재전송의 내용 일치 확인';
