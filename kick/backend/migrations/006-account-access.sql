ALTER TABLE users ADD COLUMN access_token_digest bytea UNIQUE;

CREATE TABLE push_devices (
  token text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX push_devices_user_idx ON push_devices (user_id, updated_at DESC);
