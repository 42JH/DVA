BEGIN;
INSERT INTO call_sessions(provider_call_id) VALUES('retry-fresh');
INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload,processing_status) VALUES('fresh-received','{}','RECEIVED'),('fresh-failed','{}','FAILED');
DO $$
BEGIN
 BEGIN
  UPDATE pbx_webhooks.call_ended_events SET attempt_count=6 WHERE recording_id='fresh-received';
  RAISE EXCEPTION 'Attempt upper bound missing';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE pbx_webhooks.call_ended_events SET attempt_count=-1 WHERE recording_id='fresh-received';
  RAISE EXCEPTION 'Attempt lower bound missing';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE pbx_webhooks.call_ended_events SET requires_review=true WHERE recording_id='fresh-received';
  RAISE EXCEPTION 'Invalid review state accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE pbx_webhooks.call_ended_events SET last_error_code='https://private.invalid/secret' WHERE recording_id='fresh-failed';
  RAISE EXCEPTION 'Raw source error accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
