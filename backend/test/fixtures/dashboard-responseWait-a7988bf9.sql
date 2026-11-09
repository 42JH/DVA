-- a7988bf9 dashboard responseWait: original SQL for result equivalence.
WITH calls AS (
      SELECT a.is_new_customer,(extract(epoch FROM (COALESCE(c.ended_at,a.ai_ended_at)-COALESCE(c.started_at,a.ai_started_at)))*1000) AS duration_ms,m.total_wait_ms,m.latency_stats,m.response_wait_received_at
      FROM call_sessions c LEFT JOIN call_analyses a USING(call_session_seq) LEFT JOIN call_dashboard_metrics m USING(call_session_seq) WHERE c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>transaction_timestamp()-interval '5 years')
 AND COALESCE(c.ended_at,a.ai_ended_at) IS NOT NULL
 AND ($1::text='ALL' OR ($1='NEW' AND a.is_new_customer IS TRUE) OR ($1='EXISTING' AND a.is_new_customer IS FALSE))
     ), measured AS (
      SELECT * FROM calls WHERE response_wait_received_at IS NOT NULL AND total_wait_ms<=duration_ms
     ), summary AS (
      SELECT count(*) AS total,count(*) FILTER(WHERE is_new_customer IS NULL) AS unknown_customer,
       count(*) FILTER(WHERE response_wait_received_at IS NULL) AS unmeasured,
       count(*) FILTER(WHERE response_wait_received_at IS NOT NULL AND total_wait_ms>duration_ms) AS invalid FROM calls
     ), totals AS (
      SELECT count(*) AS measured,COALESCE(sum(total_wait_ms),0) AS wait,COALESCE(sum(duration_ms),0) AS duration FROM measured
     ), processes AS (
      SELECT item->>'processType' AS type,sum((item->>'measurementCount')::bigint) AS samples,
       sum((item->>'totalLatencyMs')::numeric) AS latency FROM measured CROSS JOIN LATERAL jsonb_array_elements(latency_stats) item
      GROUP BY item->>'processType'
     ) SELECT jsonb_build_object('customerType',$1::text,'endedCallCount',s.total,'unclassifiedCustomerCallCount',s.unknown_customer,
      'measuredCallCount',t.measured,'unmeasuredCallCount',s.unmeasured,'invalidWaitCallCount',s.invalid,
      'totalWaitMs',t.wait,'totalCallDurationMs',t.duration,'waitRatePercent',t.wait*100.0/NULLIF(t.duration,0),
      'processes',(SELECT jsonb_agg(jsonb_build_object('processType',code,'measurementCount',COALESCE(p.samples,0),
       'totalLatencyMs',COALESCE(p.latency,0),'averageLatencyMs',p.latency/NULLIF(p.samples,0)) ORDER BY position)
       FROM unnest($2::text[]) WITH ORDINALITY AS keys(code,position) LEFT JOIN processes p ON p.type=code)) AS data
     FROM summary s CROSS JOIN totals t
