SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE public.consultation_persona_references (
 prepared_event_id uuid PRIMARY KEY,
 transaction_id uuid NOT NULL,
 call_session_seq integer NOT NULL CHECK (call_session_seq>0),
 ai_persona_version_seq integer NOT NULL REFERENCES public.ai_persona_versions(ai_persona_version_seq),
 committed boolean NOT NULL DEFAULT false
);
CREATE INDEX consultation_persona_reference_pending_idx
 ON public.consultation_persona_references(transaction_id) WHERE NOT committed;
CREATE UNIQUE INDEX consultation_persona_reference_call_idx
 ON public.consultation_persona_references(call_session_seq) WHERE committed;
COMMENT ON TABLE public.consultation_persona_references IS 'consultation 분석의 실제 버전 FK 보호. 감사 준비와 함께 생성하고 확정 시 보존, 미커밋 중단 시 해제';
