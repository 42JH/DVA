-- Existing MSA settings remain usable in the preserved legacy store. Rolled back.
BEGIN;
DO $$
DECLARE admin_id integer; faq_id integer; persona_id integer;
BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
   AND table_name='faq_entries' AND column_name IN ('version','is_enabled')) THEN
  RAISE EXCEPTION 'Removed FAQ columns remain';
 END IF;
 INSERT INTO admin_users(login_id,name,password_hash,role,status)
 VALUES('faq-check-'||txid_current(),'Schema test','test-only-not-a-login','SYSTEM_ADMIN','ACTIVE')
 RETURNING admin_user_seq INTO admin_id;
 UPDATE admin_users SET status='PENDING' WHERE admin_user_seq=admin_id;
 UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=admin_id;
 UPDATE admin_users SET status='INACTIVE' WHERE admin_user_seq=admin_id;
 IF (SELECT status FROM admin_users WHERE admin_user_seq=admin_id)<>'INACTIVE' THEN
  RAISE EXCEPTION 'Latest monolith inactive state not preserved'; END IF;
 UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=admin_id;
 BEGIN
  UPDATE admin_users SET status='INVALID' WHERE admin_user_seq=admin_id;
  RAISE EXCEPTION 'Invalid admin status accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 INSERT INTO legacy_ai_personas(code,name) VALUES('faq-check-'||txid_current(),'test')
 RETURNING ai_persona_seq INTO persona_id;
 IF (SELECT turn_wait_level FROM legacy_ai_personas WHERE ai_persona_seq=persona_id)<>'NORMAL' THEN
  RAISE EXCEPTION 'Wrong wait default'; END IF;
 BEGIN
  UPDATE legacy_ai_personas SET turn_wait_level='INVALID' WHERE ai_persona_seq=persona_id;
  RAISE EXCEPTION 'Invalid wait level accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq,updated_at)
 VALUES('test question','test answer',admin_id,'2000-01-01Z') RETURNING faq_entry_seq INTO faq_id;
 UPDATE faq_entries SET answer='changed answer' WHERE faq_entry_seq=faq_id;
 IF (SELECT updated_at FROM faq_entries WHERE faq_entry_seq=faq_id)<='2000-01-01Z'::timestamptz THEN
  RAISE EXCEPTION 'FAQ timestamp did not update'; END IF;
 DELETE FROM faq_entries WHERE faq_entry_seq=faq_id;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='faq_entries'::regclass
   AND tgname='faq_entry_changed' AND tgenabled='O') THEN
  RAISE EXCEPTION 'FAQ notification trigger missing'; END IF;
END $$;
ROLLBACK;
-- Actual LISTEN delivery after COMMIT and AI reconnect reconciliation need an integration test.
