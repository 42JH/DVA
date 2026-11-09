-- a7988bf9 dashboard registrationTime: original SQL for result equivalence.
WITH calls AS (
      SELECT a.is_new_customer,a.ai_persona_version_seq,a.registered_parcel_count,(extract(epoch FROM (COALESCE(c.ended_at,a.ai_ended_at)-COALESCE(c.started_at,a.ai_started_at)))*1000) AS duration_ms
      FROM call_sessions c LEFT JOIN call_analyses a USING(call_session_seq) WHERE c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>transaction_timestamp()-interval '5 years')
 AND COALESCE(c.ended_at,a.ai_ended_at) IS NOT NULL
 AND ($1::text='ALL' OR ($1='NEW' AND a.is_new_customer IS TRUE) OR ($1='EXISTING' AND a.is_new_customer IS FALSE))
     ), summary AS (
      SELECT count(*) AS total,count(*) FILTER(WHERE is_new_customer IS NULL) AS unknown_customer,
       count(*) FILTER(WHERE registered_parcel_count>0) AS registrations,
       count(*) FILTER(WHERE registered_parcel_count IS NULL) AS unmeasured,
       COALESCE(sum(registered_parcel_count) FILTER(WHERE registered_parcel_count>0),0) AS parcels,
       COALESCE(sum(duration_ms) FILTER(WHERE registered_parcel_count>0),0) AS duration FROM calls
     ), stats AS (
      SELECT ai_persona_version_seq,count(*) AS registrations,sum(registered_parcel_count) AS parcels,sum(duration_ms) AS duration
      FROM calls WHERE registered_parcel_count>0 GROUP BY ai_persona_version_seq
     ), live AS (SELECT ai_persona_version_seq,previous_active_version_seq FROM ai_persona_versions WHERE status='ACTIVE'),
     selected AS (
      SELECT 'CURRENT' AS role,ai_persona_version_seq AS id FROM live
      UNION ALL SELECT 'PREVIOUS',previous_active_version_seq FROM live WHERE previous_active_version_seq IS NOT NULL
     ), comparison AS (
      SELECT selected.role,stats.duration/NULLIF(stats.parcels,0)/1000 AS average,
       jsonb_build_object('aiPersonaVersionSeq',v.ai_persona_version_seq,'aiPersonaSeq',v.ai_persona_seq,'name',v.name,'version',v.version,
        'registrationCallCount',COALESCE(stats.registrations,0),'registeredParcelCount',COALESCE(stats.parcels,0),
        'totalCallDurationMs',COALESCE(stats.duration,0),'averageSecondsPerParcel',stats.duration/NULLIF(stats.parcels,0)/1000) AS data
      FROM selected JOIN ai_persona_versions v ON v.ai_persona_version_seq=selected.id
      LEFT JOIN stats ON stats.ai_persona_version_seq=v.ai_persona_version_seq
     ) SELECT jsonb_build_object('customerType',$1::text,'endedCallCount',s.total,'unclassifiedCustomerCallCount',s.unknown_customer,
      'registrationCallCount',s.registrations,'unmeasuredCallCount',s.unmeasured,'registeredParcelCount',s.parcels,
      'totalCallDurationMs',s.duration,'averageSecondsPerParcel',s.duration/NULLIF(s.parcels,0)/1000,
      'comparison',jsonb_build_object('current',(SELECT data FROM comparison WHERE role='CURRENT'),
       'previous',(SELECT data FROM comparison WHERE role='PREVIOUS'),
       'previousMinusCurrentSeconds',(SELECT average FROM comparison WHERE role='PREVIOUS')-(SELECT average FROM comparison WHERE role='CURRENT'))) AS data
     FROM summary s
