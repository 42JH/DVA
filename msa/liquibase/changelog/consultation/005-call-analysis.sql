SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.call_analyses (
 call_session_seq integer PRIMARY KEY REFERENCES public.call_sessions(call_session_seq),
 ai_persona_version_seq integer CHECK (ai_persona_version_seq>0),
 ai_started_at timestamptz NOT NULL,
 ai_ended_at timestamptz NOT NULL,
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
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE public.call_analyses ADD COLUMN has_callback_request boolean;

COMMENT ON COLUMN public.call_analyses.has_callback_request IS 'AI 판정 콜백 요청 여부. 연결 요구·처리 완료와 별개. 미수집은 NULL';

CREATE FUNCTION public.valid_call_latency_stats(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE item jsonb; seen text[] := '{}'; code text; duration numeric; samples numeric;
BEGIN
 IF jsonb_typeof(value)<>'array' THEN RETURN false; END IF;
 IF jsonb_array_length(value)>7 THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
  IF jsonb_typeof(item)<>'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(item))<>3 THEN RETURN false; END IF;
  code := item->>'processType';
  IF (code=ANY(ARRAY['CUSTOMER_LOOKUP','INFORMATION_INPUT','FAQ_LOOKUP','ORDER_LOOKUP',
      'ORDER_CANCEL','ADDRESS_LOOKUP','ORDER_SAVE'])) IS NOT TRUE OR code=ANY(seen) THEN RETURN false; END IF;
  IF jsonb_typeof(item->'totalLatencyMs') IS DISTINCT FROM 'number'
    OR jsonb_typeof(item->'measurementCount') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  duration := (item->>'totalLatencyMs')::numeric;
  samples := (item->>'measurementCount')::numeric;
  IF duration<0 OR duration>9007199254740991 OR trunc(duration)<>duration
    OR samples<1 OR samples>2147483647 OR trunc(samples)<>samples THEN RETURN false; END IF;
  seen := array_append(seen,code);
 END LOOP;
 RETURN true;
END $$;

CREATE TABLE public.call_dashboard_metrics (
 call_session_seq integer PRIMARY KEY REFERENCES public.call_analyses(call_session_seq) ON DELETE CASCADE,
 dropoff_stage text,
 dropoff_payload_hash text,
 dropoff_received_at timestamptz,
 total_wait_ms bigint,
 latency_stats jsonb,
 response_wait_payload_hash text,
 response_wait_received_at timestamptz,
 CONSTRAINT call_dashboard_dropoff_stage_check CHECK (dropoff_stage IN ('SENDER_INFO','RECIPIENT_INFO',
  'ITEM_INFO','CONFIRMATION','PAYMENT_GUIDANCE','FAQ_ANSWER','ORDER_LOOKUP','ORDER_CANCEL','NONE')),
 CONSTRAINT call_dashboard_dropoff_receipt_check CHECK (num_nonnulls(dropoff_stage,dropoff_payload_hash,dropoff_received_at) IN (0,3)),
 CONSTRAINT call_dashboard_wait_receipt_check CHECK (num_nonnulls(total_wait_ms,latency_stats,response_wait_payload_hash,response_wait_received_at) IN (0,4)),
 CONSTRAINT call_dashboard_received_check CHECK (dropoff_received_at IS NOT NULL OR response_wait_received_at IS NOT NULL),
 CONSTRAINT call_dashboard_dropoff_hash_check CHECK (dropoff_payload_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT call_dashboard_wait_hash_check CHECK (response_wait_payload_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT call_dashboard_wait_duration_check CHECK (total_wait_ms BETWEEN 0 AND 9007199254740991),
 CONSTRAINT call_dashboard_latency_stats_check CHECK (public.valid_call_latency_stats(latency_stats))
);

COMMENT ON TABLE public.call_dashboard_metrics IS '통화당 이탈·응답 대기 최종 요약. 항목별 독립 수신/해시. 통화 soft delete를 따르고 분석 폐기 시 CASCADE';
COMMENT ON COLUMN public.call_dashboard_metrics.dropoff_stage IS 'AI 확정 이탈 단계 하나. NONE은 이탈 없음, NULL은 항목 미수신. 단계 진입은 저장하지 않음';
COMMENT ON COLUMN public.call_dashboard_metrics.total_wait_ms IS 'AI가 병렬 겹침을 제외한 전체 대기 밀리초. NULL 미수신, 0 측정 후 없음';
COMMENT ON COLUMN public.call_dashboard_metrics.latency_stats IS '최대 7개 고유 처리 유형의 totalLatencyMs/measurementCount. []는 측정 후 없음. P95/원본 표본 없음';

COMMENT ON COLUMN public.call_analyses.ai_persona_version_seq IS 'operations 실제 버전의 논리 참조. AuditPrepared의 FK 보호와 함께 확정';
