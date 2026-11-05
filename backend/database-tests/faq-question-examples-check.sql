\set ON_ERROR_STOP on
BEGIN;
-- Exercise an upgrade with existing FAQ/event data without changing the real ledger.
DROP TRIGGER faq_question_examples_reset ON public.faq_entries;
DROP FUNCTION public.reset_faq_question_examples();
DROP TABLE public.faq_question_examples;
CREATE TEMP TABLE faq_example_upgrade(faq_id integer,call_id integer,faq_before jsonb);
DO $$
DECLARE faq_id integer; call_id integer;
BEGIN
 INSERT INTO public.faq_entries(question,answer,category,updated_by_admin_user_seq)
  VALUES('사례 마이그레이션 질문','기존 FAQ 답변','기타',1) RETURNING faq_entry_seq INTO faq_id;
 INSERT INTO public.call_sessions(provider_call_id) VALUES('faq-example-upgrade') RETURNING call_session_seq INTO call_id;
 INSERT INTO public.call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq)
  VALUES(call_id,1,'CUSTOMER',' 원본 고객 질문\n',1);
 INSERT INTO public.call_insight_events(event_id,call_session_seq,event_order,kind,occurred_at,payload,payload_hash)
  VALUES('00000000-0000-4000-8000-000000000052',call_id,1,'BUSINESS_RESULT',statement_timestamp(),
   jsonb_build_object('action','FAQ_ANSWERED','faqEntrySeq',faq_id),repeat('a',64));
 INSERT INTO faq_example_upgrade SELECT faq_id,call_id,to_jsonb(f) FROM public.faq_entries f WHERE faq_entry_seq=faq_id;
END $$;
\i /tmp/dva129/backend/migrations/052-faq-question-examples.sql
DO $$
DECLARE faq_id integer; other_faq integer; call_id integer; snapshot jsonb; example_id integer;
BEGIN
 SELECT u.faq_id,u.call_id,u.faq_before INTO faq_id,call_id,snapshot FROM faq_example_upgrade u;
 IF (SELECT to_jsonb(f) FROM public.faq_entries f WHERE faq_entry_seq=faq_id) IS DISTINCT FROM snapshot
  OR NOT EXISTS(SELECT 1 FROM public.call_insight_events WHERE call_session_seq=call_id)
  OR EXISTS(SELECT 1 FROM public.faq_question_examples) THEN
  RAISE EXCEPTION '052 must preserve FAQ/events without historical backfill'; END IF;
 INSERT INTO public.faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
  SELECT faq_id,'00000000-0000-4000-8000-000000000052',utterance_text,statement_timestamp()
  FROM public.call_utterances WHERE call_session_seq=call_id RETURNING faq_question_example_seq INTO example_id;
 -- Same text, different occurrence remains a separate example.
 INSERT INTO public.faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
  SELECT faq_id,'00000000-0000-4000-8000-000000000053',question_text,occurred_at FROM public.faq_question_examples WHERE faq_question_example_seq=example_id;
 INSERT INTO public.faq_entries(question,answer,category,updated_by_admin_user_seq)
  VALUES('같은 응대의 다른 FAQ','다른 FAQ 답변','기타',1) RETURNING faq_entry_seq INTO other_faq;
 INSERT INTO public.faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
  SELECT other_faq,event_id,question_text,occurred_at FROM public.faq_question_examples WHERE faq_question_example_seq=example_id;
 BEGIN
  INSERT INTO public.faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
   VALUES(faq_id,'00000000-0000-4000-8000-000000000052','중복 이벤트',statement_timestamp());
  RAISE EXCEPTION 'Duplicate event UUID accepted';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO public.faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
   VALUES(faq_id,gen_random_uuid(),' ',statement_timestamp());
  RAISE EXCEPTION 'Blank question accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO public.faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
   VALUES(faq_id,gen_random_uuid(),repeat('x',20001),statement_timestamp());
  RAISE EXCEPTION 'Oversized question accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO public.faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
   VALUES(-1,gen_random_uuid(),'미존재 FAQ',statement_timestamp());
  RAISE EXCEPTION 'Missing FAQ accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 DELETE FROM public.call_insight_events WHERE call_session_seq=call_id;
 DELETE FROM public.call_utterances WHERE call_session_seq=call_id;
 DELETE FROM public.call_sessions WHERE call_session_seq=call_id;
 IF (SELECT count(*) FROM public.faq_question_examples WHERE faq_entry_seq=faq_id)<>2
  OR (SELECT question_text FROM public.faq_question_examples WHERE faq_question_example_seq=example_id)<>' 원본 고객 질문\n' THEN
  RAISE EXCEPTION 'Call purge must preserve independent question snapshots'; END IF;
 -- A later transaction failure must undo the trigger's deletion too.
 BEGIN
  UPDATE public.faq_entries SET answer='롤백할 수정' WHERE faq_entry_seq=faq_id;
  IF EXISTS(SELECT 1 FROM public.faq_question_examples WHERE faq_entry_seq=faq_id) THEN
   RAISE EXCEPTION 'FAQ update did not clear examples'; END IF;
  RAISE EXCEPTION 'rollback probe' USING ERRCODE='P0052';
 EXCEPTION WHEN SQLSTATE 'P0052' THEN NULL;
 END;
 IF (SELECT count(*) FROM public.faq_question_examples WHERE faq_entry_seq=faq_id)<>2 THEN
  RAISE EXCEPTION 'FAQ update rollback lost examples'; END IF;
 UPDATE public.faq_entries SET answer='수정된 FAQ' WHERE faq_entry_seq=faq_id;
 IF EXISTS(SELECT 1 FROM public.faq_question_examples WHERE faq_entry_seq=faq_id) THEN
  RAISE EXCEPTION 'FAQ update must delete all examples'; END IF;
 INSERT INTO public.faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
  VALUES(faq_id,gen_random_uuid(),'삭제 전 사례',statement_timestamp());
 UPDATE public.faq_entries SET deleted_at=clock_timestamp() WHERE faq_entry_seq=faq_id;
 IF EXISTS(SELECT 1 FROM public.faq_question_examples WHERE faq_entry_seq=faq_id) THEN
  RAISE EXCEPTION 'FAQ soft delete must delete all examples'; END IF;
 INSERT INTO public.faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
  VALUES(faq_id,gen_random_uuid(),'물리 삭제 전 사례',statement_timestamp());
 DELETE FROM public.faq_entries WHERE faq_entry_seq=faq_id;
 IF EXISTS(SELECT 1 FROM public.faq_question_examples WHERE faq_entry_seq=faq_id) THEN
  RAISE EXCEPTION 'FAQ physical delete must cascade examples'; END IF;
 IF (SELECT count(*) FROM public.faq_question_examples WHERE faq_entry_seq=other_faq)<>1 THEN
  RAISE EXCEPTION 'Deleting one FAQ must preserve the other FAQ example for the same event'; END IF;
END $$;
ROLLBACK;
\echo 'PASS: FAQ snapshot upgrade, constraints, call independence and transactional FAQ cleanup'
