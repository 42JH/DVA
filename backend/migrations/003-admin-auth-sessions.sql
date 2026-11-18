ALTER TABLE admin_users
ADD COLUMN name text NOT NULL;

ALTER TABLE admin_users
ADD CONSTRAINT admin_users_name_not_blank
CHECK (name ~ '[^[:space:]]');

CREATE TABLE admin_sessions (
    session_token_hash text PRIMARY KEY,
    admin_user_seq integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz NOT NULL
        DEFAULT (CURRENT_TIMESTAMP + INTERVAL '9 hours'),

    CONSTRAINT admin_sessions_token_hash_format
        CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),

    CONSTRAINT admin_sessions_admin_user_fk
        FOREIGN KEY (admin_user_seq)
        REFERENCES admin_users (admin_user_seq)
        ON DELETE CASCADE,

    CONSTRAINT admin_sessions_expiration_valid
        CHECK (expires_at > created_at)
);

CREATE INDEX admin_sessions_admin_user_idx
ON admin_sessions (admin_user_seq);

CREATE INDEX admin_sessions_expires_at_idx
ON admin_sessions (expires_at);