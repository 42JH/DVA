SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

SELECT pg_advisory_xact_lock(20261026,83);

WITH converted AS (
 UPDATE admin_users SET role='OPERATOR' WHERE role='SUPERVISOR'
 RETURNING admin_user_seq
), migration_request AS MATERIALIZED (SELECT gen_random_uuid() AS id)
INSERT INTO audit_logs(actor_type,actor_seq,action,target_type,target_seq,request_id,result,metadata)
SELECT 'SYSTEM',NULL,'ADMIN_ACCESS_CHANGED','ADMIN_USER',admin_user_seq,id,'SUCCESS','{}'::jsonb
FROM converted CROSS JOIN migration_request;

ALTER TABLE admin_users DROP CONSTRAINT admin_users_role_check;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check
 CHECK (role IN ('OPERATOR','SYSTEM_ADMIN'));

COMMENT ON CONSTRAINT admin_users_role_check ON admin_users
 IS '최상위 관리자와 운영자만 사용. 이전 SUPERVISOR 계정은 상태·삭제·세션을 유지하며 OPERATOR로 이관';
