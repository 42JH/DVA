\set ON_ERROR_STOP on
BEGIN;
-- Recreate the pre-050 state only inside this disposable transaction.
DROP TABLE public.call_dashboard_metrics;
DROP FUNCTION public.valid_call_latency_stats(jsonb);
INSERT INTO call_sessions(provider_call_id,incoming_at,started_at,ended_at)
 VALUES('dashboard-upgrade-preservation',statement_timestamp(),statement_timestamp(),statement_timestamp()+interval '3 minutes');
INSERT INTO call_analyses(call_session_seq,ai_started_at,ai_ended_at,complaints,payload_hash,is_new_customer,registered_parcel_count)
 SELECT call_session_seq,started_at,ended_at,'[]',repeat('a',64),true,2 FROM call_sessions WHERE provider_call_id='dashboard-upgrade-preservation';
CREATE TEMP TABLE dashboard_original AS SELECT to_jsonb(a) AS row FROM call_analyses a;
CREATE TEMP TABLE dashboard_original_calls AS SELECT to_jsonb(c) AS row FROM call_sessions c;
\i /tmp/dva129/backend/migrations/050-call-dashboard-metrics.sql
CREATE FUNCTION pg_temp.dashboard_expect_error(command text, expected_state text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE command;
 EXCEPTION WHEN OTHERS THEN IF SQLSTATE=expected_state THEN RETURN; END IF; RAISE; END;
 RAISE EXCEPTION 'Expected SQLSTATE %, command succeeded',expected_state;
END $$;
DO $$
DECLARE id integer; before_analysis jsonb; before_call jsonb; sample jsonb;
BEGIN
 IF EXISTS((SELECT row FROM dashboard_original EXCEPT SELECT to_jsonb(a) FROM call_analyses a)
  UNION ALL (SELECT to_jsonb(a) FROM call_analyses a EXCEPT SELECT row FROM dashboard_original)) THEN RAISE EXCEPTION '050 changed existing analyses'; END IF;
 IF EXISTS((SELECT row FROM dashboard_original_calls EXCEPT SELECT to_jsonb(c) FROM call_sessions c)
  UNION ALL (SELECT to_jsonb(c) FROM call_sessions c EXCEPT SELECT row FROM dashboard_original_calls)) THEN RAISE EXCEPTION '050 changed existing calls'; END IF;
 SELECT call_session_seq,to_jsonb(c) INTO id,before_call FROM call_sessions c WHERE provider_call_id='dashboard-upgrade-preservation';
 SELECT to_jsonb(a) INTO before_analysis FROM call_analyses a WHERE call_session_seq=id;
 PERFORM pg_temp.dashboard_expect_error(format('INSERT INTO call_dashboard_metrics(call_session_seq) VALUES(%s)',id),'23514');
 PERFORM pg_temp.dashboard_expect_error(format('INSERT INTO call_dashboard_metrics(call_session_seq,dropoff_stage) VALUES(%s,%L)',id,'NONE'),'23514');
 PERFORM pg_temp.dashboard_expect_error(format('INSERT INTO call_dashboard_metrics VALUES(%s,%L,%L,statement_timestamp(),NULL,NULL,NULL,NULL)',id,'BAD',repeat('a',64)),'23514');
 PERFORM pg_temp.dashboard_expect_error(format('INSERT INTO call_dashboard_metrics VALUES(%s,%L,%L,statement_timestamp(),NULL,NULL,NULL,NULL)',id,'NONE','invalid'),'23514');
 PERFORM pg_temp.dashboard_expect_error('INSERT INTO call_dashboard_metrics(call_session_seq,dropoff_stage,dropoff_payload_hash,dropoff_received_at) VALUES(2147483647,''NONE'',repeat(''a'',64),statement_timestamp())','23503');
 INSERT INTO call_dashboard_metrics(call_session_seq,dropoff_stage,dropoff_payload_hash,dropoff_received_at) VALUES(id,'NONE',repeat('b',64),statement_timestamp());
 PERFORM pg_temp.dashboard_expect_error(format('INSERT INTO call_dashboard_metrics(call_session_seq,dropoff_stage,dropoff_payload_hash,dropoff_received_at) VALUES(%s,%L,%L,statement_timestamp())',id,'NONE',repeat('b',64)),'23505');
 FOR sample IN SELECT value FROM jsonb_array_elements('[null,{},[null],[[]],[{}],[{"processType":"OTHER","totalLatencyMs":1,"measurementCount":1}],[{"processType":"ORDER_SAVE","totalLatencyMs":"1","measurementCount":1}],[{"processType":"ORDER_SAVE","totalLatencyMs":-1,"measurementCount":1}],[{"processType":"ORDER_SAVE","totalLatencyMs":1.5,"measurementCount":1}],[{"processType":"ORDER_SAVE","totalLatencyMs":9007199254740992,"measurementCount":1}],[{"processType":"ORDER_SAVE","totalLatencyMs":1,"measurementCount":0}],[{"processType":"ORDER_SAVE","totalLatencyMs":1,"measurementCount":2147483648}],[{"processType":"ORDER_SAVE","totalLatencyMs":1,"measurementCount":1,"extra":0}],[{"processType":"ORDER_SAVE","totalLatencyMs":1,"measurementCount":1},{"processType":"ORDER_SAVE","totalLatencyMs":2,"measurementCount":1}]]') LOOP
  PERFORM pg_temp.dashboard_expect_error(format('UPDATE call_dashboard_metrics SET total_wait_ms=0,latency_stats=%L::jsonb,response_wait_payload_hash=repeat(''c'',64),response_wait_received_at=statement_timestamp() WHERE call_session_seq=%s',sample::text,id),'23514');
 END LOOP;
 PERFORM pg_temp.dashboard_expect_error(format('UPDATE call_dashboard_metrics SET total_wait_ms=-1,latency_stats=''[]'',response_wait_payload_hash=repeat(''c'',64),response_wait_received_at=statement_timestamp() WHERE call_session_seq=%s',id),'23514');
 UPDATE call_dashboard_metrics SET total_wait_ms=0,latency_stats='[]',response_wait_payload_hash=repeat('c',64),response_wait_received_at=statement_timestamp() WHERE call_session_seq=id;
 IF (SELECT dropoff_stage FROM call_dashboard_metrics WHERE call_session_seq=id)<>'NONE' THEN RAISE EXCEPTION 'Second section lost first section'; END IF;
 UPDATE call_dashboard_metrics SET total_wait_ms=12000,latency_stats='[{"processType":"CUSTOMER_LOOKUP","totalLatencyMs":4000,"measurementCount":2},{"processType":"ORDER_SAVE","totalLatencyMs":8000,"measurementCount":2}]' WHERE call_session_seq=id;
 UPDATE call_sessions SET deleted_at=statement_timestamp() WHERE call_session_seq=id;
 IF NOT EXISTS(SELECT 1 FROM call_dashboard_metrics WHERE call_session_seq=id) THEN RAISE EXCEPTION 'Soft deletion removed metrics'; END IF;
 IF EXISTS(SELECT 1 FROM call_dashboard_metrics m JOIN call_sessions c USING(call_session_seq) WHERE c.call_session_seq=id AND c.deleted_at IS NULL) THEN RAISE EXCEPTION 'Soft deleted metrics visible'; END IF;
 IF (SELECT to_jsonb(a) FROM call_analyses a WHERE call_session_seq=id)<>before_analysis THEN RAISE EXCEPTION 'Metrics changed original analysis/hash/time'; END IF;
 DELETE FROM call_analyses WHERE call_session_seq=id;
 IF EXISTS(SELECT 1 FROM call_dashboard_metrics WHERE call_session_seq=id) THEN RAISE EXCEPTION 'Analysis purge did not cascade'; END IF;
 IF NOT EXISTS(SELECT 1 FROM call_sessions WHERE call_session_seq=id) THEN RAISE EXCEPTION 'Child purge deleted root call'; END IF;
 RAISE NOTICE 'PASS: 050 preserves existing calls/analysis/hash/time, validates JSON/receipts/ranges/PK/FK, isolates sections and supports soft delete/physical cascade';
END $$;
ROLLBACK;
