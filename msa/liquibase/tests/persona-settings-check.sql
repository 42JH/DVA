BEGIN;
DO $$
DECLARE persona integer; first_version integer; second_version integer;
BEGIN
 INSERT INTO ai_personas(code) VALUES('version-check-'||txid_current()) RETURNING ai_persona_seq INTO persona;
 INSERT INTO ai_persona_versions(ai_persona_seq,version,name,prompt_text,turn_wait_level,created_by_admin_user_seq,created_by_admin_user_name)
 VALUES(persona,1,'이름',' 원문'||chr(10),'NORMAL',2147483647,'삭제 후 보존할 작성자')
 RETURNING ai_persona_version_seq INTO first_version;
 INSERT INTO ai_persona_versions(ai_persona_seq,version,name,prompt_text,turn_wait_level)
 VALUES(persona,2,'다음 이름','다음 원문','LONG') RETURNING ai_persona_version_seq INTO second_version;
 BEGIN
  UPDATE ai_persona_versions SET prompt_text='overwritten' WHERE ai_persona_version_seq=first_version;
  RAISE EXCEPTION 'Immutable history was changed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE ai_persona_versions SET status='ACTIVE' WHERE ai_persona_version_seq=first_version;
  RAISE EXCEPTION 'Active without applied identity was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 UPDATE ai_persona_versions SET status='PENDING',application_id=gen_random_uuid(),requested_by_admin_user_seq=2147483647,
  requested_at=clock_timestamp() WHERE ai_persona_version_seq=first_version;
 BEGIN
  UPDATE ai_persona_versions SET status='PENDING',application_id=gen_random_uuid(),requested_by_admin_user_seq=2147483647,
   requested_at=clock_timestamp() WHERE ai_persona_version_seq=second_version;
  RAISE EXCEPTION 'Multiple pending versions accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 UPDATE ai_persona_versions SET status='ACTIVE',applied_at=clock_timestamp() WHERE ai_persona_version_seq=first_version;
 UPDATE ai_persona_versions SET status='PENDING',application_id=gen_random_uuid(),requested_by_admin_user_seq=2147483647,
  requested_at=clock_timestamp() WHERE ai_persona_version_seq=second_version;
 BEGIN
  UPDATE ai_persona_versions SET status='ACTIVE',applied_at=clock_timestamp() WHERE ai_persona_version_seq=second_version;
  RAISE EXCEPTION 'Multiple active versions accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 UPDATE ai_persona_versions SET status='INACTIVE' WHERE ai_persona_version_seq=first_version;
 UPDATE ai_persona_versions SET status='ACTIVE',applied_at=clock_timestamp(),previous_active_version_seq=first_version
  WHERE ai_persona_version_seq=second_version;
 BEGIN
  UPDATE ai_persona_versions SET previous_active_version_seq=second_version WHERE ai_persona_version_seq=second_version;
  RAISE EXCEPTION 'Previous active self reference accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO ai_persona_drafts(ai_persona_seq,draft_revision,base_version,name,prompt_text,turn_wait_level,updated_by_admin_user_seq)
 VALUES(persona,gen_random_uuid(),2,'초안','새 원문','NORMAL',2147483647);
 IF (SELECT count(*) FROM ai_persona_drafts WHERE ai_persona_seq=persona)<>1
  OR (SELECT created_by_admin_user_name FROM ai_persona_versions WHERE ai_persona_version_seq=first_version)<>'삭제 후 보존할 작성자'
  OR (SELECT previous_active_version_seq FROM ai_persona_versions WHERE ai_persona_version_seq=second_version)<>first_version THEN
  RAISE EXCEPTION 'Draft, logical author or previous active was lost'; END IF;
 BEGIN
  UPDATE ai_persona_versions SET deleted_at=transaction_timestamp() WHERE ai_persona_version_seq=second_version;
  RAISE EXCEPTION 'Deleted ACTIVE persona version was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 UPDATE ai_persona_versions SET deleted_at=transaction_timestamp() WHERE ai_persona_version_seq=first_version;
 IF (SELECT previous_active_version_seq FROM ai_persona_versions WHERE ai_persona_version_seq=second_version)<>first_version
  OR NOT EXISTS(SELECT 1 FROM ai_persona_versions WHERE ai_persona_version_seq=first_version AND deleted_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Soft deletion lost immutable version history'; END IF;
END $$;
ROLLBACK;
