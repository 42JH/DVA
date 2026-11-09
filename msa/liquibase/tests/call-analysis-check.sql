BEGIN;
DO $$
DECLARE call_id integer;
BEGIN
 INSERT INTO call_sessions(provider_call_id,caller_phone_number) VALUES('analysis-schema-check','01012345678') RETURNING call_session_seq INTO call_id;
 INSERT INTO call_analyses(call_session_seq,ai_started_at,ai_ended_at,has_complaint,complaints,payload_hash)
 VALUES(call_id,'2026-11-01T01:00:00Z','2026-11-01T01:03:00Z',NULL,'[]',repeat('a',64));
 IF EXISTS(SELECT 1 FROM call_analyses WHERE call_session_seq=call_id AND
   (is_new_customer IS NOT NULL OR registered_parcel_count IS NOT NULL OR has_callback_request IS NOT NULL))
 THEN RAISE EXCEPTION 'unknown summary was fabricated'; END IF;
 BEGIN UPDATE call_analyses SET has_complaint=true WHERE call_session_seq=call_id;
   RAISE EXCEPTION 'complaint mismatch accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE call_analyses SET registered_parcel_count=-1 WHERE call_session_seq=call_id;
   RAISE EXCEPTION 'negative summary accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE call_analyses SET ai_ended_at=ai_started_at-interval '1 second' WHERE call_session_seq=call_id;
   RAISE EXCEPTION 'negative duration accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO call_dashboard_metrics(call_session_seq,dropoff_stage,dropoff_payload_hash,dropoff_received_at)
 VALUES(call_id,'NONE',repeat('b',64),now());
 BEGIN UPDATE call_dashboard_metrics SET total_wait_ms=0 WHERE call_session_seq=call_id;
   RAISE EXCEPTION 'partial wait receipt accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 UPDATE call_dashboard_metrics SET total_wait_ms=0,latency_stats='[]',response_wait_payload_hash=repeat('c',64),response_wait_received_at=now()
 WHERE call_session_seq=call_id;
 BEGIN UPDATE call_dashboard_metrics SET latency_stats='[{"processType":"ORDER_SAVE","totalLatencyMs":0,"measurementCount":1},{"processType":"ORDER_SAVE","totalLatencyMs":0,"measurementCount":1}]' WHERE call_session_seq=call_id;
   RAISE EXCEPTION 'duplicate latency type accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE call_dashboard_metrics SET latency_stats='[{"processType":"ORDER_SAVE","totalLatencyMs":0,"measurementCount":0}]' WHERE call_session_seq=call_id;
   RAISE EXCEPTION 'zero samples accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE call_dashboard_metrics SET dropoff_stage='BAD' WHERE call_session_seq=call_id;
   RAISE EXCEPTION 'invalid stage accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN DELETE FROM call_sessions WHERE call_session_seq=call_id;
   RAISE EXCEPTION 'analysis lost by call delete'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 DELETE FROM call_analyses WHERE call_session_seq=call_id;
 IF EXISTS(SELECT 1 FROM call_dashboard_metrics WHERE call_session_seq=call_id)
 THEN RAISE EXCEPTION 'metric cascade failed'; END IF;
END $$;
ROLLBACK;
