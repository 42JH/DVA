BEGIN;
DO $$
DECLARE first_call integer; second_call integer; question integer; utterance integer;
BEGIN
 INSERT INTO call_sessions(provider_call_id) VALUES('faq-source-check-1') RETURNING call_session_seq INTO first_call;
 INSERT INTO call_sessions(provider_call_id) VALUES('faq-source-check-2') RETURNING call_session_seq INTO second_call;
 INSERT INTO unanswered_questions(event_id,call_session_seq,question_text,occurred_at,payload_hash,reason)
 VALUES(gen_random_uuid(),first_call,'question',clock_timestamp(),repeat('a',64),'KB_NO_ANSWER') RETURNING unanswered_question_seq INTO question;
 INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq)
 VALUES(first_call,1,'CUSTOMER','question',1) RETURNING call_utterance_seq INTO utterance;
 INSERT INTO call_insight_events(event_id,call_session_seq,event_order,kind,occurred_at,call_utterance_seq,payload_hash)
 VALUES(gen_random_uuid(),first_call,1,'UTTERANCE',clock_timestamp(),utterance,repeat('a',64));
 BEGIN
  INSERT INTO call_insight_events(event_id,call_session_seq,event_order,kind,occurred_at,unanswered_question_seq,payload,payload_hash)
  VALUES(gen_random_uuid(),second_call,2,'BUSINESS_RESULT',clock_timestamp(),question,'{}',repeat('a',64));
  RAISE EXCEPTION 'cross-call question accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 BEGIN
  UPDATE unanswered_questions SET reason='unknown' WHERE unanswered_question_seq=question;
  RAISE EXCEPTION 'unknown reason accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 UPDATE unanswered_questions SET status='DELETED',deleted_at=clock_timestamp() WHERE unanswered_question_seq=question;
 IF (SELECT question_text FROM unanswered_questions WHERE unanswered_question_seq=question)<>'question' THEN RAISE EXCEPTION 'source text erased'; END IF;
END $$;
ROLLBACK;
