BEGIN;
DO $$
DECLARE persona_id integer; version_id integer;
BEGIN
 INSERT INTO ai_personas(code) VALUES('consultation-ref-check') RETURNING ai_persona_seq INTO persona_id;
 INSERT INTO ai_persona_versions(ai_persona_seq,version,name,prompt_text,turn_wait_level,status)
 VALUES(persona_id,1,'actual version','unchanged prompt','NORMAL','INACTIVE') RETURNING ai_persona_version_seq INTO version_id;
 INSERT INTO consultation_persona_references(prepared_event_id,transaction_id,call_session_seq,ai_persona_version_seq)
 VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',1,version_id);
 BEGIN DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=version_id;
   RAISE EXCEPTION 'prepared analysis did not protect version'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 UPDATE consultation_persona_references SET committed=true;
 DELETE FROM consultation_persona_references WHERE NOT committed;
 BEGIN DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=version_id;
   RAISE EXCEPTION 'confirmed analysis did not protect version'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN INSERT INTO consultation_persona_references(prepared_event_id,transaction_id,call_session_seq,ai_persona_version_seq,committed)
   VALUES('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004',1,version_id,true);
   RAISE EXCEPTION 'duplicate confirmed analysis accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
 DELETE FROM consultation_persona_references;
 DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=version_id;
END $$;
ROLLBACK;
