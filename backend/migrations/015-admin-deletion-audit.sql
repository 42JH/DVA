-- 관리자 계정은 실제 삭제하되 업무 이력의 번호와 감사 시점의 이름은 보존한다.
ALTER TABLE audit_logs
 ADD COLUMN actor_name text,
 ADD COLUMN target_admin_name text;

UPDATE audit_logs a SET actor_name=u.name
 FROM admin_users u WHERE a.actor_type='ADMIN' AND a.actor_seq=u.admin_user_seq;
UPDATE audit_logs a SET target_admin_name=u.name
 FROM admin_users u WHERE a.target_type='ADMIN_USER' AND a.target_seq=u.admin_user_seq;

ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_actor_type_check;
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_type_check
 CHECK (actor_type IN ('ADMIN','AI','SYSTEM'));
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_identity_check
 CHECK ((actor_type='ADMIN' AND actor_seq IS NOT NULL AND actor_seq>0)
     OR (actor_type IN ('AI','SYSTEM') AND actor_seq IS NULL));

ALTER TABLE admin_users DROP CONSTRAINT admin_users_status_check;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_status_check
 CHECK (status IN ('ACTIVE','PENDING','INACTIVE'));

ALTER TABLE handoff_requests DROP CONSTRAINT handoff_requests_assigned_admin_user_seq_fk;
ALTER TABLE shipment_status_history DROP CONSTRAINT shipment_status_history_actor_admin_user_seq_fk;
ALTER TABLE ai_persona_versions DROP CONSTRAINT ai_prompt_versions_created_by_admin_user_seq_fk;
ALTER TABLE ai_persona_versions DROP CONSTRAINT ai_persona_versions_requested_by_admin_user_seq_fkey;
ALTER TABLE faq_entries DROP CONSTRAINT faq_entries_updated_by_admin_user_seq_fk;

COMMENT ON COLUMN audit_logs.actor_name IS '작업 당시 관리자 이름 또는 AI. 기존 로그는 migration 시점에 확인 가능한 이름으로 보완';
COMMENT ON COLUMN audit_logs.target_admin_name IS 'ADMIN_USER 대상의 당시 이름. 계정 삭제 후에도 보존';
COMMENT ON COLUMN handoff_requests.assigned_admin_user_seq IS '관리자 논리 참조. 계정 삭제 후 번호 보존';
COMMENT ON COLUMN shipment_status_history.actor_admin_user_seq IS '관리자 논리 참조. 작업자 이름은 감사 로그에 보존';
COMMENT ON COLUMN ai_persona_versions.created_by_admin_user_seq IS '관리자 논리 참조. 작성자 이름은 감사 로그에 보존';
COMMENT ON COLUMN ai_persona_versions.requested_by_admin_user_seq IS '관리자 논리 참조. 요청자 이름은 감사 로그에 보존';
COMMENT ON COLUMN faq_entries.updated_by_admin_user_seq IS '관리자 논리 참조. 수정자 이름은 감사 로그에 보존';
