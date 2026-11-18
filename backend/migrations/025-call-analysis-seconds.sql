SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- JS JSON.stringify와 같은 키 순서·공백 없는 본문으로 변환 후 재전송 해시도 갱신한다.
WITH converted AS (
 SELECT a.call_session_seq,
  COALESCE(jsonb_agg(item ORDER BY position) FILTER (WHERE position IS NOT NULL),'[]'::jsonb) AS complaints,
  '['||COALESCE(string_agg(
   '{"type":'||(item->'type')::text||',"evidenceText":'||(item->'evidenceText')::text||
   ',"offsetSeconds":'||(item->'offsetSeconds')::text||',"utteranceOrders":['||
   COALESCE((SELECT string_agg(n.value::text,',' ORDER BY n.position)
    FROM jsonb_array_elements(item->'utteranceOrders') WITH ORDINALITY n(value,position)),'')||']}',
   ',' ORDER BY position) FILTER (WHERE position IS NOT NULL),'')||']' AS serialized
 FROM public.call_analyses a
 LEFT JOIN LATERAL (
  SELECT (value-'offsetMs')||jsonb_build_object('offsetSeconds',
   CASE WHEN value ? 'offsetSeconds' THEN value->'offsetSeconds'
    WHEN value->'offsetMs'='null'::jsonb THEN 'null'::jsonb
    ELSE to_jsonb(floor((value->>'offsetMs')::numeric/1000)) END) AS item,position
  FROM jsonb_array_elements(a.complaints) WITH ORDINALITY e(value,position)
 ) items ON true
 GROUP BY a.call_session_seq
), payloads AS (
 SELECT a.call_session_seq,x.complaints,
  '{"providerCallId":'||to_json(c.provider_call_id)::text||
  ',"startedAt":'||to_json(to_char(a.ai_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text||
  ',"endedAt":'||to_json(to_char(a.ai_ended_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text||
  ',"aiPersonaVersionSeq":'||COALESCE(a.ai_persona_version_seq::text,'null')||
  ',"result":'||to_json(a.result)::text||
  ',"repeatQuestionCount":'||COALESCE(a.repeat_question_count::text,'null')||
  ',"hasComplaint":'||COALESCE(to_json(a.has_complaint)::text,'null')||
  ',"complaints":'||x.serialized||'}' AS body
 FROM public.call_analyses a JOIN converted x USING(call_session_seq)
 JOIN public.call_sessions c USING(call_session_seq)
)
UPDATE public.call_analyses a SET complaints=p.complaints,
 payload_hash=encode(sha256(convert_to(p.body,'UTF8')),'hex')
FROM payloads p WHERE p.call_session_seq=a.call_session_seq;

COMMENT ON COLUMN public.call_analyses.complaints IS '불만 유형·근거·정수 초 offsetSeconds·발화 순번. 025부터 offsetMs 대신 초 단위 사용';
