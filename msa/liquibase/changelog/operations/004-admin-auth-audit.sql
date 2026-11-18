-- Latest backend migrations 003, 015 and 045; no legacy display names are fabricated.
ALTER TABLE admin_users
 ADD COLUMN name text NOT NULL CHECK (name ~ '[^[:space:]]'),
 ADD COLUMN deleted_at timestamptz;
ALTER TABLE admin_users DROP CONSTRAINT admin_users_status_check;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_status_check
 CHECK (status IN ('ACTIVE','PENDING','INACTIVE'));
ALTER TABLE admin_users DROP CONSTRAINT admin_users_login_id_key;
CREATE UNIQUE INDEX admin_users_login_id_key ON admin_users(login_id) WHERE deleted_at IS NULL;
CREATE INDEX admin_users_retention_idx ON admin_users(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE admin_sessions (
 session_token_hash text PRIMARY KEY CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
 admin_user_seq integer NOT NULL REFERENCES admin_users ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP+INTERVAL '9 hours'),
 CHECK (expires_at>created_at)
);
CREATE INDEX admin_sessions_admin_user_idx ON admin_sessions(admin_user_seq);
CREATE INDEX admin_sessions_expires_at_idx ON admin_sessions(expires_at);

ALTER TABLE audit_logs ADD COLUMN actor_name text, ADD COLUMN target_admin_name text;
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_actor_type_check;
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_type_check CHECK (actor_type IN ('ADMIN','AI','SYSTEM'));
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_identity_check
 CHECK ((actor_type='ADMIN' AND actor_seq IS NOT NULL AND actor_seq>0)
     OR (actor_type IN ('AI','SYSTEM') AND actor_seq IS NULL));
CREATE INDEX audit_logs_retention_idx ON audit_logs(occurred_at,audit_log_seq);
