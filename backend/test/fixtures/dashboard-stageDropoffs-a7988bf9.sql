-- a7988bf9 dashboard stageDropoffs: original SQL for result equivalence.
WITH calls AS (
      SELECT a.is_new_customer,m.dropoff_stage FROM call_sessions c LEFT JOIN call_analyses a USING(call_session_seq) LEFT JOIN call_dashboard_metrics m USING(call_session_seq) WHERE c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>transaction_timestamp()-interval '5 years')
 AND COALESCE(c.ended_at,a.ai_ended_at) IS NOT NULL
 AND ($1::text='ALL' OR ($1='NEW' AND a.is_new_customer IS TRUE) OR ($1='EXISTING' AND a.is_new_customer IS FALSE))
     ), summary AS (
      SELECT count(*) AS total,count(*) FILTER(WHERE is_new_customer IS NULL) AS unknown_customer,
       count(dropoff_stage) AS assessed,count(*) FILTER(WHERE dropoff_stage<>'NONE') AS dropped FROM calls
     ), stages AS (SELECT dropoff_stage,count(*) AS n FROM calls WHERE dropoff_stage<>'NONE' GROUP BY dropoff_stage)
     SELECT jsonb_build_object('customerType',$1::text,'endedCallCount',s.total,'unclassifiedCustomerCallCount',s.unknown_customer,
      'assessedCallCount',s.assessed,'unassessedCallCount',s.total-s.assessed,'dropoffCallCount',s.dropped,
      'dropoffRatePercent',s.dropped*100.0/NULLIF(s.assessed,0),'stages',(
       SELECT jsonb_agg(jsonb_build_object('stage',code,'callCount',COALESCE(n,0),
        'dropoffRatePercent',COALESCE(n,0)*100.0/NULLIF(s.assessed,0)) ORDER BY position)
       FROM unnest($2::text[]) WITH ORDINALITY AS keys(code,position) LEFT JOIN stages ON stages.dropoff_stage=code)) AS data
     FROM summary s
