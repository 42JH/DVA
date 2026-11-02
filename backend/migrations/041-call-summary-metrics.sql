SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AI가 확정한 통화별 값만 저장하며 기존 분석·해시·저장 시각은 보존한다.
ALTER TABLE public.call_analyses
 ADD COLUMN is_new_customer boolean,
 ADD COLUMN registered_parcel_count integer CHECK (registered_parcel_count >= 0),
 ADD COLUMN faq_answer_count integer CHECK (faq_answer_count >= 0),
 ADD COLUMN order_lookup_count integer CHECK (order_lookup_count >= 0),
 ADD COLUMN cancelled_parcel_count integer CHECK (cancelled_parcel_count >= 0),
 ADD COLUMN has_handoff_request boolean;

COMMENT ON COLUMN public.call_analyses.is_new_customer IS 'AI 판정 신규 true / 기존 false. 미수집은 NULL';
COMMENT ON COLUMN public.call_analyses.registered_parcel_count IS 'AI 집계 접수 확정 배송 상세 수. 결제 대기 포함. 미수집은 NULL';
COMMENT ON COLUMN public.call_analyses.faq_answer_count IS 'AI 집계 FAQ 답변 건수. 미수집은 NULL';
COMMENT ON COLUMN public.call_analyses.order_lookup_count IS 'AI 집계 접수 내역 조회·안내 건수. 미수집은 NULL';
COMMENT ON COLUMN public.call_analyses.cancelled_parcel_count IS 'AI 집계 취소 완료 배송 상세 수. 미수집은 NULL';
COMMENT ON COLUMN public.call_analyses.has_handoff_request IS 'AI 판정 상담원 연결 요구 여부. 연결 성공 여부와 별개. 미수집은 NULL';
