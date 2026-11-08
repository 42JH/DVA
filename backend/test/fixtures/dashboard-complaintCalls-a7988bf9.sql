-- a7988bf9 dashboard complaintCalls: original SQL for result equivalence.
WITH calls AS (
      SELECT c.call_session_seq,a.is_new_customer,a.has_complaint,a.complaints FROM call_sessions c LEFT JOIN call_analyses a USING(call_session_seq) WHERE c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>transaction_timestamp()-interval '5 years')
 AND COALESCE(c.ended_at,a.ai_ended_at) IS NOT NULL
 AND ($1::text='ALL' OR ($1='NEW' AND a.is_new_customer IS TRUE) OR ($1='EXISTING' AND a.is_new_customer IS FALSE))
     ), summary AS (
      SELECT count(*) AS total,count(*) FILTER(WHERE is_new_customer IS NULL) AS unknown_customer,
       count(has_complaint) AS assessed,count(*) FILTER(WHERE has_complaint IS TRUE) AS complained FROM calls
     ), call_types AS (
      SELECT DISTINCT c.call_session_seq,item->>'type' AS type
      FROM calls c CROSS JOIN LATERAL jsonb_array_elements(c.complaints) item WHERE c.has_complaint IS TRUE
     ), types AS (SELECT type,count(*) AS n FROM call_types WHERE type=ANY($2::text[]) GROUP BY type),
     type_total AS (SELECT COALESCE(sum(n),0) AS n FROM types)
     SELECT jsonb_build_object('customerType',$1::text,'endedCallCount',s.total,'unclassifiedCustomerCallCount',s.unknown_customer,
      'assessedCallCount',s.assessed,'unassessedCallCount',s.total-s.assessed,'complaintCallCount',s.complained,
      'complaintRatePercent',s.complained*100.0/NULLIF(s.assessed,0),'typeTotalCount',t.n,
      'legacyTypeCallCount',(SELECT count(DISTINCT call_session_seq) FROM call_types WHERE type IS NULL OR NOT(type=ANY($2::text[]))),
      'types',(SELECT jsonb_agg(jsonb_build_object('type',code,'callCount',COALESCE(types.n,0),
       'sharePercent',COALESCE(types.n,0)*100.0/NULLIF(t.n,0)) ORDER BY position)
       FROM unnest($2::text[]) WITH ORDINALITY AS keys(code,position) LEFT JOIN types ON types.type=code)) AS data
     FROM summary s CROSS JOIN type_total t
