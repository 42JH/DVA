CREATE TABLE users (
  id text PRIMARY KEY,
  display_name text NOT NULL
);

CREATE TABLE friendships (
  user_id text NOT NULL REFERENCES users (id),
  friend_id text NOT NULL REFERENCES users (id),
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  caller_id text NOT NULL REFERENCES users (id),
  callee_id text NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (caller_id, request_id),
  CHECK (caller_id <> callee_id)
);

INSERT INTO users (id, display_name)
VALUES ('kick-test-1', '테스트 계정 1'), ('kick-test-2', '테스트 계정 2');

INSERT INTO friendships (user_id, friend_id)
VALUES ('kick-test-1', 'kick-test-2'), ('kick-test-2', 'kick-test-1');
