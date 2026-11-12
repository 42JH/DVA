CREATE TABLE voice_clones (
  user_id text PRIMARY KEY REFERENCES users (id),
  provider_voice_id text UNIQUE,
  status text NOT NULL CHECK (status IN ('CREATING', 'VERIFICATION_REQUIRED', 'READY')),
  consented_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'CREATING') = (provider_voice_id IS NULL))
);
