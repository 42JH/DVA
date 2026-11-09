SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.call_analyses IN ACCESS EXCLUSIVE MODE;

-- 025와 같은 JSON.stringify 직렬화로 result를 제외한 재전송 해시를 갱신한다.
WITH evidence AS (
 SELECT a.call_session_seq,
  '['||COALESCE(string_agg(
   '{"type":'||(item->'type')::text||',"evidenceText":'||(item->'evidenceText')::text||
   ',"offsetSeconds":'||(item->'offsetSeconds')::text||',"utteranceOrders":['||
   COALESCE((SELECT string_agg(n.value::text,',' ORDER BY n.position)
    FROM jsonb_array_elements(item->'utteranceOrders') WITH ORDINALITY n(value,position)),'')||']}',
   ',' ORDER BY position) FILTER (WHERE position IS NOT NULL),'')||']' AS serialized
 FROM public.call_analyses a
 LEFT JOIN LATERAL jsonb_array_elements(a.complaints) WITH ORDINALITY e(item,position) ON true
 GROUP BY a.call_session_seq
), payloads AS (
 SELECT a.call_session_seq,
  '{"providerCallId":'||to_json(c.provider_call_id)::text||
  ',"startedAt":'||to_json(to_char(a.ai_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text||
  ',"endedAt":'||to_json(to_char(a.ai_ended_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text||
  ',"aiPersonaVersionSeq":'||COALESCE(a.ai_persona_version_seq::text,'null')||
  ',"repeatQuestionCount":'||COALESCE(a.repeat_question_count::text,'null')||
  ',"hasComplaint":'||COALESCE(to_json(a.has_complaint)::text,'null')||
  ',"complaints":'||x.serialized||
  CASE WHEN a.is_new_customer IS NULL THEN '' ELSE ',"isNewCustomer":'||a.is_new_customer::text END||
  CASE WHEN a.registered_parcel_count IS NULL THEN '' ELSE ',"registeredParcelCount":'||a.registered_parcel_count::text END||
  CASE WHEN a.faq_answer_count IS NULL THEN '' ELSE ',"faqAnswerCount":'||a.faq_answer_count::text END||
  CASE WHEN a.order_lookup_count IS NULL THEN '' ELSE ',"orderLookupCount":'||a.order_lookup_count::text END||
  CASE WHEN a.cancelled_parcel_count IS NULL THEN '' ELSE ',"cancelledParcelCount":'||a.cancelled_parcel_count::text END||
  CASE WHEN a.has_handoff_request IS NULL THEN '' ELSE ',"hasHandoffRequest":'||a.has_handoff_request::text END||'}' AS body
 FROM public.call_analyses a JOIN evidence x USING(call_session_seq)
 JOIN public.call_sessions c USING(call_session_seq)
)
UPDATE public.call_analyses a SET payload_hash=encode(sha256(convert_to(p.body,'UTF8')),'hex')
FROM payloads p WHERE p.call_session_seq=a.call_session_seq;

ALTER TABLE public.call_analyses DROP COLUMN result;
