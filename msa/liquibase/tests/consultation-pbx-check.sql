BEGIN;
DO $$
DECLARE call_id integer;
BEGIN
 INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at) VALUES('pbx-schema-check','01012345678',clock_timestamp()) RETURNING call_session_seq INTO call_id;
 IF NOT EXISTS(SELECT 1 FROM call_sessions WHERE call_session_seq=call_id AND registered_at IS NOT NULL AND ended_at IS NULL AND deleted_at IS NULL) THEN RAISE EXCEPTION 'new call registration missing'; END IF;
 INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload,call_session_seq) VALUES('pbx-schema-check','{}',call_id);
 BEGIN
  UPDATE pbx_webhooks.call_ended_events SET claim_id=gen_random_uuid() WHERE recording_id='pbx-schema-check';
  RAISE EXCEPTION 'unpaired claim accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  UPDATE pbx_webhooks.call_ended_events SET processing_status='UNKNOWN' WHERE recording_id='pbx-schema-check';
  RAISE EXCEPTION 'invalid processing state accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 UPDATE pbx_webhooks.call_ended_events SET claim_id=gen_random_uuid(),claimed_until=clock_timestamp()+interval '5 minutes',processing_status='FAILED' WHERE recording_id='pbx-schema-check';
END $$;
ROLLBACK;
