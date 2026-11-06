BEGIN;
DO $$
DECLARE actor integer; faq integer; other integer; before_at timestamptz;
BEGIN
 INSERT INTO admin_users(login_id,name,password_hash,role,status)
 VALUES('faqcheck','FAQ check','not-a-real-password','OPERATOR','ACTIVE') RETURNING admin_user_seq INTO actor;
 INSERT INTO faq_entries(question,answer,category,updated_by_admin_user_seq,updated_at)
 VALUES('FAQ schema check','answer','기타',actor,'2001-01-01Z') RETURNING faq_entry_seq,updated_at INTO faq,before_at;
 BEGIN
  INSERT INTO faq_entries(question,answer,category,updated_by_admin_user_seq)
  VALUES('  faq   SCHEMA check  ','duplicate','기타',actor);
  RAISE EXCEPTION 'normalized duplicate accepted';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 BEGIN
  UPDATE faq_entries SET category='unknown' WHERE faq_entry_seq=faq;
  RAISE EXCEPTION 'unknown category accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 INSERT INTO faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
 VALUES(faq,gen_random_uuid(),'actual question',clock_timestamp());
 IF (SELECT count(*) FROM faq_question_examples WHERE faq_entry_seq=faq)<>1 THEN RAISE EXCEPTION 'snapshot missing'; END IF;
 UPDATE faq_entries SET answer='changed' WHERE faq_entry_seq=faq;
 IF EXISTS(SELECT 1 FROM faq_question_examples WHERE faq_entry_seq=faq) THEN RAISE EXCEPTION 'edit retained snapshots'; END IF;
 IF (SELECT updated_at FROM faq_entries WHERE faq_entry_seq=faq)<=before_at THEN RAISE EXCEPTION 'timestamp missing'; END IF;
 UPDATE faq_entries SET deleted_at=clock_timestamp() WHERE faq_entry_seq=faq;
 INSERT INTO faq_entries(question,answer,category,updated_by_admin_user_seq)
 VALUES('FAQ schema check','reused','기타',actor) RETURNING faq_entry_seq INTO other;
 INSERT INTO faq_change_notifications(operation,faq_entry_seqs,request_id) VALUES('DELETE',ARRAY[faq,other],gen_random_uuid());
 BEGIN
  INSERT INTO faq_change_notifications(operation,faq_entry_seqs,request_id) VALUES('UPDATE',ARRAY[faq,other],gen_random_uuid());
  RAISE EXCEPTION 'multiple update notification accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
  VALUES(other,gen_random_uuid(),'question','infinity');
  RAISE EXCEPTION 'infinite occurrence accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
ROLLBACK;
